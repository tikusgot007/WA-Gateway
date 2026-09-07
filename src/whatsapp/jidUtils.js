'use strict';

/**
 * Wrapper tipis di atas util JID RESMI dari Baileys (bukan implementasi sendiri).
 * Tujuan: konsisten mengklasifikasikan JID (pn / lid / group / unknown) di seluruh
 * aplikasi, dan memastikan tidak ada tempat lain yang menebak-nebak sendiri.
 */
const { isJidUser, isLidUser, isJidGroup, jidDecode } = require('baileys');

/**
 * Klasifikasi JID menjadi salah satu dari: 'pn' (personal number, @s.whatsapp.net),
 * 'lid' (linked identity, @lid), 'group' (@g.us), atau 'unknown' jika tidak
 * dikenali/tidak valid.
 */
function classifyJid(jid) {
  if (typeof jid !== 'string' || jid.length === 0) return 'unknown';
  if (isJidGroup(jid)) return 'group';
  if (isLidUser(jid)) return 'lid';
  if (isJidUser(jid)) return 'pn';
  return 'unknown';
}

/**
 * Validasi bahwa sebuah string benar-benar JID yang bisa didecode Baileys
 * (punya format user@server yang sah), TANPA mengubah/menormalisasi isinya.
 */
function isDecodableJid(jid) {
  if (typeof jid !== 'string' || !jid.includes('@')) return false;
  try {
    const decoded = jidDecode(jid);
    return Boolean(decoded && decoded.user && decoded.server);
  } catch (err) {
    return false;
  }
}

/**
 * Ambil nomor telepon HANYA jika JID memang benar-benar personal number
 * (@s.whatsapp.net). Untuk @lid, @g.us, atau format lain, selalu return null --
 * TIDAK PERNAH memaksa angka di depan "@" menjadi nomor telepon.
 */
function extractPhoneIfAvailable(jid) {
  if (!isJidUser(jid)) return null;
  const decoded = jidDecode(jid);
  return decoded ? decoded.user : null;
}

module.exports = { classifyJid, isDecodableJid, extractPhoneIfAvailable };
