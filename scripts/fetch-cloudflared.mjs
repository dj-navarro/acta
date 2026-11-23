// Downloads Cloudflare's official cloudflared into bin/ and checks its SHA-256.
// Acta uses it for a free "quick tunnel": an https://….trycloudflare.com address that lets
// a phone reach this computer from any network (mobile data, another Wi-Fi).
//
//   node scripts/fetch-cloudflared.mjs [destination] [target]
//   target: win-x64 (default), darwin-arm64 or darwin-x64
// The macOS builds come as .tgz with a single `cloudflared` binary inside; it is extracted with tar.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = '2026.10.7';
// sha: digest of the downloaded asset (GitHub release API). binSha: the release notes' sum, which for the
// macOS .tgz is the sum of the binary inside (checked after extracting).
const TARGETS = {
  'win-x64': { file: 'cloudflared-windows-amd64.exe', sha: '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343', bin: 'cloudflared.exe' },
  'darwin-arm64': { file: 'cloudflared-darwin-arm64.tgz', sha: '3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd', binSha: '2136431d5eb467bf447d2ee514b713e192719b143aec1d9e09bf7dc290d5bb12', bin: 'cloudflared', tgz: true },
  'darwin-x64': { file: 'cloudflared-darwin-amd64.tgz', sha: '02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848', binSha: '5c55e77da7012cebca19170357e196176c48c9647cc2ead404702fa125ddbd86', bin: 'cloudflared', tgz: true },
};

const target = process.argv[3] || 'win-x64';
const t = TARGETS[target];
if (!t) { console.error(`Destino desconocido: ${target} (usa ${Object.keys(TARGETS).join(', ')})`); process.exit(1); }
const dest = path.resolve(process.argv[2] || path.join('bin', t.bin));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const stamp = `${dest}.version`;   // for the .tgz targets the sum is of the archive, so remember what was extracted

if (fs.existsSync(dest) && (t.tgz ? fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === `${VERSION} ${t.sha}` : sha(fs.readFileSync(dest)) === t.sha)) {
  console.log(`cloudflared ${VERSION} (${target}) ya está en ${dest}`);
  process.exit(0);
}
console.log(`Descargando cloudflared ${VERSION} (${target})…`);
const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${t.file}`);
if (!res.ok) { console.error(`Descarga fallida: HTTP ${res.status}`); process.exit(1); }
const buf = Buffer.from(await res.arrayBuffer());
const got = sha(buf);
if (got !== t.sha) { console.error(`La suma SHA-256 no coincide (${got}). No lo instalo.`); process.exit(1); }
fs.mkdirSync(path.dirname(dest), { recursive: true });
if (t.tgz) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudflared-'));
  fs.writeFileSync(path.join(tmp, t.file), buf);
  execFileSync('tar', ['-xzf', t.file], { cwd: tmp });
  const binGot = sha(fs.readFileSync(path.join(tmp, 'cloudflared')));
  if (t.binSha && binGot !== t.binSha) { console.error(`El binario extraído no coincide con la suma publicada (${binGot}). No lo instalo.`); process.exit(1); }
  fs.copyFileSync(path.join(tmp, 'cloudflared'), dest);
  fs.chmodSync(dest, 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.writeFileSync(stamp, `${VERSION} ${t.sha}`);
} else {
  fs.writeFileSync(dest, buf);
}
console.log(`cloudflared ${VERSION} (${target}) verificado en ${dest}`);
