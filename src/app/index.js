'use strict';

const config = require('../config');
const logger = require('../logging');
const { ensureBaileysLoaded } = require('../whatsapp/baileysLoader');
const connectionManager = require('../whatsapp/connectionManager');
const { startServer } = require('../api/server');
const incomingDelivery = require('../delivery/incomingDelivery');
const heartbeat = require('../delivery/heartbeat');
const outgoingOperationService = require('../delivery/outgoingOperationService');

async function main() {
  logger.info('Gateway starting', {
    host: config.host,
    port: config.port,
    authFolder: config.authFolder,
  });

  // Harus di-await SEBELUM apa pun lain yang menyentuh baileys (langsung
  // ataupun lewat jidUtils.js) -- lihat penjelasan di baileysLoader.js.
  await ensureBaileysLoaded();

  const server = startServer();

  try {
    await connectionManager.start();
  } catch (err) {
    logger.error('Gagal memulai koneksi WhatsApp saat startup', { error: err.message });
    // Jangan crash total: dashboard tetap bisa dibuka untuk melihat status "error"
    // dan mencoba reconnect manual dari sana.
  }

  // Phase 2: mulai worker integrasi ke CI4 (Shared WhatsApp Inbox).
  // Keduanya aman dijalankan meski CI4_BASE_URL/CI4_GATEWAY_TOKEN belum
  // diisi -- akan melewati siklusnya sendiri sambil menunggu dikonfigurasi
  // (lihat log level debug di masing-masing modul).
  incomingDelivery.start();
  heartbeat.start();

  // M1 Wave 2 (REQ-031/REQ-032, TASK-008): tugas start-up operasi kirim keluar --
  // catat operasi in_flight basi (hasil kirim belum pasti) dan pangkas baris
  // terminal yang melewati TTL. Tidak memblokir start: kegagalan dicatat, bukan
  // dilempar (lihat outgoingOperationService.runStartupRecovery()).
  outgoingOperationService.runStartupRecovery();

  const shutdown = async (signal) => {
    logger.info(`Menerima sinyal ${signal}, shutting down gateway...`);
    incomingDelivery.stop();
    heartbeat.stop();
    await connectionManager.shutdown();
    server.close(() => {
      logger.info('Gateway shutdown selesai.');
      process.exit(0);
    });
    // Failsafe jika server.close menggantung terlalu lama
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Dipanggil oleh Supervisor (supervisor/processManager.js) lewat IPC saat
  // proses ini di-spawn sebagai child process (stdio 'ipc') -- jalur graceful
  // shutdown yang sama dipakai baik dijalankan manual (SIGINT/SIGTERM) maupun
  // dikontrol dari Control Panel. Aman dijalankan standalone (process.send
  // undefined bila tidak ada channel IPC, listener ini cuma tidak pernah terpanggil).
  if (typeof process.send === 'function') {
    process.on('message', (msg) => {
      if (msg === 'shutdown') {
        shutdown('supervisor-ipc');
      }
    });
  }

  // Jangan biarkan gateway crash total karena satu error tak tertangani di
  // suatu tempat (mis. dari library pihak ketiga). Cukup log, karena
  // instruksi POC: "Gateway tidak boleh crash hanya karena satu pesan/request gagal".
  //
  // Pesan log SENGAJA menyertakan nama/jenis error langsung di dalam teks
  // (bukan cuma di field tambahan), supaya kelihatan jelas di dashboard
  // (yang cuma menampilkan teks pesan utama) -- sebelumnya semua baris
  // cuma tampil "Uncaught exception" polos tanpa detail, menyulitkan
  // diagnosa saat terjadi banyak error beruntun (mis. "Bad MAC"/
  // "MessageCounterError" dari Baileys setelah komputer sleep lama --
  // itu perilaku Baileys/WhatsApp sendiri, session enkripsi jadi basi,
  // BUKAN bug di kode Gateway ini).
  //
  // Ditambah throttle sederhana: kalau pesan error yang PERSIS SAMA
  // terjadi berturut-turut dalam jeda singkat (mis. Baileys retry
  // decrypt berkali-kali dan gagal terus dengan alasan sama persis),
  // cuma baris pertama yang dicatat + ringkasan "diulang Nx", bukan
  // ratusan baris identik yang bikin log/dashboard sulit dibaca.
  let lastLoggedErrorMsg = null;
  let lastLoggedErrorAt = 0;
  let suppressedCount = 0;
  const THROTTLE_MS = 3000;

  function logThrottledError(message) {
    const now = Date.now();

    if (message === lastLoggedErrorMsg && (now - lastLoggedErrorAt) < THROTTLE_MS) {
      suppressedCount++;
      lastLoggedErrorAt = now;
      return;
    }

    if (suppressedCount > 0) {
      logger.error(`(pesan error sebelumnya berulang ${suppressedCount}x dalam waktu singkat, disembunyikan)`);
    }

    logger.error(message);
    lastLoggedErrorMsg = message;
    lastLoggedErrorAt = now;
    suppressedCount = 0;
  }

  // Pola error session decrypt Baileys/libsignal yang SUDAH DIKENAL LUAS
  // terjadi terus-menerus pada koneksi WhatsApp multi-device yang jalan
  // lama -- biasanya berasal dari paket protokol internal WhatsApp (mis.
  // sinkronisasi status baca/state antar-device lain yang login ke akun
  // yang sama), BUKAN dari pesan chat customer yang sebenarnya. Pesan
  // chat asli tetap terkirim/diterima normal lewat jalur lain walau
  // error ini muncul. Diturunkan ke level 'debug' (tidak tampil di
  // panel Event/Log dashboard secara default, LOG_LEVEL=info) supaya
  // tidak menutupi error lain yang benar-benar perlu perhatian -- tetap
  // tercatat di file log kalau LOG_LEVEL diubah jadi 'debug' untuk
  // investigasi mendalam suatu saat.
  const POLA_ERROR_NOISE_BAILEYS = [
    'Bad MAC',
    'MessageCounterError',
    'Key used already or never filled',
    'Failed to decrypt message',
  ];

  function isNoiseBaileysError(message) {
    return POLA_ERROR_NOISE_BAILEYS.some((pola) => message.includes(pola));
  }

  process.on('unhandledRejection', (reason) => {
    const name = reason?.name || 'UnhandledRejection';
    const message = reason?.message || String(reason);
    const teksLengkap = `Unhandled promise rejection: ${name}: ${message}`;

    if (isNoiseBaileysError(teksLengkap)) {
      logger.debug(teksLengkap);
      return;
    }

    logThrottledError(teksLengkap);
  });
  process.on('uncaughtException', (err) => {
    const teksLengkap = `Uncaught exception: ${err.name || 'Error'}: ${err.message}`;

    if (isNoiseBaileysError(teksLengkap)) {
      logger.debug(teksLengkap);
      return;
    }

    logThrottledError(teksLengkap);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error saat startup gateway:', err);
  process.exit(1);
});
