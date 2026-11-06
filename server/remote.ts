// Phones and tablets as microphones. A second server listens on the local network over
// HTTPS (browsers only open the mic on secure pages), serves a small page, and takes
// 16 kHz PCM over a WebSocket — or, where a firewall blocks WebSockets (clinics, hotels),
// over plain HTTP requests: long polling for messages, POSTs for audio. Each device is its
// own channel in the recording, named after it ("Móvil", "Tablet"). Pairing is a QR code
// that carries a secret token.
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { generate as generateCert } from 'selfsigned';
import { WebSocketServer, type WebSocket } from 'ws';
import { DATA_DIR } from './env.ts';
import { get, getSetting, setSetting } from './db.ts';
import { activeSession, bus, startRecording, stopRecording } from './recorder.ts';
import { MOBILE_HTML } from './mobile.ts';
import { startTunnel, stopTunnel, tunnelAvailable, tunnelState, type TunnelState } from './tunnel.ts';

export const REMOTE_DEFAULT_PORT = 47332;
const CERT_FILE = path.join(DATA_DIR, 'remote-cert.json');
/** The current QR code and link, kept up to date so they can be sent to the phone (Telegram, chat…). */
export const QR_FILE = path.join(DATA_DIR, 'movil-qr.png');
export const LINK_FILE = path.join(DATA_DIR, 'movil-enlace.txt');
const TUNNEL = 'internet';

type Device = {
  id: string;
  label: string;
  ip: string;
  /** Set for WebSocket devices; HTTP (fallback) devices use queue/waiter instead. */
  ws: WebSocket | null;
  queue: unknown[];
  waiter: ServerResponse | null;
  waitTimer: NodeJS.Timeout | null;
  lastSeen: number;
  streaming: boolean;
  /** The recording this device started, so it can end it. */
  started: string | null;
  connectedAt: number;
  alive: boolean;
};

type Options = { createNote: (title: string) => string };

let opts: Options | null = null;
let server: https.Server | null = null;
let wss: WebSocketServer | null = null;
let ping: NodeJS.Timeout | null = null;
let lastError = '';
let certIps: string[] = [];
const devices = new Map<string, Device>();

// ---------- settings ----------
export function remoteSettings() {
  return {
    enabled: getSetting('remoteEnabled', false),
    port: getSetting('remotePort', REMOTE_DEFAULT_PORT),
    tunnel: getSetting('remoteTunnel', false),
  };
}

function token() {
  let t = getSetting<string>('remoteToken', '');
  if (!t) {
    t = crypto.randomBytes(18).toString('base64url');
    setSetting('remoteToken', t);
  }
  return t;
}

function tokenOk(given: string) {
  const a = Buffer.from(given || '');
  const b = Buffer.from(token());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- addresses and certificate ----------
const SKIP_IFACE = /vethernet|virtualbox|vmware|hyper-v|wsl|loopback|proton|wireguard|wintun|tap-|openvpn|zerotier|docker|bluetooth/i;

/** Local network addresses a phone on the same Wi-Fi can reach, best first. */
export function lanAddresses() {
  const out: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (SKIP_IFACE.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ name, address: a.address });
    }
  }
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : ip.startsWith('100.') ? 4 : 3);
  return out.sort((x, y) => rank(x.address) - rank(y.address));
}

async function certificate(ips: string[]) {
  try {
    const saved = JSON.parse(fs.readFileSync(CERT_FILE, 'utf8'));
    const fresh = new Date(saved.notAfter).getTime() - Date.now() > 14 * 864e5;
    if (fresh && ips.every((ip) => saved.ips.includes(ip))) return saved as { key: string; cert: string; ips: string[] };
  } catch { /* none yet */ }
  const notAfter = new Date(Date.now() + 397 * 864e5);
  const host = os.hostname();
  const pems = await generateCert([{ name: 'commonName', value: `Acta en ${host}` }, { name: 'organizationName', value: 'Acta' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: host }, { type: 2, value: 'localhost' }, ...ips.map((ip) => ({ type: 7, ip }))] },
    ],
  } as any);
  const saved = { key: pems.private, cert: pems.cert, ips, notAfter: notAfter.toISOString() };
  fs.writeFileSync(CERT_FILE, JSON.stringify(saved), { mode: 0o600 });
  return saved;
}

