// The page a phone or tablet opens after scanning the QR code: it sends its microphone to
// Acta on the computer and shows the live transcript. Plain HTML and JS, no build step.
// (No backticks or dollar-brace sequences below: this whole page is one template string.)
export const MOBILE_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#fbfaf7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#161513" media="(prefers-color-scheme: dark)">
<meta name="robots" content="noindex">
<title>Acta · micrófono</title>
<style>
:root{--bg:#fbfaf7;--card:#f3f0ea;--ink:#1d1c1a;--ink3:#77736b;--line:#e4dfd5;--accent:#d4532d;--wash:#fbeee8;--ok:#2f8a52}
@media (prefers-color-scheme:dark){:root{--bg:#161513;--card:#201e1b;--ink:#f1eee8;--ink3:#9c978d;--line:#2f2c28;--accent:#ef6a43;--wash:#3a231b;--ok:#4fb877}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:540px;margin:0 auto;padding:calc(14px + env(safe-area-inset-top)) 16px calc(20px + env(safe-area-inset-bottom));min-height:100dvh;display:flex;flex-direction:column;gap:14px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px}
.brand{font-weight:700;font-size:19px;letter-spacing:-.01em}
.conn{font-size:13px;color:var(--ink3);display:flex;align-items:center;gap:6px;text-align:right}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ink3);flex:none}
.conn.ok .dot{background:var(--ok)}.conn.bad .dot{background:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px}
.muted{color:var(--ink3);font-size:14px}
.title{font-weight:600;font-size:17px;margin:2px 0 0}
.row{display:flex;align-items:center;gap:10px}
input{width:100%;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:11px 12px;outline:none}
input:focus{border-color:var(--accent)}
button{font:inherit;font-weight:600;border:0;border-radius:14px;padding:14px 16px;cursor:pointer;width:100%}
button:disabled{opacity:.5}
.primary{background:var(--accent);color:#fff}
.ghost{background:transparent;color:var(--ink);border:1px solid var(--line)}
.link{background:none;border:0;color:var(--accent);padding:0;width:auto;font-weight:500;font-size:14px}
.mic{position:relative;width:148px;height:148px;margin:6px auto 2px;display:grid;place-items:center}
.ring{position:absolute;inset:0;border-radius:50%;background:var(--wash);transform:scale(.72);transition:transform .08s linear}
.core{position:relative;width:96px;height:96px;border-radius:50%;background:var(--accent);display:grid;place-items:center;color:#fff}
.core svg{width:40px;height:40px}
.idle .core{background:var(--line);color:var(--ink3)}
.clock{text-align:center;font-variant-numeric:tabular-nums;font-size:28px;font-weight:600}
.stack{display:flex;flex-direction:column;gap:10px}
#log{display:flex;flex-direction:column;gap:8px;overflow-y:auto;max-height:46dvh;padding-right:2px}
.seg{background:var(--card);border-radius:14px;padding:8px 12px;font-size:15px}
.seg.mine{background:var(--wash)}
.seg b{display:block;font-size:11.5px;font-weight:600;color:var(--ink3);margin-bottom:1px}
.err{background:var(--wash);color:var(--ink);border-radius:12px;padding:10px 12px;font-size:14px}
.hide{display:none!important}
small{color:var(--ink3);font-size:12.5px;line-height:1.4}
</style>
</head>
<body>
<main>
  <header>
    <div class="brand">Acta</div>
    <div id="conn" class="conn"><span class="dot"></span><span id="connText">Conectando…</span></div>
  </header>

  <section id="unpaired" class="card stack hide">
    <div class="title">Empareja este dispositivo</div>
    <div class="muted">En el ordenador, abre Acta → Ajustes → Móvil y escanea el código QR con la cámara.</div>
  </section>

  <section id="panel" class="stack hide">
    <div class="card stack">
      <div class="row" style="justify-content:space-between">
        <div class="muted">Este dispositivo: <b id="label" style="color:var(--ink)">Móvil</b></div>
        <button id="rename" class="link">Cambiar</button>
      </div>
      <div id="status" class="muted"></div>
      <div id="titleRow"><input id="title" placeholder="Título de la nota (opcional)" maxlength="200" autocomplete="off"></div>
      <div id="micBox" class="mic idle"><div id="ring" class="ring"></div><div class="core"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v5"/></svg></div></div>
      <div id="clock" class="clock hide">0:00</div>
      <button id="go" class="primary">Grabar</button>
      <button id="leaveBtn" class="ghost hide">Dejar de enviar audio</button>
      <button id="stopBtn" class="ghost hide">Terminar la grabación</button>
      <div id="error" class="err hide"></div>
      <small id="tip" class="hide">Deja la pantalla encendida y Acta abierta en este navegador: si bloqueas el móvil, deja de enviar audio.</small>
    </div>
    <div id="log"></div>
  </section>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  // The QR code carries the pairing token in the #fragment: keep it, then clean the address bar.
  var frag = new URLSearchParams(location.hash.slice(1));
  if (frag.get('t')) { store.set('acta.token', frag.get('t')); history.replaceState(null, '', location.pathname); }
  var token = store.get('acta.token');
  var devId = store.get('acta.device');
  if (!devId) { devId = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('acta.device', devId); }
  var ua = navigator.userAgent;
  var guess = /iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) ? 'Tablet' : 'Móvil';
  var name = store.get('acta.name') || guess;

  var ws = null, label = name, rec = null, streaming = false, started = false, everStreamed = false;
  var ctx = null, stream = null, node = null, backlog = [], wake = null, clockBase = 0, clockAt = 0, retry = 0;

  function show(el, on) { el.classList.toggle('hide', !on); }
  function conn(text, cls) { $('connText').textContent = text; $('conn').className = 'conn ' + (cls || ''); }
  function error(msg) { $('error').textContent = msg || ''; show($('error'), !!msg); }

  if (!token) { show($('unpaired'), true); conn('Sin emparejar', 'bad'); return; }
  show($('panel'), true);

  // ---------- connection ----------
  function connect() {
    conn('Conectando…', '');
    var url = 'wss://' + location.host + '/ws?t=' + encodeURIComponent(token) + '&id=' + encodeURIComponent(devId) + '&name=' + encodeURIComponent(name);
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = function () { retry = 0; };
    ws.onmessage = function (m) {
      if (typeof m.data !== 'string') return;
      var msg; try { msg = JSON.parse(m.data); } catch (e) { return; }
      if (msg.type === 'hello') { label = msg.label; $('label').textContent = label; conn('Conectado a ' + msg.computer, 'ok'); }
      else if (msg.type === 'state') onState(msg);
      else if (msg.type === 'segment') addSegment(msg.segment);
      else if (msg.type === 'error') error(msg.message);
    };
    ws.onclose = function (e) {
      ws = null;
      if (e.code === 4401) { store.del('acta.token'); stopMic(); show($('panel'), false); show($('unpaired'), true); conn('Código caducado', 'bad'); return; }
      conn(streaming ? 'Reconectando… (guardo el audio)' : 'Sin conexión con el ordenador', 'bad');
      retry++;
      setTimeout(connect, Math.min(5000, 800 * retry));
    };
  }
  function cmd(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

  function onState(s) {
    rec = s.recording; started = s.started;
    if (streaming && !s.streaming) {
      if (rec) cmd({ type: 'join' }); // reconnected mid-recording: carry on
      else { stopMic(); streaming = false; error(''); $('status').textContent = 'La grabación ha terminado.'; }
    }
    if (s.streaming) flushBacklog();
    if (rec) { clockBase = rec.elapsedMs; clockAt = Date.now(); }
    render();
  }

  // ---------- ui ----------
  function render() {
    var live = !!rec;
    show($('titleRow'), !live && !streaming);
    show($('clock'), live);
    show($('tip'), streaming);
    show($('leaveBtn'), streaming && !started);
    show($('stopBtn'), live && (streaming || started));
    $('micBox').classList.toggle('idle', !streaming);
    var go = $('go');
    if (streaming) { show(go, false); }
    else {
      show(go, true);
      go.textContent = live ? 'Unirme con este micrófono' : 'Grabar';
    }
    if (streaming) $('status').innerHTML = '';
    if (live) {
      var t = document.createElement('div');
      t.className = 'title'; t.textContent = rec.title;
      $('status').textContent = streaming ? 'Enviando audio a la nota:' : 'En el ordenador se está grabando:';
      $('status').appendChild(t);
    } else if (!streaming && !$('status').textContent) {
      $('status').textContent = 'Graba una nota nueva en Acta con el micrófono de este dispositivo.';
    }
  }

  setInterval(function () {
    if (!rec || rec.paused) return;
    var s = Math.floor((clockBase + Date.now() - clockAt) / 1000);
    var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
    $('clock').textContent = (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (ss < 10 ? '0' : '') + ss;
  }, 500);

  function who(sp) {
    if (sp === label) return 'Este dispositivo';
    if (sp === 'me') return 'Ordenador';
    if (sp === 'them') return 'Llamada';
    return sp;
  }
  function addSegment(seg) {
    var log = $('log');
    var stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    var el = document.createElement('div');
    el.className = 'seg' + (seg.speaker === label ? ' mine' : '');
    var b = document.createElement('b'); b.textContent = who(seg.speaker);
    el.appendChild(b); el.appendChild(document.createTextNode(seg.text));
    log.appendChild(el);
    while (log.children.length > 200) log.removeChild(log.firstChild);
    if (stick) log.scrollTop = log.scrollHeight;
  }

  $('go').onclick = function () {
    error('');
    startMic().then(function () {
      streaming = true; everStreamed = true;
      $('status').textContent = '';
      cmd(rec ? { type: 'join' } : { type: 'start', title: $('title').value });
      $('title').value = '';
      render();
    }).catch(function (e) {
      error('No he podido abrir el micrófono: ' + (e && e.message || e) + '. Revisa el permiso del micrófono para esta página.');
    });
  };
  $('leaveBtn').onclick = function () { cmd({ type: 'leave' }); stopMic(); streaming = false; render(); };
  $('stopBtn').onclick = function () {
    if (!confirm('¿Terminar la grabación en el ordenador?')) return;
    cmd({ type: 'stop' }); stopMic(); streaming = false; render();
  };
  $('rename').onclick = function () {
    var n = prompt('Nombre de este dispositivo en la transcripción', label);
    if (!n) return;
    name = n.trim().slice(0, 24) || name; store.set('acta.name', name);
    if (streaming) { stopMic(); streaming = false; }
    cmd({ type: 'rename', name: name });
  };

  // ---------- microphone ----------
  // Downsample to 16 kHz mono 16-bit, averaging each window (a cheap low-pass), 100 ms per message.
  var WORKLET = [
    'class Down extends AudioWorkletProcessor {',
    '  constructor() { super(); this.ratio = sampleRate / 16000; this.acc = 0; this.n = 0; this.pos = 0; this.out = new Int16Array(1600); this.len = 0; }',
    '  process(inputs) {',
    '    var ch = inputs[0] && inputs[0][0]; if (!ch) return true;',
    '    for (var i = 0; i < ch.length; i++) {',
    '      this.acc += ch[i]; this.n++; this.pos += 1;',
    '      if (this.pos >= this.ratio) { this.pos -= this.ratio; var v = this.acc / this.n; this.acc = 0; this.n = 0;',
    '        this.out[this.len++] = Math.max(-1, Math.min(1, v)) * 32767;',
    '        if (this.len === 1600) { this.port.postMessage(this.out.slice(0)); this.len = 0; } }',
    '    }',
    '    return true;',
    '  }',
    '}',
    "registerProcessor('down-16k', Down);"
  ].join('\\n');

  function startMic() {
    if (stream) return Promise.resolve();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.reject(new Error('este navegador no permite usar el micrófono aquí'));
    var AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    var resumed = ctx.resume();
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
      .then(function (s) { stream = s; return resumed; })
      .then(function () { return ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))); })
      .then(function () {
        var src = ctx.createMediaStreamSource(stream);
        node = new AudioWorkletNode(ctx, 'down-16k');
        node.port.onmessage = function (e) { onPcm(e.data); };
        src.connect(node);
        keepAwake();
        stream.getAudioTracks()[0].onended = function () { if (streaming) error('El sistema ha cortado el micrófono. Pulsa de nuevo para seguir.'); stopMic(); streaming = false; cmd({ type: 'leave' }); render(); };
      })
      .catch(function (e) { stopMic(); throw e; });
  }

  function stopMic() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    if (node) { try { node.disconnect(); } catch (e) {} node = null; }
    if (ctx) { try { ctx.close(); } catch (e) {} ctx = null; }
    backlog = [];
    $('ring').style.transform = 'scale(.72)';
    if (wake) { try { wake.release(); } catch (e) {} wake = null; }
  }

  function onPcm(pcm) {
    var sum = 0;
    for (var i = 0; i < pcm.length; i += 4) sum += pcm[i] * pcm[i];
    var db = 20 * Math.log10(Math.sqrt(sum / (pcm.length / 4)) / 32768 + 1e-9);
    var level = Math.max(0, Math.min(1, (db + 55) / 45));
    $('ring').style.transform = 'scale(' + (0.72 + level * 0.28) + ')';
    if (!streaming) return;
    if (ws && ws.readyState === 1 && !backlog.length) ws.send(pcm.buffer);
    else { backlog.push(pcm); if (backlog.length > 900) backlog.shift(); } // keeps the last 90 s
  }

  function flushBacklog() {
    while (backlog.length && ws && ws.readyState === 1) ws.send(backlog.shift().buffer);
  }

  function keepAwake() {
    if (!('wakeLock' in navigator) || wake) return;
    navigator.wakeLock.request('screen').then(function (w) { wake = w; w.addEventListener('release', function () { wake = null; }); }).catch(function () {});
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { if (stream) keepAwake(); if (!ws) connect(); }
  });

  render();
  connect();
})();
</script>
</body>
</html>
`;
