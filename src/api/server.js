'use strict';

const express = require('express');
const config = require('../config');
const logger = require('../logging');
const evolutionCi4Routes = require('../evolution/ci4Routes');
const evolutionWebhookRoutes = require('../evolution/webhookRoutes');
const { attachRealtime } = require('../realtime/server');

/**
 * Server HTTP adapter Evolution. TIDAK memuat apa pun dari Baileys -- sesi
 * WhatsApp dipegang server Evolution.
 *
 * - /evolution/*  : webhook masuk dari Evolution (bukan Bearer token;
 *   dilindungi opsional oleh EVOLUTION_WEBHOOK_SECRET).
 * - /send, /send-media, /media/download : kontrak CI4 -> adapter (Bearer
 *   token, sama persis dengan WA-Gateway).
 *
 * Body-parser dipasang PER ROUTE di masing-masing router.
 */
function createServer() {
  const app = express();
  app.disable('x-powered-by');

  app.use('/evolution', evolutionWebhookRoutes);
  app.use(evolutionCi4Routes);

  app.use((req, res) => {
    res.status(404).json({ ok: false, error: 'Not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.status === 413 || err.type === 'entity.too.large') {
      logger.warn('Request ditolak: body request terlalu besar', { path: req.path });
      return res.status(413).json({ ok: false, error: 'Body request terlalu besar' });
    }
    logger.error('Unhandled error pada HTTP request (evolution adapter)', { error: err.message, path: req.path });
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  });

  return app;
}

function startServer() {
  const app = createServer();
  const server = app.listen(config.port, config.host, () => {
    logger.info(`[EVOLUTION] adapter HTTP berjalan di http://${config.host}:${config.port}`);
    logger.info(`[EVOLUTION] webhook path: ${config.evolution.webhookPath}`);
    if (config.isBoundToLan) {
      logger.warn(
        `PERINGATAN SECURITY: adapter dibind ke ${config.host} (dapat diakses dari LAN). ` +
          'Set EVOLUTION_WEBHOOK_SECRET agar endpoint /evolution/webhook tidak terbuka bebas.'
      );
    }
  });

  // Spike Inbox realtime: WebSocket memakai HTTP server yang sama, jadi tidak
  // perlu port tambahan. Autentikasi dilakukan dengan short-lived ticket dari CI4.
  attachRealtime(server);

  return server;
}

module.exports = { createServer, startServer };
