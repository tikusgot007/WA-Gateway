'use strict';

const config = require('../config');
const logger = require('../logging');
const evolutionClient = require('./client');

/**
 * Cache info grup (subject + pemetaan LID->nomor) untuk pesan MASUK grup.
 *
 * Kontrak CI4 menyediakan `group_name` (write-once) dan `sender_jid`; tanpa
 * info grup, nama grup tidak tersimpan dan pengirim grup muncul sebagai
 * identitas LID (`...@lid`). Evolution `GET /group/findGroupInfos` memberi
 * `subject` + daftar peserta dengan `phoneNumber`, sehingga keduanya bisa diisi
 * dengan satu panggilan yang di-cache per grup (default 10 menit).
 *
 * Kegagalan bersifat NON-FATAL: bila Evolution tidak bisa dihubungi, pesan tetap
 * diteruskan (group_name null / sender_jid tetap LID). Hasil positif terakhir
 * dipertahankan sampai TTL, dengan retry singkat saat gagal.
 */

const cache = new Map(); // groupJid -> { expiresAt, subject, phoneByLid }

function buildPhoneByLid(participants) {
  const map = {};
  for (const p of participants || []) {
    if (p && typeof p.id === 'string' && typeof p.phoneNumber === 'string' && p.phoneNumber) {
      map[p.id] = p.phoneNumber;
    }
  }
  return map;
}

/**
 * @param {string} groupJid mis. "120363...@g.us"
 * @returns {Promise<{subject: string|null, phoneByLid: object}>}
 */
async function resolve(groupJid, { now = Date.now() } = {}) {
  const cached = cache.get(groupJid);
  if (cached && cached.expiresAt > now) return cached;

  let info = null;
  try {
    info = await evolutionClient.getGroupInfo(groupJid);
  } catch (err) {
    logger.warn('[GROUP-INFO] gagal mengambil info grup -- lanjut tanpa group_name', {
      groupJid,
      error: err.message,
    });
  }

  const hadCache = Boolean(cached);
  const entry = {
    subject: info && info.subject
      ? info.subject
      : (hadCache ? cached.subject : null),
    phoneByLid: info
      ? buildPhoneByLid(info.participants)
      : (hadCache ? cached.phoneByLid : {}),
    // Gagal ambil info -> retry lebih cepat (30 detik); berhasil -> TTL penuh.
    expiresAt: now + (info ? config.groupInfoCacheTtlMs : Math.min(config.groupInfoCacheTtlMs, 30000)),
  };
  cache.set(groupJid, entry);
  return entry;
}

function clearCache() {
  cache.clear();
}

module.exports = { resolve, clearCache };
