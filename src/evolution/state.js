'use strict';

const config = require('../config');
const logger = require('../logging');

/**
 * Status koneksi instance Evolution untuk adapter (src/evolution/*).
 *
 * Adapter TIDAK memegang sesi WhatsApp sendiri -- sesi dipegang server
 * Evolution. Status di sini karena itu hanyalah cerminan "menurut kita
 * instance Evolution bisa dipakai":
 *
 * - Kalau EVOLUTION_API_KEY/INSTANCE belum diisi -> 'disconnected'.
 * - Kalau diisi -> awalnya 'connected' (optimistis) karena status device
 *   sebenarnya hanya diketahui Evolution (dicek saat kirim: kalau instance
 *   terputus, Evolution menolak /message/send*).
 * - Webhook CONNECTION_UPDATE menimpanya secara EKSPLISIT:
 *     state 'open'       -> 'connected'
 *     state 'connecting' -> 'connecting'
 *     state 'close'      -> 'disconnected'
 *     state 'logged_out' -> 'logged_out' (bila Evolution mengirimnya)
 *   HANYA status eksplisit inilah yang punya masa basi
 *   (config.evolution.connectionStaleMs): kalau webhook berhenti melapor,
 *   status 'connected'/'connecting' dianggap 'disconnected' supaya badge
 *   UI tidak "stuck connected".
 *
 * session_health SELALU 'ok': adapter tidak punya tracker dekripsi Signal
 * (bukan miliknya), jadi tidak ada konsep 'degraded' di jalur ini. Ini
 * perbedaan penting dari Baileys lokal dan WAJIB diketahui operator.
 */

const VALID_STATES = ['connected', 'connecting', 'disconnected', 'logged_out'];

const internal = {
  status: config.evolution.apiKey && config.evolution.instance ? 'connected' : 'disconnected',
  phone: null,
  updatedAt: null,
  explicit: false,
  reason: null,
};

/** Petakan state Evolution (`open|connecting|close|logged_out`) ke status heartbeat CI4. */
function mapEvolutionState(rawState) {
  const state = String(rawState || '').toLowerCase();
  if (state === 'open' || state === 'connected') return 'connected';
  if (state === 'connecting') return 'connecting';
  if (state === 'logged_out' || state === 'loggedout') return 'logged_out';
  if (state === 'close' || state === 'closed' || state === 'disconnected') return 'disconnected';
  return null;
}

/**
 * @param {string} rawState state dari CONNECTION_UPDATE
 * @param {{phone?: string|null, reason?: string|null}} [meta]
 * @returns {boolean} true kalau state dikenali dan diterapkan
 */
function setConnectionState(rawState, meta = {}) {
  const status = mapEvolutionState(rawState);
  if (!status || !VALID_STATES.includes(status)) {
    logger.warn('[EVOLUTION-STATE] state koneksi tidak dikenali, diabaikan', { rawState });
    return false;
  }

  const previous = internal.status;
  internal.status = status;
  if (meta.phone) internal.phone = String(meta.phone);
  internal.updatedAt = new Date().toISOString();
  internal.explicit = true;
  internal.reason = meta.reason ? String(meta.reason) : null;

  // Catat HANYA saat status benar-benar berubah. Sejak heartbeat juga
  // menanyakan state ke Evolution tiap siklus (lihat heartbeat.js), fungsi ini
  // dipanggil terus-menerus dengan nilai yang sama -- mencatat tiap panggilan
  // akan membanjiri log.
  if (previous !== status) {
    const logMeta = { status, phone: internal.phone, reason: internal.reason };
    if (status === 'connected') logger.info('[EVOLUTION-STATE] instance connected', logMeta);
    else logger.warn('[EVOLUTION-STATE] instance tidak connected', logMeta);
  }
  return true;
}

/** Set nomor/phone yang terhubung tanpa mengubah status. */
function setPhone(phone) {
  if (phone) internal.phone = String(phone);
}

function getSnapshot() {
  let status = internal.status;

  // Hanya status eksplisit 'connected'/'connecting' yang bisa basi.
  if (internal.explicit && (internal.status === 'connected' || internal.status === 'connecting') && internal.updatedAt) {
    const ageMs = Date.now() - Date.parse(internal.updatedAt);
    if (Number.isFinite(ageMs) && ageMs > config.evolution.connectionStaleMs) {
      status = 'disconnected';
    }
  }

  if (!config.evolution.apiKey || !config.evolution.instance) status = 'disconnected';

  return {
    status,
    connectedNumber: internal.phone,
    sessionHealth: 'ok',
    explicit: internal.explicit,
  };
}

const isReady = () => getSnapshot().status === 'connected';

module.exports = { setConnectionState, setPhone, getSnapshot, isReady, mapEvolutionState, _internal: internal };
