// Free Cloudflare "quick tunnel" in front of the phone server, so a phone can reach this
// computer from mobile data or any other network. No account: Cloudflare hands out a
// random https://….trycloudflare.com address that changes every time the tunnel starts.
// The phone still needs the pairing token, which travels in the QR code's #fragment
// (never sent to Cloudflare as part of a request path).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { ROOT } from './env.ts';

export const CLOUDFLARED_BIN = process.env.ACTA_CLOUDFLARED
  || path.join(ROOT, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

export type TunnelState = { status: 'off' | 'starting' | 'ready' | 'error'; url: string; error: string };

let child: ChildProcess | null = null;
let wanted = false;
let restartTimer: NodeJS.Timeout | null = null;
let failures = 0;
let state: TunnelState = { status: 'off', url: '', error: '' };
let onChange: (s: TunnelState) => void = () => {};

export const tunnelAvailable = () => fs.existsSync(CLOUDFLARED_BIN);
export const tunnelState = () => state;

function set(next: Partial<TunnelState>) {
  const prev = state;
  state = { ...state, ...next };
  if (prev.status !== state.status || prev.url !== state.url || prev.error !== state.error) onChange(state);
}

export function startTunnel(localPort: number, listener: (s: TunnelState) => void) {
  onChange = listener;
  wanted = true;
  if (child) return;
  if (!tunnelAvailable()) { set({ status: 'error', url: '', error: 'Falta cloudflared en esta instalación.' }); return; }
  set({ status: 'starting', url: '', error: '' });
  const args = [
    'tunnel', '--no-autoupdate',
    '--url', `https://127.0.0.1:${localPort}`,
    '--no-tls-verify', // the phone server's certificate is self-signed; this hop never leaves the computer
    '--loglevel', 'info',
  ];
  const c = spawn(CLOUDFLARED_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child = c;
  let buf = '';
  let url = '';
  const onData = (d: Buffer) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !url) url = m[0];
      if (url && /Registered tunnel connection/i.test(line)) { failures = 0; set({ status: 'ready', url, error: '' }); }
      if (/ERR .*(failed to request quick Tunnel|error=)/i.test(line) && state.status !== 'ready') {
        set({ status: 'starting', error: line.replace(/^.*?ERR\s*/, '').slice(0, 200) });
      }
    }
  };
  c.stdout!.on('data', onData);
  c.stderr!.on('data', onData);
  c.on('error', (e) => set({ status: 'error', error: String(e.message || e) }));
  c.on('exit', (code) => {
    if (child === c) child = null;
    if (!wanted) { set({ status: 'off', url: '', error: '' }); return; }
    failures++;
    const wait = Math.min(60_000, 3000 * failures);
    set({ status: 'error', url: '', error: state.error || `El túnel se cerró (código ${code}). Reintento en ${Math.round(wait / 1000)} s.` });
    restartTimer = setTimeout(() => { restartTimer = null; if (wanted) startTunnel(localPort, onChange); }, wait);
  });
}

export function stopTunnel() {
  wanted = false;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  const c = child;
  child = null;
  if (c) { try { c.kill(); } catch { /* gone */ } }
  set({ status: 'off', url: '', error: '' });
}
