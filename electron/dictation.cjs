// Dictation anywhere: a global shortcut starts listening, the same shortcut stops,
// Esc cancels. A small pill (that never takes the focus) records the mic; the server
// transcribes and tidies the text; we paste it into the app that had the focus and
// then put back whatever was on the clipboard.
const { BrowserWindow, globalShortcut, clipboard, screen, ipcMain } = require('electron');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

// Special shortcut value: Ctrl + Windows, read by acta-audio.exe's keyboard hook.
// Hold it to talk and let go to paste; a quick tap keeps listening until the next tap.
const CTRL_WIN = 'CtrlWin';
const TAP_MS = 400;

const PILL_W = 420;
const PILL_H = 110;

function createDictation({ baseUrl, helperBin, onState }) {
  let pill = null;
  let pillReady = null;
  let state = 'idle'; // idle | recording | busy
  let settings = { dictationEnabled: true, dictationShortcut: 'CommandOrControl+Shift+Space', dictationCleanup: true };
  let registered = '';
  let hideTimer = null;

  let hook = null;        // acta-audio.exe hotkey child
  let hookWanted = false;
  let pressAt = 0;
  let startedByPress = false;

  const label = (acc) => acc === CTRL_WIN ? 'Ctrl + Windows' : acc.replace('CommandOrControl', process.platform === 'darwin' ? '⌘' : 'Ctrl').replace('Space', 'Espacio').replace(/\+/g, '+');

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

  let starting = null;

  function start(hint) {
    if (state !== 'idle') return starting;
    clearTimeout(hideTimer);
    setState('recording');
    starting = (async () => {
      await ensurePill();
      place();
      pill.showInactive();
      escOn();
      // The pill queues a stop that arrives while the mic is still opening.
      send('start', { hint: hint || `${label(settings.dictationShortcut)} para pegar · Esc cancela` });
    })();
    return starting;
  }

  async function stop() {
    if (state !== 'recording') return;
    escOff();
    setState('busy');
    await starting;
    send('stop');
  }

  async function cancel() {
    if (state !== 'recording') return;
    escOff();
    setState('idle');
    await starting;
    send('cancel');
    setState('idle');
    message('Dictado cancelado', { ms: 700 });
  }

  function toggle() {
    if (state === 'idle') void start();
    else if (state === 'recording') void stop();
  }

  // Ctrl + Windows: hold to talk, or tap to start and tap again to finish.
  function onHotkey(ev) {
    if (ev === 'down') {
      if (state === 'idle') {
        pressAt = Date.now();
        startedByPress = true;
        void start('Suelta para pegar · toque corto: manos libres · Esc cancela');
      } else if (state === 'recording') {
        startedByPress = false;
        void stop();
      }
    } else if (ev === 'up') {
      if (state === 'recording' && startedByPress) {
        startedByPress = false;
        if (Date.now() - pressAt > TAP_MS) void stop();
        else send('hint', { hint: 'Manos libres · Ctrl + Windows para pegar · Esc cancela' });
      }
    } else if (ev === 'cancel') {
      // Ctrl+Win+<key> is a Windows shortcut: drop the dictation it accidentally started.
      if (state === 'recording' && startedByPress && Date.now() - pressAt < 1500) {
        startedByPress = false;
        escOff();
        setState('idle');
        void Promise.resolve(starting).then(() => {
          send('cancel');
          if (state === 'idle' && pill && !pill.isDestroyed()) pill.hide();
        });
      }
    }
  }

  function startHook() {
    hookWanted = true;
    if (hook || process.platform !== 'win32' || !fs.existsSync(helperBin)) return hook || fs.existsSync(helperBin);
    hook = spawn(helperBin, ['hotkey'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    hook.stdout.setEncoding('utf8');
    hook.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        try { const j = JSON.parse(line); if (j.hotkey) onHotkey(j.hotkey); } catch { /* not ours */ }
      }
    });
    hook.stderr.on('data', (d) => console.warn('[dictado] hotkey', String(d).trim()));
    hook.on('exit', () => {
      hook = null;
      if (hookWanted) setTimeout(() => { if (hookWanted) startHook(); }, 2000);
    });
    return true;
  }

  function stopHook() {
    hookWanted = false;
    if (hook) { try { hook.kill(); } catch { /* gone */ } hook = null; }
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
      message(String(err?.message || err).slice(0, 220), { error: true, ms: 7000 });
    }
  });

  ipcMain.on('dictation:failed', (_e, msg) => {
    escOff();
    setState('idle');
    message(msg, { error: true, ms: 4500 });
  });

  function apply(next) {
    settings = { ...settings, ...next };
    if (registered && registered !== CTRL_WIN) { try { globalShortcut.unregister(registered); } catch { /* gone */ } }
    registered = '';
    stopHook();
    if (!settings.dictationEnabled) { if (state === 'recording') cancel(); return { ok: true }; }
    const acc = settings.dictationShortcut || 'CommandOrControl+Shift+Space';
    if (acc === CTRL_WIN) {
      const ok = startHook();
      if (ok) registered = CTRL_WIN;
      else console.warn('[dictado] Ctrl + Windows necesita acta-audio.exe (solo Windows)');
      return { ok, shortcut: acc };
    }
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

  return { init, apply, toggle, dispose: stopHook, get state() { return state; }, get shortcut() { return registered && registered !== CTRL_WIN ? registered : ''; } };
}

module.exports = { createDictation };