// ---------- devices ----------
function deviceList() {
  return [...devices.values()].map((d) => ({ id: d.id, label: d.label, ip: d.ip, streaming: d.streaming, connectedAt: d.connectedAt, mode: d.ws ? 'ws' : 'http' }));
}

function announce() {
  bus.emit('event', { type: 'remote.devices', devices: deviceList() });
}

function uniqueLabel(wanted: string, id: string) {
  let base = wanted.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24) || 'Móvil';
  if (/^(me|them)$/i.test(base)) base = 'Móvil';
  const taken = new Set([...devices.values()].filter((d) => d.id !== id).map((d) => d.label));
  let label = base;
  for (let i = 2; taken.has(label); i++) label = `${base} ${i}`;
  return label;
}

function recordingState() {
  const s = activeSession();
  if (!s) return null;
  const m = get('SELECT title FROM meetings WHERE id = ?', s.meetingId);
  return { meetingId: s.meetingId, title: m?.title || 'Sin título', elapsedMs: s.elapsedMs(), paused: s.paused };
}

function send(d: Device, msg: unknown) {
  if (d.ws) { if (d.ws.readyState === 1) d.ws.send(JSON.stringify(msg)); return; }
  d.queue.push(msg);
  if (d.queue.length > 500) d.queue.splice(0, d.queue.length - 500);
  flushPoll(d);
}

/** Answers the pending long poll of an HTTP device with whatever is queued. */
function flushPoll(d: Device, force = false) {
  const res = d.waiter;
  if (!res || (!d.queue.length && !force)) return;
  d.waiter = null;
  if (d.waitTimer) clearTimeout(d.waitTimer);
  d.waitTimer = null;
  json(res, 200, { messages: d.queue.splice(0) });
}

/** Disconnects a device for good (code 4401 = new pairing code, the phone must scan again). */
function dropDevice(d: Device, code: number, reason = '') {
  leave(d);
  if (d.ws) { try { d.ws.close(code, reason); } catch { /* gone */ } return; }
  devices.delete(d.id);
  if (d.waitTimer) clearTimeout(d.waitTimer);
  if (d.waiter) { json(d.waiter, code === 4401 ? 401 : 410, { error: reason || 'desconectado' }); d.waiter = null; }
}

function sendState(d: Device) {
  send(d, { type: 'state', recording: recordingState(), streaming: d.streaming, started: !!d.started && d.started === activeSession()?.meetingId });
}

function broadcastState() {
  for (const d of devices.values()) sendState(d);
}

function leave(d: Device) {
  if (!d.streaming) return;
  d.streaming = false;
  activeSession()?.vads[d.label]?.flush();
}

async function onCommand(d: Device, msg: any) {
  switch (msg?.type) {
    case 'start': {
      let s = activeSession();
      if (!s) {
        if (!opts) throw new Error('Acta no está lista');
        const title = String(msg.title || '').trim().slice(0, 200) || `Grabación desde ${d.label}`;
        const id = opts.createNote(title);
        // 'browser' keeps the Mac capturer off: the audio comes from this device.
        s = await startRecording(id, { sources: ['browser'] });
        d.started = id;
      }
      d.streaming = true;
      bus.emit('event', { type: 'remote.joined', label: d.label, meetingId: s.meetingId });
      break;
    }
    case 'join':
      if (activeSession()) {
        d.streaming = true;
        bus.emit('event', { type: 'remote.joined', label: d.label, meetingId: activeSession()!.meetingId });
      }
      break;
    case 'leave':
      leave(d);
      break;
    case 'stop':
      leave(d);
      await stopRecording('remote');
      break;
    case 'rename':
      leave(d);
      d.label = uniqueLabel(String(msg.name || ''), d.id);
      send(d, { type: 'hello', label: d.label, computer: os.hostname() });
      break;
    default:
      return;
  }
  announce();
  sendState(d);
}

