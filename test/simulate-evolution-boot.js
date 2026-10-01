'use strict';
/**
 * Smoke BOOT untuk entry point adapter Evolution (src/app/evolution.js).
 * Tujuan: menangkap error require/path yang TIDAK terlihat oleh test router
 * (pelajaran dari spike/fonnte: path modul yang salah hanya muncul saat
 * entry point benar-benar dijalankan).
 *
 * Menjalankan entry di child process dengan SQLite temp + CI4/Evolution
 * dikosongkan, menunggu baris "berjalan di", lalu mematikannya.
 *
 * Jalankan: node test/simulate-evolution-boot.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-boot-'));
const READY = /berjalan di/;
const CHILD_TIMEOUT_MS = 8000;

const child = spawn(process.execPath, ['src/app/evolution.js'], {
  cwd: path.resolve(__dirname, '..'),
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: '3218',
    SQLITE_PATH: path.join(tmp, 'gateway.sqlite'),
    MEDIA_STORE_DIR: path.join(tmp, 'media'),
    CI4_BASE_URL: '',
    CI4_GATEWAY_TOKEN: '',
    EVOLUTION_API_KEY: '',
    EVOLUTION_INSTANCE: '',
    LOG_LEVEL: 'info',
    LOG_FOLDER: '',
  },
});

let out = '';
let finished = false;

function finish(code, message) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  try { child.kill(); } catch (err) { /* sudah mati */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (err) { /* */ }
  if (message) console.log(message);
  process.exit(code);
}

const timer = setTimeout(() => {
  console.error('GAGAL: entry point tidak boot dalam', CHILD_TIMEOUT_MS, 'ms. Output:\n', out);
  finish(1);
}, CHILD_TIMEOUT_MS);

child.stdout.on('data', (d) => {
  out += d.toString();
  if (READY.test(out)) finish(0, 'OK: entry point boot (server berjalan).');
});
child.stderr.on('data', (d) => { out += d.toString(); });
child.on('exit', (code) => {
  if (!READY.test(out)) {
    console.error('GAGAL: proses keluar sebelum siap (code', code, '). Output:\n', out);
    finish(1);
  }
});
