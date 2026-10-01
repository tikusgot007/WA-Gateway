'use strict';

const config = require('../config');
const logger = require('../logging');
const { postToCI4 } = require('../delivery/ci4Client');
const evolutionState = require('./state');

/**
 * Heartbeat status adapter -> CI4 (POST /api/inbox/gateway/status), bentuk
 * IDENTIK dengan kontrak WA-Gateway (status, phone, gateway_version,
 * session_health) supaya UI Inbox tidak perlu berubah.
 *
 * Bedanya hanya sumber status: evolution/state.js, bukan connectionManager
 * Baileys lokal. session_health SELALU 'ok' (tidak ada tracker dekripsi di
 * jalur ini -- lihat catatan risiko di plan §6.3).
 */

let timer = null;

async function sendHeartbeat() {
  if (!config.ci4.baseUrl || !config.ci4.gatewayToken) {
    logger.debug('[HEARTBEAT-EVOLUTION] CI4_BASE_URL/CI4_GATEWAY_TOKEN belum dikonfigurasi, heartbeat dilewati.');
    return;
  }

  const snapshot = evolutionState.getSnapshot();
  const body = {
    status: snapshot.status,
    phone: snapshot.connectedNumber || null,
    gateway_version: require('../../package.json').version || null,
    session_health: snapshot.sessionHealth || 'ok',
  };

  const result = await postToCI4('/api/inbox/gateway/status', body);
  if (!result.ok) {
    logger.warn('[HEARTBEAT-EVOLUTION] gagal mengirim status ke CI4', {
      httpStatus: result.status,
      error: result.error,
    });
  }
}

function start() {
  if (timer) return;
  logger.info('[HEARTBEAT-EVOLUTION] worker heartbeat status dimulai', {
    intervalMs: config.heartbeatIntervalMs,
  });
  timer = setInterval(sendHeartbeat, config.heartbeatIntervalMs);
  sendHeartbeat();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, sendHeartbeat };
