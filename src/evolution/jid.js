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

/**
 * Bagian user JID grup: digit, boleh satu tanda `-` pemisah
 * (`120363275037744005` atau `628563324637-1623478602`).
 */
const GROUP_USER_RE = /^[0-9]+(?:-[0-9]+)?$/;

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
 * Nilai `number` untuk REST Evolution, sadar grup.
 *
 * - **Grup**: kirim JID utuh (`<id>@g.us`) apa adanya. Evolution
 *   (`createJid()` di `utils/createJid.ts`) meneruskan string yang sudah
 *   mengandung `@g.us` tanpa mengubahnya, jadi id grup sampai utuh.
 * - **Pribadi**: nomor polos (perilaku lama).
 *
 * Kenapa tidak boleh `jidToPhone()` untuk grup: `jidToPhone()` membuang
 * semua non-digit, sehingga id grup gaya lama (`628563324637-1623478602@g.us`,
 * dipakai grup "AULIA ADA AAN") kehilangan tanda `-` menjadi
 * `6285633246371623478602`. Evolution lalu melihatnya sebagai nomor panjang
 * (>= 18 digit) dan mengarang grup `6285633246371623478602@g.us` yang tidak
 * ada -- pesan tidak pernah sampai.
 */
function evolutionNumberFor(jid) {
  return isGroupJid(jid) ? String(jid) : jidToPhone(jid);
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
 *
 * Server `g.us` (grup) memakai aturan tersendiri: id grup boleh memuat tanda
 * `-`, karena Evolution/Baileys memakai DUA bentuk id grup --
 * `120363…@g.us` (modern) dan `<nomor>-<acak>@g.us` (lama, mis. grup
 * "AULIA ADA AAN" = `628563324637-1623478602@g.us`). Bentuk lama dulu ditolak
 * `USER_RE` sehingga kirim ke grup itu gagal `INVALID_CHAT_ID`.
 */
function isDecodableJid(jid) {
  if (typeof jid !== 'string' || !jid.includes('@')) return false;
  const at = jid.indexOf('@');
  const user = jid.slice(0, at);
  const server = jid.slice(at + 1);
  if (!user || !server) return false;
  if (server.toLowerCase() === 'g.us') return GROUP_USER_RE.test(user);
  return USER_RE.test(user);
}

module.exports = { phoneToJid, jidToPhone, isGroupJid, isLidJid, isDecodableJid, evolutionNumberFor };