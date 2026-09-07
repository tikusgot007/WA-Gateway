'use strict';

const path = require('path');
const express = require('express');
const config = require('../config');
const logger = require('../logging');
const apiRoutes = require('./routes');
const ci4Routes = require('./ci4Routes');

function createServer() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // Hanya serve folder public (dashboard). Folder auth/session TIDAK PERNAH
  // di-mount sebagai static folder, supaya credential tidak bisa diakses lewat HTTP.
  const publicDir = path.resolve(__dirname, '../../public');
  app.use(express.static(publicDir));

  app.use('/api', apiRoutes);

  // Endpoint machine-to-machine yang dipanggil CI4 (Bearer token),
  // SENGAJA di path root (bukan /api/*) -- lihat ci4Routes.js.
  app.use(ci4Routes);

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ ok: false, error: 'Not found' });
  });

  // Error handler terakhir: jangan pernah biarkan proses crash karena satu request gagal,
  // dan jangan bocorkan stack trace/detail internal ke client.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error('Unhandled error pada HTTP request', { error: err.message, path: req.path });
    res.status(500).json({ ok: false, error: 'Internal server error' });
  });

  return app;
}

function startServer() {
  const app = createServer();

  const server = app.listen(config.port, config.host, () => {
    logger.info(`HTTP API + Dashboard berjalan di http://${config.host}:${config.port}`);
    if (config.isBoundToLan) {
      logger.warn(
        `PERINGATAN SECURITY: API dibind ke ${config.host} (dapat diakses dari LAN). ` +
          'API POC ini BELUM memiliki authentication. Pastikan hanya digunakan di LAN toko yang dipercaya.'
      );
    }
  });

  return server;
}

module.exports = { createServer, startServer };
