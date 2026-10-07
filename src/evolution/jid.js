'use strict';

/**
 * Helper JID ringan untuk adapter Evolution -- adapter ini TIDAK memegang
 * sesi WhatsApp sendiri (Baileys dijalankan oleh SERVER Evolution), jadi
 * modul ini hanya menjembatani representasi nomor/JID yang dipakai CI4
 * dengan yang dipakai REST Evolution (`number` = nomor polos digit saja).
 *
 * Evolution API (mode Baileys) mengidentifikasi kontak lewat
 * `key.remoteJid` (`<nomor>@s.whatsapp.net` untuk chat pribadi,
 * `<id>@g.us` untuk grup) -- TIDAK pernah `@lid`, karena Evolution
 * menangani pemetaan LID secara internal sebelum mengirim webhook.
 */

const USER_RE = /^[0-9]+$/;

/** Ubah nomor polos (mis. "628123456789") menjadi JID pribadi. */
function phoneToJid(phone) {
  const digits = String(phone || '').replace(/[^0-9]/g, '');
  return digits ? `${digits}@s.whatsapp.net` : null;
}

/** Ambil nomor polos dari JID (atau dari remoteJid grup -- tetap dibersihkan ke digit). */
function jidToPhone(jid) {
  if (typeof jid !== 'string') return null;
  const user = jid.includes('@') ? jid.slice(0, jid.indexOf('@')) : jid;
  const digits = user.replace(/[^0-9]/g, '');
  return digits || null;
}

/** true bila JID berbentuk grup (`@g.us`). */
function isGroupJid(jid) {
  return typeof jid === 'string' && /@g\.us$/i.test(jid);
}

/**
 * true bila JID berupa identitas LID (`@lid`). Evolution (Baileys) menerima
 * `@s.whatsapp.net` / `@g.us` untuk `readMessages`, BUKAN `@lid`
 * (`isPnUser` menolaknya) -- jadi endpoint read harus menolak/men-skip LID
 * supaya kegagalan tidak terjadi diam-diam di sisi Evolution.
 */
function isLidJid(jid) {
  return typeof jid === 'string' && /@lid$/i.test(jid);
}

/**
 * Validasi longgar: string, punya "user@server", bagian user berisi digit.
 * Tidak menormalkan isi JID.
 */
function isDecodableJid(jid) {
  if (typeof jid !== 'string' || !jid.includes('@')) return false;
  const at = jid.indexOf('@');
  const user = jid.slice(0, at);
  const server = jid.slice(at + 1);
  return Boolean(user && server && USER_RE.test(user));
}

module.exports = { phoneToJid, jidToPhone, isGroupJid, isLidJid, isDecodableJid };
