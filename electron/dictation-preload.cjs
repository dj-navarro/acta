// Bridge for the dictation pill: the main process starts/stops it; the pill sends back PCM.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dictation', {
  onCommand: (cb) => ipcRenderer.on('dictation:command', (_e, cmd, data) => cb(cmd, data)),
  audio: (buf) => ipcRenderer.send('dictation:audio', buf),
  failed: (message) => ipcRenderer.send('dictation:failed', message),
  ready: () => ipcRenderer.send('dictation:ready'),
});
