'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const config = require('./config');
const logger = require('./logger');
const processManager = require('./processManager');

function requireSupervisorToken(req, res, next) {
  if (!config.token) {
    // Tanpa token dikonfigurasi, JANGAN pernah menerima request -- fail closed,
    // bukan fail open. Tidak boleh mengekspos token di log.
    logger.error('Control request unauthorized (SUPERVISOR_TOKEN belum dikonfigurasi).');
    return res.status(503).json({ ok: false, error: 'SUPERVISOR_NOT_CONFIGURED' });
  }

  const header = req.get('Authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());

  if (!match || match[1] !== config.token) {
    logger.warn(`Control request unauthorized (${req.method} ${req.path})`);
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }

  next();
}

// Best-effort, non-fatal: ambil status koneksi WhatsApp langsung dari API
// Gateway yang sudah ada (GET /api/status). Supervisor TIDAK mem-parsing
// atau memahami business logic-nya -- cuma meneruskan field ringkas
// (status koneksi + nomor) untuk ditampilkan di Control Panel.
function fetchGatewayConnectionStatus() {
  return new Promise((resolve) => {
    const req = http.get(
      `${config.gatewayUrl}/api/status`,
      { timeout: 2000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const data = parsed?.data || {};
            resolve({
              reachable: true,
              status: data.status || 'unknown',
              connectedNumber: data.connectedNumber || null,
            });
          } catch (_err) {
            resolve({ reachable: false });
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ reachable: false });
    });
    req.on('error', () => resolve({ reachable: false }));
  });
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // UI Control Panel statis -- terpisah dari dashboard test Gateway (public/).
  app.use(express.static(path.join(__dirname, 'public')));

  const router = express.Router();
  router.use(requireSupervisorToken);

  // --- Fixed Control API (TIDAK ADA arbitrary command execution) ---------
  router.get('/status', async (req, res) => {
    const snapshot = processManager.getSnapshot();
    const gateway = snapshot.running ? await fetchGatewayConnectionStatus() : { reachable: false };
    res.json({ ok: true, data: { ...snapshot, gateway } });
  });

  router.post('/start', async (req, res) => {
    logger.info('Start requested.');
    const result = await processManager.start();
    res.status(result.ok ? 200 : 500).json({ ok: result.ok, data: result.snapshot, error: result.error });
  });

  router.post('/stop', async (req, res) => {
    logger.info('Stop requested.');
    const result = await processManager.stop();
    res.status(result.ok ? 200 : 500).json({ ok: result.ok, data: result.snapshot, error: result.error });
  });

  router.post('/restart', async (req, res) => {
    logger.info('Restart requested.');
    const result = await processManager.restart();
    res.status(result.ok ? 200 : 500).json({ ok: result.ok, data: result.snapshot, error: result.error });
  });

  // --- Info tambahan read-only (BUKAN command execution) untuk kebutuhan UI ---
  router.get('/logs', (req, res) => {
    res.json({ ok: true, data: logger.getRecentEvents() });
  });

  // Connection Info -- nilai yang perlu di-copy manual ke AuliaPos.
  // TIDAK ADA API ke AuliaPos, TIDAK ADA sinkronisasi otomatis.
  router.get('/connection-info', (req, res) => {
    res.json({
      ok: true,
      data: {
        gatewayUrl: config.gatewayUrl,
        gatewayApiToken: config.gatewayApiToken,
      },
    });
  });

  app.use('/control', router);

  app.use((req, res) => {
    res.status(404).json({ ok: false, error: 'Not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error(`Unhandled error pada Control API: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
