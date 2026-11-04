// Dictation anywhere: a global shortcut starts listening, the same shortcut stops,
// Esc cancels. A small pill (that never takes the focus) records the mic; the server
// transcribes and tidies the text; we paste it into the app that had the focus and
// then put back whatever was on the clipboard.
const { BrowserWindow, globalShortcut, clipboard, screen, ipcMain } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PILL_W = 360;
const PILL_H = 64;

function createDictation({ baseUrl, helperBin, onState }) {
  let pill = null;
  let pillReady = null;
  let state = 'idle'; // idle | recording | busy
  let settings = { dictationEnabled: true, dictationShortcut: 'CommandOrControl+Shift+Space', dictationCleanup: true };
  let registered = '';
  let hideTimer = null;

  const label = (acc) => acc.replace('CommandOrControl', process.platform === 'darwin' ? '⌘' : 'Ctrl').replace('Space', 'Espacio').replace(/\+/g, '+');

  function ensurePill() {
    if (pill && !pill.isDestroyed()) return pillReady;
    pill = new BrowserWindow({
      width: PILL_W, height: PILL_H, show: false, frame: false, transparent: true, resizable: false, movable: false,
      focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, fullscreenable: false,
      webPreferences: { preload: path.join(__dirname, 'dictation-preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    pill.setAlwaysOnTop(true, 'screen-saver');
    pill.setIgnoreMouseEvents(true);
    pillReady = new Promise((resolve) => ipcMain.once('dictation:ready', () => resolve()));
    pill.loadFile(path.join(__dirname, 'dictation.html'));
    pill.on('closed', () => { pill = null; pillReady = null; });
    return pillReady;
  }

  function place() {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = d.workArea;
    pill.setBounds({ x: Math.round(x + (width - PILL_W) / 2), y: Math.round(y + height - PILL_H - 28), width: PILL_W, height: PILL_H });
  }

  function send(cmd, data) { if (pill && !pill.isDestroyed()) pill.webContents.send('dictation:command', cmd, data); }

  function setState(s) { state = s; onState?.(s); }

  function hideSoon(ms) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (state === 'idle' && pill && !pill.isDestroyed()) pill.hide(); }, ms);
  }

  function message(text, { error = false, hint = '', ms = 1400 } = {}) {
    send('message', { text, error, hint });
    hideSoon(ms);
  }

  function escOn() { try { globalShortcut.register('Escape', cancel); } catch { /* taken */ } }
  function escOff() { try { globalShortcut.unregister('Escape'); } catch { /* not ours */ } }

  async function start() {
    if (state !== 'idle') return;
    clearTimeout(hideTimer);
    await ensurePill();
    place();
    pill.showInactive();
    setState('recording');
    escOn();
    send('start', { hint: `${label(settings.dictationShortcut)} para pegar · Esc cancela` });
  }

  function stop() {
    if (state !== 'recording') return;
    escOff();
    setState('busy');
    send('stop');
  }

  function cancel() {
    if (state !== 'recording') return;
    escOff();
    send('cancel');
    setState('idle');
    message('Dictado cancelado', { ms: 700 });
  }

  function toggle() {
    if (state === 'idle') void start();
    else if (state === 'recording') stop();
  }

  function postPcm(buf) {
    return new Promise((resolve, reject) => {
      const body = Buffer.from(buf);
      const req = http.request(`${baseUrl}/api/dictate`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length } }, (res) => {
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(d); } catch { /* not json */ }
          if (res.statusCode >= 400 || !j) reject(new Error(j?.error || `Error ${res.statusCode}`));
          else resolve(j);
        });
      });
      req.on('error', reject);
      req.setTimeout(120000, () => req.destroy(new Error('La transcripción tardó demasiado')));
      req.end(body);
    });
  }

  function saveClipboard() {
    const saved = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: null };
    const img = clipboard.readImage();
    if (!img.isEmpty()) saved.image = img;
    return saved;
  }

  function restoreClipboard(saved, ours) {
    // Only if nobody copied something else in the meantime.
    if (clipboard.readText() !== ours) return;
    const data = {};
    if (saved.text) data.text = saved.text;
    if (saved.html) data.html = saved.html;
    if (saved.rtf) data.rtf = saved.rtf;
    if (saved.image) data.image = saved.image;
    if (Object.keys(data).length) clipboard.write(data); else clipboard.clear();
  }

  function sendPasteKeys() {
    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        if (!fs.existsSync(helperBin)) { resolve(false); return; }
        execFile(helperBin, ['paste'], { windowsHide: true, timeout: 4000 }, (err) => resolve(!err));
      } else if (process.platform === 'darwin') {
        execFile('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'], { timeout: 4000 }, (err) => resolve(!err));
      } else {
        resolve(false);
      }
    });
  }

  ipcMain.on('dictation:audio', async (_e, buf) => {
    send('busy', { text: 'Transcribiendo…' });
    try {
      const r = await postPcm(buf);
      const text = String(r.text || '').trim();
      setState('idle');
      if (!text) { message('No he oído nada', { ms: 1200 }); return; }
      const saved = saveClipboard();
      clipboard.writeText(text);
      const ok = await sendPasteKeys();
      if (!ok) { message('Texto copiado', { hint: 'Pégalo con Ctrl+V', ms: 2500 }); return; }
      message('Pegado', { hint: r.cleaned ? 'texto repasado' : '', ms: 700 });
      setTimeout(() => restoreClipboard(saved, text), 800);
    } catch (err) {
      setState('idle');
      message(String(err?.message || err).slice(0, 90), { error: true, ms: 4500 });
    }
  });

  ipcMain.on('dictation:failed', (_e, msg) => {
    escOff();
    setState('idle');
    message(msg, { error: true, ms: 4500 });
  });

  function apply(next) {
    settings = { ...settings, ...next };
    if (registered) { try { globalShortcut.unregister(registered); } catch { /* gone */ } registered = ''; }
    if (!settings.dictationEnabled) { if (state === 'recording') cancel(); return { ok: true }; }
    const acc = settings.dictationShortcut || 'CommandOrControl+Shift+Space';
    let ok = false;
    try { ok = globalShortcut.register(acc, toggle); } catch { ok = false; }
    if (ok) registered = acc;
    else console.warn(`[dictado] no puedo registrar el atajo ${acc}: lo usa otra app`);
    return { ok, shortcut: acc };
  }

  async function init() {
    const s = await new Promise((resolve) => {
      http.get(`${baseUrl}/api/dictation`, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
      }).on('error', () => resolve({}));
    });
    const r = apply(s);
    void ensurePill();
    return r;
  }

  return { init, apply, toggle, get state() { return state; }, get shortcut() { return registered; } };
}

module.exports = { createDictation };
