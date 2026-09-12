'use strict';

// Konfigurasi Supervisor. TERPISAH dari konfigurasi Gateway (src/config).
// Supervisor tidak menduplikasi seluruh .env Gateway -- hanya menambahkan
// beberapa variabel baru miliknya sendiri (SUPERVISOR_*), dan membaca
// konfigurasi Gateway yang sudah ada (host/port/token) langsung dari
// module src/config supaya tidak ada nilai ganda yang bisa saling
// tidak sinkron.
//
// PENTING: require('dotenv').config() di src/config sudah membaca file
// .env di cwd yang sama (repo root) -- variabel SUPERVISOR_* di bawah
// otomatis ikut ter-load dari file .env yang sama itu.

const path = require('path');
const gatewayConfig = require('../src/config');

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

const REPO_ROOT = path.resolve(__dirname, '..');

const config = {
  // Bind Control API -- default localhost, aman untuk penggunaan lokal.
  // Ubah SUPERVISOR_HOST=0.0.0.0 hanya jika Control Panel memang perlu
  // diakses dari komputer lain di LAN yang sama.
  host: process.env.SUPERVISOR_HOST || '127.0.0.1',
  port: toInt(process.env.SUPERVISOR_PORT, 4000),
  token: process.env.SUPERVISOR_TOKEN || '',

  // Working directory & entry point Gateway -- SAMA PERSIS dengan cara
  // Gateway dijalankan manual saat ini ("npm start" -> "node src/app/index.js"),
  // lihat package.json di repo root. Supervisor menjalankan node langsung
  // (bukan lewat npm) supaya PID yang didapat adalah PID Gateway itu sendiri,
  // bukan PID proses npm pembungkusnya.
  gateway: {
    cwd: REPO_ROOT,
    entry: path.join(REPO_ROOT, 'src', 'app', 'index.js'),
    // Gateway sendiri sudah baca .env via dotenv di dalam src/config -- child
    // process cukup diwariskan process.env apa adanya (cwd yang sama).
  },

  // Timeout tunggu graceful shutdown (IPC 'shutdown') sebelum fallback force-kill.
  gracefulStopTimeoutMs: toInt(process.env.SUPERVISOR_GRACEFUL_STOP_TIMEOUT_MS, 8000),

  // Referensi ke konfigurasi Gateway (read-only, TIDAK dimodifikasi/didup dari sini).
  gatewayUrl: `http://${gatewayConfig.host === '0.0.0.0' ? '127.0.0.1' : gatewayConfig.host}:${gatewayConfig.port}`,
  gatewayApiToken: gatewayConfig.ci4.gatewayToken,
};

module.exports = config;
