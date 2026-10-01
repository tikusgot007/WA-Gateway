'use strict';

const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Daftar angka dipisah koma (mis. "50,200,800"). Nilai kosong/tidak valid
// -> pakai fallback utuh, bukan sebagian, supaya salah ketik di .env tidak
// menghasilkan jeda retry yang aneh.
function toIntList(value, fallback) {
  if (!value || !value.trim()) return fallback;
  const parts = value.split(',').map((s) => s.trim());
  const nums = parts.map((s) => (/^\d+$/.test(s) ? parseInt(s, 10) : NaN));
  return nums.every(Number.isFinite) ? nums : fallback;
}

// Base URL tanpa trailing slash; tambahkan http:// kalau operator lupa skema.
function normalizeBaseUrl(raw) {
  const trimmed = (raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: toInt(process.env.PORT, 3000),

  logLevel: process.env.LOG_LEVEL || 'info',
  logFolder: process.env.LOG_FOLDER
    ? path.resolve(process.cwd(), process.env.LOG_FOLDER)
    : null,

  // =============================================================
  // Kontrak ke AuliaPos CI4 (Shared WhatsApp Inbox) -- DIREUSE
  // identik dari WA-Gateway / spike-fonnte supaya AuliaPos tidak
  // perlu diubah.
  // =============================================================
  ci4: {
    // Base URL AuliaPos CI4, TANPA trailing slash. Contoh:
    // http://192.168.1.10/aulia-app
    baseUrl: normalizeBaseUrl(process.env.CI4_BASE_URL),

    // Shared secret -- HARUS SAMA PERSIS dengan app/Config/Inbox.php
    // (env inbox.gatewayToken) di sisi CI4. Dikirim sebagai
    // "Authorization: Bearer <token>" di setiap request ke CI4, dan
    // diwajibkan pada endpoint yang dipanggil CI4 (arah sebaliknya).
    gatewayToken: process.env.CI4_GATEWAY_TOKEN || '',

    requestTimeoutMs: toInt(process.env.CI4_REQUEST_TIMEOUT_MS, 8000),
  },

  // Path file database SQLite (reliability buffer + operasi kirim +
  // store kutipan). Ini BUKAN source of truth -- cuma buffer retry.
  sqlitePath: path.resolve(process.cwd(), process.env.SQLITE_PATH || './data/evolution-gateway.sqlite'),

  deliveryIntervalMs: toInt(process.env.DELIVERY_INTERVAL_MS, 5000),

  deliveryRetry: {
    initialDelayMs: toInt(process.env.DELIVERY_RETRY_INITIAL_DELAY_MS, 3000),
    maxDelayMs: toInt(process.env.DELIVERY_RETRY_MAX_DELAY_MS, 120000),
    backoffFactor: parseFloat(process.env.DELIVERY_RETRY_BACKOFF_FACTOR || '2') || 2,
  },

  enqueueRetryDelaysMs: toIntList(process.env.ENQUEUE_RETRY_DELAYS_MS, [50, 200, 800]),
  enqueueOverflowMax: Math.max(1, toInt(process.env.ENQUEUE_OVERFLOW_MAX, 500)),

  // Idempotensi kirim keluar + batas percobaan/dead-letter.
  outgoingMaxAttempts: Math.max(1, toInt(process.env.OUTGOING_MAX_ATTEMPTS, 5)),
  outgoingLeaseMs: Math.max(1, toInt(process.env.OUTGOING_LEASE_MS, 35000)),
  outgoingOperationTtlMs: Math.max(1, toInt(process.env.OUTGOING_OPERATION_TTL_MS, 86400000)),
  deliveryMaxAttempts: Math.max(1, toInt(process.env.DELIVERY_MAX_ATTEMPTS, 100)),
  deliveryDeadAfterMs: Math.max(0, toInt(process.env.DELIVERY_DEAD_AFTER_MS, 86400000)),
  deliveryDeadBurstThreshold: Math.max(1, toInt(process.env.DELIVERY_DEAD_BURST_THRESHOLD, 10)),

  heartbeatIntervalMs: toInt(process.env.HEARTBEAT_INTERVAL_MS, 15000),

  // Media KELUAR: file hanya dipegang di memory selama proses kirim,
  // TIDAK PERNAH disimpan ke disk.
  maxMediaUploadBytes: toInt(process.env.MAX_MEDIA_UPLOAD_MB, 20) * 1024 * 1024,
  mediaFetchTimeoutMs: toInt(process.env.MEDIA_FETCH_TIMEOUT_MS, 15000),

  // =============================================================
  // Adapter Evolution API -- lihat src/evolution/*. Sesi WhatsApp
  // dipegang SERVER Evolution (bukan proses ini); adapter hanya
  // menerima webhook & memanggil REST Evolution.
  // =============================================================
  evolution: {
    // Base URL Evolution API, TANPA trailing slash (bawaan Docker: 8080).
    baseUrl: normalizeBaseUrl(process.env.EVOLUTION_BASE_URL || 'http://127.0.0.1:8080'),

    // API key global (atau per-instance). Dikirim sebagai header `apikey`.
    // Kosong = adapter menolak kirim (EVOLUTION_NOT_CONFIGURED).
    apiKey: (process.env.EVOLUTION_API_KEY || '').trim(),

    // Nama instance Evolution (dipakai di path /{instanceName}).
    instance: (process.env.EVOLUTION_INSTANCE || '').trim(),

    // Timeout per request HTTP ke Evolution API (ms).
    requestTimeoutMs: toInt(process.env.EVOLUTION_REQUEST_TIMEOUT_MS, 15000),

    // Timeout khusus polling status koneksi (heartbeat). Jauh lebih pendek
    // dari requestTimeoutMs SENGAJA: polling ini berjalan di dalam siklus
    // heartbeat (bawaan 15 dtk) sementara CI4 menganggap gateway basi pada
    // 30 dtk -- polling yang lambat tidak boleh menunda irama heartbeat.
    statusPollTimeoutMs: toInt(process.env.EVOLUTION_STATUS_POLL_TIMEOUT_MS, 5000),

    // Path webhook yang didaftarkan ke Evolution (mount relatif server ini).
    // URL lengkap dihitung operator: http://<ip-pc-gateway>:<port><path>.
    webhookPath: (process.env.EVOLUTION_WEBHOOK_PATH || '/evolution/webhook').trim(),

    // Opsional: shared secret yang dikirim Evolution di header webhook
    // (diatur lewat `headers` pada POST /webhook/set). Kalau diisi,
    // request webhook tanpa header ini DITOLAK. Kosong = tanpa validasi
    // (webhook hanya boleh dijangkau dari LAN/localhost).
    webhookSecret: (process.env.EVOLUTION_WEBHOOK_SECRET || '').trim(),
    webhookSecretHeader: (process.env.EVOLUTION_WEBHOOK_SECRET_HEADER || 'x-adapter-webhook-secret').trim(),

    // Kalau status koneksi eksplisit (dari CONNECTION_UPDATE) tidak
    // diperbarui lebih lama dari ini, status dianggap 'disconnected'
    // supaya badge UI tidak "stuck connected".
    connectionStaleMs: toInt(process.env.EVOLUTION_CONNECTION_STALE_MS, 120000),
  },

  // Store kutipan (key + message pesan masuk) untuk membangun `quoted`
  // Evolution saat kasir membalas. TTL membatasi pertumbuhan baris.
  quotedStoreTtlMs: Math.max(1, toInt(process.env.QUOTED_STORE_TTL_MS, 7 * 24 * 3600 * 1000)),

  // Cache info grup (subject + pemetaan LID->nomor) supaya tiap pesan grup
  // tidak memanggil Evolution berulang. Default 10 menit.
  groupInfoCacheTtlMs: Math.max(1000, toInt(process.env.GROUP_INFO_CACHE_TTL_MS, 10 * 60 * 1000)),

  // Media MASUK (Tahap 4). Mode 'base64' = Evolution mengirim base64 di
  // webhook dan adapter menyimpannya lokal; 'url' = simpan URL Evolution.
  mediaMode: (process.env.EVOLUTION_MEDIA_MODE || 'base64').trim().toLowerCase(),
  mediaStoreDir: path.resolve(process.cwd(), process.env.MEDIA_STORE_DIR || './data/media'),
  mediaRetentionDays: Math.max(1, toInt(process.env.MEDIA_RETENTION_DAYS, 7)),

  // Batas ukuran media MASUK. Berkas di atas ini tidak diunduh/disimpan --
  // adapter mengirim baris penanda teks supaya pesannya tidak hilang tanpa
  // jejak (dulu: badan webhook > batas -> 413 -> hilang senyap).
  maxIncomingMediaBytes: Math.max(1, toInt(process.env.EVOLUTION_MAX_INCOMING_MEDIA_MB, 64)) * 1024 * 1024,

  // Batas badan JSON webhook masuk. HARUS lebih besar dari base64 media masuk
  // maksimum (~4/3 x maxIncomingMediaBytes) supaya permintaan masih bisa
  // diparse dan penanda "file terlalu besar" dapat dibuat. Default: 96mb
  // (cukup untuk berkas 64mb + kepala pesan).
  webhookJsonBodyLimit: (process.env.EVOLUTION_WEBHOOK_BODY_LIMIT || '96mb').trim(),
};

// Peringatan keras jika HOST dibuka ke LAN tanpa authentication pada
// endpoint webhook (endpoint kontrak CI4 tetap pakai Bearer token).
config.isBoundToLan = config.host === '0.0.0.0' || (config.host !== '127.0.0.1' && config.host !== 'localhost');

// Limit body JSON untuk endpoint kirim media (base64 ~33% lebih besar).
config.mediaJsonBodyLimitBytes = Math.ceil(config.maxMediaUploadBytes * 4 / 3) + 8192;

module.exports = config;
