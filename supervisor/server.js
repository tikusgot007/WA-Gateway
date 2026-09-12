'use strict';

const { exec } = require('child_process');
const config = require('./config');
const logger = require('./logger');
const { createApp } = require('./api');

// Buka browser default ke Control Panel secara otomatis -- HANYA saat
// dijalankan lewat "AuliaPos Gateway.exe" (launcher exe men-set env
// AULIAPOS_LAUNCHED_FROM_EXE=1 sebelum spawn node.exe -- lihat
// scripts/Launcher.cs), supaya UX double-click exe langsung menampilkan
// Control Panel tanpa user perlu ketik URL manual. TIDAK dilakukan saat
// development (`npm run supervisor` biasa) supaya alur developer yang
// sudah ada tidak berubah.
function openBrowserIfPackaged(url) {
  if (process.env.AULIAPOS_LAUNCHED_FROM_EXE !== '1') return;
  if (process.platform !== 'win32') return;
  // "start" builtin cmd butuh title kosong ("") sebagai argumen pertama
  // supaya URL dengan karakter tertentu tidak disalahartikan sebagai judul.
  exec(`start "" "${url}"`, (err) => {
    if (err) logger.warn(`Gagal membuka browser otomatis: ${err.message}`);
  });
}

function main() {
  if (!config.token) {
    logger.error(
      'SUPERVISOR_TOKEN belum diset di .env -- Control API akan menolak SEMUA request. ' +
        'Tambahkan SUPERVISOR_TOKEN=<random string> ke .env lalu restart Supervisor.'
    );
  }

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    const url = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
    logger.info(`Control Panel/Supervisor berjalan di ${url}`);
    if (config.host === '0.0.0.0' || (config.host !== '127.0.0.1' && config.host !== 'localhost')) {
      logger.warn(
        `PERINGATAN: Control API dibind ke ${config.host} (dapat diakses dari LAN). ` +
          'Pastikan SUPERVISOR_TOKEN sudah diset dan hanya dipakai di LAN yang dipercaya.'
      );
    }
    openBrowserIfPackaged(url);
  });

  const shutdown = async (signal) => {
    logger.info(`Menerima sinyal ${signal}, Supervisor shutting down (Gateway TIDAK ikut dihentikan otomatis)...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