function newDevice(id: string, name: string, ip: string, ws: WebSocket | null): Device {
  const prev = devices.get(id);
  if (prev) {
    if (prev.ws) { try { prev.ws.terminate(); } catch { /* gone */ } }
    if (prev.waitTimer) clearTimeout(prev.waitTimer);
    if (prev.waiter) { json(prev.waiter, 200, { messages: [] }); prev.waiter = null; }
  }
  const d: Device = {
    id,
    label: prev?.label || uniqueLabel(name, id),
    ip,
    ws,
    queue: [],
    waiter: null,
    waitTimer: null,
    lastSeen: Date.now(),
    streaming: false,
    started: prev?.started || null,
    connectedAt: Date.now(),
    alive: true,
  };
  devices.set(id, d);
  return d;
}

function onConnection(ws: WebSocket, url: URL, ip: string) {
  const id = (url.searchParams.get('id') || crypto.randomUUID()).slice(0, 64);
  const d = newDevice(id, url.searchParams.get('name') || '', ip, ws);
  ws.on('pong', () => { d.alive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      pushPcm(d, data as Buffer);
      return;
    }
    let msg: any;
    try { msg = JSON.parse(String(data)); } catch { return; }
    onCommand(d, msg).catch((e) => send(d, { type: 'error', message: String(e?.message || e) }));
  });
  ws.on('close', () => {
    if (devices.get(id)?.ws !== ws) return; // replaced by a reconnection
    leave(d);
    devices.delete(id);
    announce();
  });
  send(d, { type: 'hello', label: d.label, computer: os.hostname() });
  sendState(d);
  announce();
}

function pushPcm(d: Device, buf: Buffer) {
  const s = activeSession();
  if (!s || !d.streaming || buf.length < 2) return;
  s.pushAudio(d.label, new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.length & ~1))));
}

// ---------- HTTP fallback (no WebSocket) ----------
// GET  /poll   long poll: waits up to 20 s for messages; the first one registers the device
// POST /cmd    a command, JSON
// POST /audio  PCM s16le 16 kHz, one or more 100 ms blocks back to back
// The token goes in a header, not the address, so it stays out of proxy logs.
const POLL_MS = 20_000;
const HTTP_GONE_MS = 45_000;

function json(res: ServerResponse, status: number, body: unknown) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number) {
  return new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('demasiado grande')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

async function onHttp(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!tokenOk(String(req.headers['x-acta-token'] || ''))) return json(res, 401, { error: 'código no válido' });
  const id = (url.searchParams.get('id') || '').slice(0, 64);
  if (!id) return json(res, 400, { error: 'falta el id' });
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  let d = devices.get(id);

  if (url.pathname === '/poll' && req.method === 'GET') {
    // hello=1: the page has just (re)started its polling and needs the greeting and state again.
    if (!d || d.ws || url.searchParams.get('hello') === '1') {
      d = newDevice(id, url.searchParams.get('name') || '', ip, null);
      send(d, { type: 'hello', label: d.label, computer: os.hostname(), mode: 'http' });
      sendState(d);
      announce();
    }
    const dev = d;
    dev.lastSeen = Date.now();
    if (dev.waiter) flushPoll(dev, true); // an older poll from the same phone: release it
    dev.waiter = res;
    res.on('close', () => { if (dev.waiter === res) { dev.waiter = null; dev.lastSeen = Date.now(); } });
    if (dev.queue.length) flushPoll(dev);
    else dev.waitTimer = setTimeout(() => flushPoll(dev, true), POLL_MS);
    return;
  }
  // Commands and audio need a device that has polled first (it may have been dropped meanwhile).
  if (!d || d.ws) return json(res, 409, { error: 'sin sesión' });
  d.lastSeen = Date.now();
  if (url.pathname === '/cmd' && req.method === 'POST') {
    let msg: any;
    try { msg = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); } catch { return json(res, 400, { error: 'JSON no válido' }); }
    try { await onCommand(d, msg); } catch (e: any) { send(d, { type: 'error', message: String(e?.message || e) }); }
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/audio' && req.method === 'POST') {
    pushPcm(d, await readBody(req, 4 * 1024 * 1024));
    return json(res, 200, { ok: true, streaming: d.streaming });
  }
  json(res, 404, { error: 'no encontrado' });
}

