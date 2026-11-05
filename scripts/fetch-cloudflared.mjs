// Downloads Cloudflare's official cloudflared for Windows into bin/ and checks its SHA-256.
// Acta uses it for a free "quick tunnel": an https://….trycloudflare.com address that lets
// a phone reach this computer from any network (mobile data, another Wi-Fi).
//
//   node scripts/fetch-cloudflared.mjs [destination]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = '2026.10.7';
const SHA256 = '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343';
const URL_ = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-windows-amd64.exe`;

const dest = path.resolve(process.argv[2] || path.join('bin', 'cloudflared.exe'));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

if (fs.existsSync(dest) && sha(fs.readFileSync(dest)) === SHA256) {
  console.log(`cloudflared ${VERSION} ya está en ${dest}`);
  process.exit(0);
}
console.log(`Descargando cloudflared ${VERSION}…`);
const res = await fetch(URL_);
if (!res.ok) { console.error(`Descarga fallida: HTTP ${res.status}`); process.exit(1); }
const buf = Buffer.from(await res.arrayBuffer());
const got = sha(buf);
if (got !== SHA256) { console.error(`La suma SHA-256 no coincide (${got}). No lo instalo.`); process.exit(1); }
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, buf);
console.log(`cloudflared ${VERSION} verificado en ${dest}`);
