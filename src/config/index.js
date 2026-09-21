'use strict';

const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Daftar angka dipisah koma (mis. "50,200,800"). Nilai kosong/tidak valid
// (bukan angka, atau negatif) -> pakai fallback utuh, bukan sebagian, supaya
// salah ketik di .env tidak menghasilkan jeda retry yang aneh.
function toIntList(value, fallback) {
  if (!value || !value.trim()) return fallback;
  const parts = value.split(',').map((s) => s.trim());
  const nums = parts.map((s) => (/^\d+$/.test(s) ? parseInt(s, 10) : NaN));
  return nums.every(Number.isFinite) ? nums : fallback;
}

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: toInt(process.env.PORT, 3000),

  authFolder: path.resolve(process.cwd(), process.env.AUTH_FOLDER || './auth'),

  logLevel: process.env.LOG_LEVEL || 'info',
  logFolder: process.env.LOG_FOLDER
    ? path.resolve(process.cwd(), process.env.LOG_FOLDER)
    : null,

  maxMessagesInMemory: toInt(process.env.MAX_MESSAGES_IN_MEMORY, 200),

  reconnect: {
    initialDelayMs: toInt(process.env.RECONNECT_INITIAL_DELAY_MS, 2000),
    maxDelayMs: toInt(process.env.RECONNECT_MAX_DELAY_MS, 60000),
    backoffFactor: parseFloat(process.env.RECONNECT_BACKOFF_FACTOR || '2') || 2,
  },

  // =============================================================
  // Phase 2: integrasi ke AuliaPos CI4 (Shared WhatsApp Inbox)
  // =============================================================
  ci4: {
    // Base URL AuliaPos CI4, TANPA trailing slash. Contoh:
    // http://192.168.1.10/aulia
    //
    // Kalau operator lupa tulis skema (http://) -- kesalahan input yang
    // ternyata gampang terjadi, terutama di layar Setup app Android --
    // fetch() akan gagal keras dengan pesan "Failed to parse URL",
    // sehingga heartbeat/delivery ke CI4 gagal TERUS tanpa penjelasan
    // yang jelas di dashboard. Daripada gagal total, tambahkan http://
    // secara defensif kalau skemanya belum ada.
    baseUrl: (() => {
      const raw = (process.env.CI4_BASE_URL || '').trim().replace(/\/+$/, '');
      if (!raw) return '';
      return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    })(),

    // Shared secret -- HARUS SAMA PERSIS dengan app/Config/Inbox.php
    // (env inbox.gatewayToken) di sisi CI4. Dikirim sebagai
    // "Authorization: Bearer <token>" di setiap request ke CI4.
    gatewayToken: process.env.CI4_GATEWAY_TOKEN || '',

    // Timeout per request HTTP ke CI4 (ms).
    requestTimeoutMs: toInt(process.env.CI4_REQUEST_TIMEOUT_MS, 8000),
  },

  // Path file database SQLite (reliability buffer untuk incoming
  // message). Ini BUKAN source of truth -- cuma buffer retry supaya
  // pesan tidak hilang kalau CI4 sedang mati/tidak bisa dihubungi.
  sqlitePath: path.resolve(process.cwd(), process.env.SQLITE_PATH || './data/gateway.sqlite'),

  // Seberapa sering worker mencoba mengirim ulang event yang masih
  // pending di SQLite ke CI4 (ms).
  deliveryIntervalMs: toInt(process.env.DELIVERY_INTERVAL_MS, 5000),

  // Backoff untuk retry pengiriman SATU event yang gagal (pola sama
  // seperti reconnect di atas): delay makin lama tiap gagal
  // berturut-turut untuk event yang SAMA, supaya tidak spam CI4
  // yang sedang down.
  deliveryRetry: {
    initialDelayMs: toInt(process.env.DELIVERY_RETRY_INITIAL_DELAY_MS, 3000),
    maxDelayMs: toInt(process.env.DELIVERY_RETRY_MAX_DELAY_MS, 120000),
    backoffFactor: parseFloat(process.env.DELIVERY_RETRY_BACKOFF_FACTOR || '2') || 2,
  },

  // M1 Wave 1 TASK-005 (GUD-001): batas durable buffer.
  // - enqueueRetryDelaysMs: jeda antar percobaan ulang enqueue() ke buffer
  //   utama (REQ-009). Panjang daftar = jumlah percobaan ULANG; bawaan sama
  //   dengan DEFAULT_RETRY_DELAYS_MS di src/store/enqueueRetry.js.
  // - enqueueOverflowMax: kapasitas penampung sementara in-memory (REQ-010).
  enqueueRetryDelaysMs: toIntList(process.env.ENQUEUE_RETRY_DELAYS_MS, [50, 200, 800]),
  enqueueOverflowMax: Math.max(1, toInt(process.env.ENQUEUE_OVERFLOW_MAX, 500)), // min 1: 0 = buang semua event

  // Heartbeat status ke CI4 (POST /api/inbox/gateway/status).
  heartbeatIntervalMs: toInt(process.env.HEARTBEAT_INTERVAL_MS, 15000),

  // =============================================================
  // Kirim media (gambar/dokumen) KELUAR -- baik dari dashboard test
  // (/api/chats/:chatId/reply-media) maupun dari CI4 (/send-media).
  // File media di sini HANYA dipegang di memory selama proses kirim,
  // TIDAK PERNAH disimpan ke disk Gateway, konsisten dengan prinsip
  // yang sama dipakai untuk media MASUK (lihat downloadMediaByRef()).
  // =============================================================
  maxMediaUploadBytes: toInt(process.env.MAX_MEDIA_UPLOAD_MB, 20) * 1024 * 1024,

  // Timeout mengunduh media dari URL (khusus mediaUrl di dashboard test).
  mediaFetchTimeoutMs: toInt(process.env.MEDIA_FETCH_TIMEOUT_MS, 15000),

  // =============================================================
  // Override folder temp OS (os.tmpdir()) -- HANYA dipakai di build
  // Android (lihat src/whatsapp/baileysLoader.js). Baileys menulis file
  // sementara ke os.tmpdir() untuk generate thumbnail otomatis saat
  // kirim gambar/video/sticker KELUAR -- di Android, "/tmp" sistem
  // TIDAK ADA/tidak writable di sandbox proses app, dan mencoba benerin
  // ini lewat env var TMPDIR native (setenv() di native-lib.cpp) TERBUKTI
  // TIDAK CUKUP -- runtime Node di build nodejs-mobile yang dipakai
  // TIDAK menghormati TMPDIR untuk os.tmpdir() (diverifikasi lewat
  // testing sungguhan di HP: baris log "TMPDIR diset ke ..." muncul
  // benar, tapi Baileys tetap coba tulis ke "/tmp" literal). Solusinya:
  // override os.tmpdir() di level JavaScript secara langsung -- lihat
  // baileysLoader.js. Di desktop (Windows/dst), env var ini TIDAK diisi
  // sama sekali, jadi os.tmpdir() bawaan Node tetap dipakai apa adanya,
  // TIDAK ADA perubahan behavior sama sekali untuk desktop.
  appTmpDir: process.env.APP_TMP_DIR || null,
};

// Peringatan keras jika HOST dibuka ke LAN tanpa authentication.
config.isBoundToLan = config.host === '0.0.0.0' || config.host !== '127.0.0.1' && config.host !== 'localhost';

// Body request berisi media base64 selalu lebih besar ~33% dari file aslinya
// (overhead encoding base64), ditambah sedikit headroom untuk field JSON lain
// (chat_id, caption, dst) -- dipakai sebagai limit body-parser JSON khusus
// endpoint kirim media (bukan limit default 256kb yang dipakai endpoint lain).
config.mediaJsonBodyLimitBytes = Math.ceil(config.maxMediaUploadBytes * 4 / 3) + 8192;

module.exports = config;