// What the phones hear about: the recording's state and its transcript.
bus.on('event', (ev) => {
  if (!devices.size) return;
  switch (ev.type) {
    case 'recording.status':
      broadcastState();
      break;
    case 'recording.stopped':
      for (const d of devices.values()) { d.streaming = false; d.started = null; }
      broadcastState();
      announce();
      break;
    case 'transcript.segment':
      for (const d of devices.values()) send(d, { type: 'segment', segment: ev.segment });
      break;
    case 'recording.error':
      for (const d of devices.values()) if (d.streaming) send(d, { type: 'error', message: ev.message });
      break;
  }
});

// ---------- the link the phone opens ----------
function bestUrl() {
  const { port, tunnel } = remoteSettings();
  const t = token();
  const ts = tunnelState();
  if (tunnel && ts.status === 'ready' && ts.url) return `${ts.url}/#t=${t}`;
  const lan = lanAddresses()[0];
  return lan ? `https://${lan.address}:${port}/#t=${t}` : '';
}

/** Rewrites movil-qr.png and movil-enlace.txt with the address that works right now. */
async function writeLinkFiles() {
  // Also into an extra folder of the user's choice (e.g. one a Telegram bot is allowed to send from).
  const mirror = getSetting<string>('remoteQrMirror', '').trim();
  const dirs = [DATA_DIR, ...(mirror ? [mirror] : [])];
  const url = server ? bestUrl() : '';
  const away = url.includes('trycloudflare.com');
  const text = [
    url,
    '',
    away ? 'Funciona desde cualquier red. Cambia cada vez que Acta se reinicia.' : 'Solo funciona en la misma wifi que el ordenador.',
    `Actualizado: ${new Date().toLocaleString('es-ES')}`,
    '',
  ].join('\r\n');
  for (const dir of dirs) {
    const qr = path.join(dir, 'movil-qr.png');
    const link = path.join(dir, 'movil-enlace.txt');
    try {
      if (!url) { fs.rmSync(qr, { force: true }); fs.rmSync(link, { force: true }); continue; }
      fs.mkdirSync(dir, { recursive: true });
      await QRCode.toFile(qr, url, { type: 'png', width: 640, margin: 2, errorCorrectionLevel: 'M' });
      fs.writeFileSync(link, text, { mode: 0o600 });
    } catch (e: any) {
      console.warn('[móvil] no pude guardar el QR en', dir, e?.message || e);
    }
  }
}

function onTunnel(st: TunnelState) {
  bus.emit('event', { type: 'remote.tunnel', tunnel: st });
  if (st.status === 'ready') console.log(`[móvil] túnel listo: ${st.url}`);
  void writeLinkFiles();
}

export async function setQrMirror(dir: string) {
  setSetting('remoteQrMirror', String(dir || '').trim());
  await writeLinkFiles();
}

export async function setTunnel(on: boolean) {
  setSetting('remoteTunnel', on);
  if (on && server) startTunnel(remoteSettings().port, onTunnel);
  if (!on) stopTunnel();
  await writeLinkFiles();
}

