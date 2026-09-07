'use strict';

const config = require('../config');
const logger = require('../logging');
const { postToCI4 } = require('./ci4Client');
const connectionManager = require('../whatsapp/connectionManager');

/**
 * Push status koneksi Gateway ke CI4 (POST /api/inbox/gateway/status)
 * secara berkala, supaya POS bisa menampilkan status Gateway
 * (terhubung/menghubungkan/terputus) tanpa CI4 perlu polling balik
 * ke Gateway.
 *
 * SENGAJA tidak masuk ke SQLite reliability queue (beda dari pesan
 * masuk) -- heartbeat itu sifatnya "state saat ini", bukan event
 * yang harus dijamin sampai. Kalau satu heartbeat gagal terkirim,
 * cukup ditunggu siklus berikutnya (~15 detik lagi); tidak ada
 * gunanya retry heartbeat yang sudah basi.
 */

let timer = null;

// Mapping status internal ConnectionManager -> status yang dipahami
// CI4 (connected/connecting/disconnected/logged_out). ConnectionManager
// punya status tambahan ('reconnecting', 'error') yang secara makna
// sama-sama berarti "belum bisa dipakai kirim/terima", jadi dipetakan
// ke 'disconnected' dari sudut pandang CI4/POS.
function mapStatusForCI4(internalStatus) {
  switch (internalStatus) {
    case 'connected':
      return 'connected';
    case 'connecting':
    case 'reconnecting':
      return 'connecting';
    case 'logged_out':
      return 'logged_out';
    case 'disconnected':
    case 'error':
    default:
      return 'disconnected';
  }
}

async function sendHeartbeat() {
  if (!config.ci4.baseUrl || !config.ci4.gatewayToken) {
    logger.debug('[HEARTBEAT] CI4_BASE_URL/CI4_GATEWAY_TOKEN belum dikonfigurasi, heartbeat dilewati.');
    return;
  }

  const snapshot = connectionManager.getStatusSnapshot();

  const body = {
    status: mapStatusForCI4(snapshot.status),
    phone: snapshot.connectedNumber || null,
    gateway_version: require('../../package.json').version || null,
  };

  const result = await postToCI4('/api/inbox/gateway/status', body);

  if (!result.ok) {
    logger.warn('[HEARTBEAT] gagal mengirim status ke CI4', {
      httpStatus: result.status,
      error: result.error,
    });
  }
}

function start() {
  if (timer) return; // sudah jalan, jangan start dobel
  logger.info('[HEARTBEAT] worker heartbeat status dimulai', {
    intervalMs: config.heartbeatIntervalMs,
  });
  timer = setInterval(sendHeartbeat, config.heartbeatIntervalMs);
  sendHeartbeat(); // kirim segera saat start, jangan tunggu interval pertama
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop };
