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

  // Body-parser JSON TIDAK dipasang global di sini -- setiap router (routes.js,
  // ci4Routes.js) memasang parser-nya sendiri PER ROUTE, dengan limit berbeda
  // untuk endpoint teks biasa (256kb) vs endpoint kirim media (base64 file,
  // limit lebih besar sesuai MAX_MEDIA_UPLOAD_MB). Ini SENGAJA, bukan
  // kelalaian -- limit body harus ditentukan SEBELUM stream request dibaca,
  // jadi tidak bisa "dicoba kecil dulu, gagal baru dicoba besar" pakai parser
  // global tunggal.

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
    // Body request kelewat besar (dilempar body-parser express.json() milik
    // masing-masing router SEBELUM handler route-nya sendiri jalan) -- kasus
    // ini WAJAR terjadi (terutama di endpoint kirim media) dan bukan bug,
    // jadi jangan disamarkan jadi "Internal server error" generik.
    if (err.status === 413 || err.type === 'entity.too.large') {
      logger.warn('Request ditolak: body request terlalu besar', { path: req.path });
      return res.status(413).json({ ok: false, error: 'Body request terlalu besar' });
    }

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
