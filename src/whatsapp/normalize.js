'use strict';

/**
 * Normalisasi nomor tujuan dari user (mis. "628123456789", "+62 812-3456-789",
 * "0812-3456-789") menjadi JID WhatsApp yang valid, mis. "628123456789@s.whatsapp.net".
 *
 * Aturan sederhana untuk POC:
 * - Buang semua karakter selain digit.
 * - Jika sudah mengandung "@" (berarti sudah berupa JID), pakai apa adanya setelah divalidasi bentuknya.
 * - Jika diawali "0", ganti awalan menjadi "62" (asumsi nomor Indonesia).
 * - Jika diawali "62", pakai apa adanya.
 * - Jika tidak diawali "62" dan tidak diawali "0", anggap sudah dalam format internasional
 *   tanpa "+" dan pakai apa adanya (fallback, karena POC ini fokus toko di Indonesia).
 *
 * Mengembalikan { ok: true, jid } atau { ok: false, reason }.
 */
function normalizeToJid(input) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return { ok: false, reason: 'Nomor tujuan tidak boleh kosong' };
  }

  const raw = input.trim();

  if (raw.includes('@')) {
    const validJidPattern = /^[0-9]{5,20}@(s\.whatsapp\.net|g\.us)$/;
    if (validJidPattern.test(raw)) {
      return { ok: true, jid: raw };
    }
    return { ok: false, reason: 'Format JID tidak valid' };
  }

  const digitsOnly = raw.replace(/[^0-9]/g, '');

  if (digitsOnly.length < 8 || digitsOnly.length > 15) {
    return { ok: false, reason: 'Panjang nomor tidak valid (harus 8-15 digit)' };
  }

  let normalized = digitsOnly;
  if (normalized.startsWith('0')) {
    normalized = `62${normalized.slice(1)}`;
  }

  // Nomor Indonesia harus diawali 62 setelah normalisasi.
  // Jika bukan diawali 62 dan bukan format 0xxxx, tetap diterima apa adanya
  // (mendukung pengujian dengan nomor negara lain), tapi minimal validasi panjang sudah cukup.
  const jid = `${normalized}@s.whatsapp.net`;
  return { ok: true, jid, phone: normalized };
}

/**
 * Ekstrak nomor telepon polos (tanpa domain) dari sebuah JID.
 */
function jidToPhone(jid) {
  if (!jid) return null;
  return jid.split('@')[0].split(':')[0];
}

module.exports = { normalizeToJid, jidToPhone };