// ---------- server ----------
export async function startRemote(o: Options) {
  opts = o;
  await stopRemote();
  const { enabled, port } = remoteSettings();
  if (!enabled) return;
  lastError = '';
  try {
    certIps = lanAddresses().map((a) => a.address);
    const { key, cert } = await certificate(certIps);
    const srv = https.createServer({ key, cert }, (req, res) => {
      const reqUrl = new URL(req.url || '/', 'https://acta');
      const p = reqUrl.pathname;
      if (p === '/poll' || p === '/cmd' || p === '/audio') {
        onHttp(req, res, reqUrl).catch((e) => json(res, 500, { error: String(e?.message || e) }));
        return;
      }
      if (req.method === 'GET' && (p === '/' || p === '/m' || p === '/index.html')) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(MOBILE_HTML);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No encontrado');
    });
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
    srv.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', 'https://acta');
      if (url.pathname !== '/ws' || !tokenOk(url.searchParams.get('t') || '')) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      sockets.handleUpgrade(req, socket, head, (ws) => onConnection(ws, url, ip));
    });
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, '0.0.0.0', () => { srv.off('error', reject); resolve(); });
    });
    srv.on('error', (e) => { lastError = String(e?.message || e); });
    server = srv;
    wss = sockets;
    ping = setInterval(() => {
      let gone = false;
      for (const d of [...devices.values()]) {
        if (!d.ws) {
          // HTTP devices: gone once they stop polling.
          if (!d.waiter && Date.now() - d.lastSeen > HTTP_GONE_MS) { leave(d); devices.delete(d.id); gone = true; }
          continue;
        }
        if (!d.alive) { d.ws.terminate(); continue; }
        d.alive = false;
        try { d.ws.ping(); } catch { /* closing */ }
      }
      if (gone) announce();
    }, 15_000);
    console.log(`[móvil] escuchando en https://0.0.0.0:${port}`);
    if (remoteSettings().tunnel) startTunnel(port, onTunnel);
    await writeLinkFiles();
  } catch (e: any) {
    lastError = e?.code === 'EADDRINUSE' ? `El puerto ${port} está ocupado por otra aplicación.` : String(e?.message || e);
    console.warn('[móvil]', lastError);
  }
}

export async function stopRemote() {
  stopTunnel();
  if (ping) clearInterval(ping);
  ping = null;
  for (const d of [...devices.values()]) dropDevice(d, 1001, 'Acta se ha cerrado');
  devices.clear();
  wss?.close();
  wss = null;
  const s = server;
  server = null;
  if (s) await new Promise<void>((r) => s.close(() => r()));
  announce();
  await writeLinkFiles();
}

/** Forget every paired device: they need to scan the new code. */
export async function rotateRemoteToken() {
  setSetting('remoteToken', crypto.randomBytes(18).toString('base64url'));
  void writeLinkFiles();
  for (const d of [...devices.values()]) dropDevice(d, 4401, 'nuevo código');
  announce();
}

export async function remoteInfo(preferred?: string) {
  const { enabled, port, tunnel } = remoteSettings();
  const addrs = lanAddresses();
  const ts = tunnelState();
  // A new Wi-Fi gives a new address the certificate does not cover yet.
  if (server && addrs.some((a) => !certIps.includes(a.address))) {
    // Swap the certificate in place: restarting would also give the tunnel a new address.
    certIps = addrs.map((x) => x.address);
    const { key, cert } = await certificate(certIps);
    server.setSecureContext({ key, cert });
    void writeLinkFiles();
  }
  const t = token();
  const urls = addrs.map((a) => ({ ...a, url: `https://${a.address}:${port}/#t=${t}` }));
  if (tunnel && ts.status === 'ready' && ts.url) urls.unshift({ name: 'desde cualquier red', address: TUNNEL, url: `${ts.url}/#t=${t}` });
  const chosen = urls.find((u) => u.address === preferred) || urls[0];
  const qr = enabled && chosen ? await QRCode.toString(chosen.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) : '';
  return {
    enabled,
    port,
    running: !!server,
    error: lastError,
    addresses: urls.map((u) => ({ name: u.name, address: u.address })),
    address: chosen?.address || '',
    url: enabled && chosen ? chosen.url : '',
    qr,
    devices: deviceList(),
    tunnel: { enabled: tunnel, available: tunnelAvailable(), ...ts },
    qrFile: server ? QR_FILE : '',
    qrMirror: getSetting<string>('remoteQrMirror', ''),
  };
}
