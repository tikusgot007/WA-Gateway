'use strict';

const config = require('../config');
const logger = require('../logging');
const { postToCI4 } = require('../delivery/ci4Client');
const evolutionClient = require('./client');
const evolutionState = require('./state');

/**
 * Heartbeat status adapter -> CI4 (POST /api/inbox/gateway/status), bentuk
 * IDENTIK dengan kontrak WA-Gateway (status, phone, gateway_version,
 * session_health) supaya UI Inbox tidak perlu berubah.
 *
 * Sumber status: evolution/state.js. Bedanya dari WA-Gateway lama: di sana
 * status berasal dari socket Baileys yang hidup DI PROSES ITU SENDIRI,
 * sehingga selalu segar. Sesi WhatsApp sekarang dipegang server Evolution dan
 * Evolution HANYA mengirim event `connection.update` saat state BERUBAH.
 *
 * Akibatnya, kalau hanya mengandalkan webhook, status eksplisit jadi "basi"
 * setelah config.evolution.connectionStaleMs dan badge Inbox salah
 * menampilkan "Terputus" padahal sesi sehat -- kejadian nyata 2026-10-01
 * (webhook terakhir 10:56, badge terputus mulai 10:58, padahal kirim/terima
 * normal). Karena itu tiap siklus heartbeat menanyakan langsung sumber
 * kebenarannya: GET /instance/connectionState/{instance}.
 *
 * session_health SELALU 'ok' (tidak ada tracker dekripsi di jalur ini --
 * lihat catatan risiko di plan §6.3).
 */

// Kegagalan beruntun sebelum Evolution dianggap benar-benar tidak bisa
// dipakai. Satu-dua kegagalan sesaat jangan sampai membuat badge berkedip.
const MAX_POLL_FAILURES = 3;

let timer = null;
let pollFailures = 0;

/**
 * Segarkan status dari Evolution (sumber kebenaran sesi WhatsApp).
 * Sukses: terapkan state apa adanya. Gagal: hitung; setelah MAX_POLL_FAILURES
 * berturut-turut baru tandai tidak connected supaya badge tidak berbohong
 * ketika server Evolution benar-benar mati.
 */
/**
 * Catat satu kegagalan polling. Baru setelah MAX_POLL_FAILURES berturut-turut
 * status ditandai tidak connected, supaya kegagalan sesaat tidak membuat badge
 * berkedip.
 */
function notePollFailure(reason) {
  pollFailures += 1;
  if (pollFailures === MAX_POLL_FAILURES) {
    logger.warn('[HEARTBEAT-EVOLUTION] Evolution tidak bisa dipakai; status ditandai tidak connected', {
      failures: pollFailures,
      reason,
    });
  }
  if (pollFailures >= MAX_POLL_FAILURES) {
    evolutionState.setConnectionState('close', {});
  }
}

async function refreshStateFromEvolution() {
  let rawState;
  try {
    // Timeout SENDIRI yang lebih pendek dari irama heartbeat: polling yang
    // lambat tidak boleh menunda pelaporan status (CI4 menganggap gateway basi
    // pada 30 detik).
    rawState = await evolutionClient.getConnectionState(config.evolution.statusPollTimeoutMs);
  } catch (err) {
    notePollFailure(err.message);
    return;
  }

  // "Tidak ada state yang bisa dipakai" BUKAN sukses. getConnectionState()
  // mengembalikan null tanpa melempar saat respons non-2xx atau body tak
  // diharapkan -- mis. EVOLUTION_API_KEY salah (401) atau nama instance keliru
  // (404). Kalau itu dihitung sukses, penghitung kegagalan tidak pernah jalan
  // dan status optimistis 'connected' bertahan selamanya (badge "Terhubung"
  // padahal Evolution menolak) -- justru laporan palsu yang mau dihilangkan.
  if (!evolutionState.mapEvolutionState(rawState)) {
    notePollFailure('state tidak dikenal: ' + JSON.stringify(rawState));
    return;
  }

  pollFailures = 0;

  // Pertahankan nomor yang sudah diketahui: endpoint connectionState hanya
  // mengembalikan state, bukan nomor.
  evolutionState.setConnectionState(rawState, {
    phone: evolutionState.getSnapshot().connectedNumber,
  });
}

async function sendHeartbeat() {
  if (!config.ci4.baseUrl || !config.ci4.gatewayToken) {
    logger.debug('[HEARTBEAT-EVOLUTION] CI4_BASE_URL/CI4_GATEWAY_TOKEN belum dikonfigurasi, heartbeat dilewati.');
    return;
  }

  await refreshStateFromEvolution();

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

module.exports = { start, stop, sendHeartbeat, refreshStateFromEvolution };
