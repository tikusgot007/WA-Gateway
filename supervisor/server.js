'use strict';

const config = require('./config');
const logger = require('./logger');
const { createApp } = require('./api');

function main() {
  if (!config.token) {
    logger.error(
      'SUPERVISOR_TOKEN belum diset di .env -- Control API akan menolak SEMUA request. ' +
        'Tambahkan SUPERVISOR_TOKEN=<random string> ke .env lalu restart Supervisor.'
    );
  }

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    logger.info(`Control Panel/Supervisor berjalan di http://${config.host}:${config.port}`);
    if (config.host === '0.0.0.0' || (config.host !== '127.0.0.1' && config.host !== 'localhost')) {
      logger.warn(
        `PERINGATAN: Control API dibind ke ${config.host} (dapat diakses dari LAN). ` +
          'Pastikan SUPERVISOR_TOKEN sudah diset dan hanya dipakai di LAN yang dipercaya.'
      );
    }
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
