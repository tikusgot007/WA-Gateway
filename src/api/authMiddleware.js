'use strict';

const config = require('../config');
const logger = require('../logging');

/**
 * Middleware autentikasi untuk endpoint yang dipanggil CI4 (arah
 * KEBALIKAN dari Phase 2 -- di Phase 2, Gateway yang mengirim Bearer
 * token ke CI4; di sini, CI4 yang mengirim Bearer token ke Gateway).
 *
 * Memakai SATU shared secret yang sama (config.ci4.gatewayToken),
 * dikonfigurasi identik di kedua sisi (.env Gateway: CI4_GATEWAY_TOKEN,
 * .env CI4: inbox.gatewayToken) -- sesuai prinsip kesederhanaan POC,
 * satu shared secret dipakai dua arah alih-alih dua token terpisah.
 */
function requireCI4Token(req, res, next) {
  const configuredToken = config.ci4.gatewayToken;

  if (!configuredToken) {
    logger.error('[AUTH] CI4_GATEWAY_TOKEN belum dikonfigurasi, menolak semua request masuk dari CI4.');
    return res.status(503).json({
      success: false,
      error_code: 'GATEWAY_NOT_CONFIGURED',
      message: 'Gateway belum dikonfigurasi (CI4_GATEWAY_TOKEN kosong).',
    });
  }

  const header = req.get('Authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());

  if (!match || match[1] !== configuredToken) {
    logger.warn('[AUTH] Request dari CI4 ditolak: token tidak ada/tidak valid.');
    return res.status(401).json({
      success: false,
      error_code: 'UNAUTHORIZED',
      message: 'Token tidak valid.',
    });
  }

  next();
}

module.exports = { requireCI4Token };
