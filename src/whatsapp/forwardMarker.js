'use strict';

/**
 * Teruskan (Tahap 4, REQ-001/REQ-001a/REQ-002/REQ-003): penanda "diteruskan"
 * untuk pesan yang DIKIRIM Gateway atas permintaan AuliaPos.
 *
 * Dua mekanisme, urutan selalu sama (REQ-002):
 *   1. NATIVE (diutamakan): lampirkan `contextInfo.forwardingScore` +
 *      `isForwarded` ke KONTEN yang diserahkan ke Baileys. Diverifikasi dari
 *      source Baileys 6.7.24 yang ter-install
 *      (`node_modules/baileys/lib/Utils/messages.js`):
 *        - `generateWAMessageFromContent()` menggabungkan `contextInfo` tingkat
 *          pesan ke konten hasil (`if ('contextInfo' in message && ...)`),
 *        - `generateForwardMessageContent()` membaca
 *          `contextInfo.forwardingScore > 0` lalu menandai `isForwarded: true`.
 *      Jadi penanda native TIDAK memerlukan `quoted` sama sekali (CON-001) dan
 *      Gateway tidak perlu membentuk/memegang ulang pesan asli (ALT-001 ditolak).
 *   2. TEXT FALLBACK: kalau penanda native TIDAK tersedia (versi Baileys yang
 *      terpasang belum mendukung penggabungan `contextInfo`, lihat
 *      `baileysLoader.supportsContentContextInfo()`), sisipkan prefix di depan
 *      teks (`text`, atau `caption` untuk media) supaya penerima tetap tahu pesan
 *      ini diteruskan. Isi pesan pengguna TIDAK PERNAH hilang karena penanda
 *      tambahan gagal dipasang (ALT-003).
 *
 * PENTING (CON-001): helper ini tidak pernah menyentuh `quoted`, dan tidak
 * pernah membentuk objek pesan Baileys apa pun. Satu-satunya efeknya pada
 * konten adalah satu field `contextInfo` ATAU satu prefix teks.
 */

// Nilai penanda yang dilaporkan ke AuliaPos (REQ-003). Daftar ini juga dipakai
// store operasi kirim keluar untuk kolom tri-state, jadi tetap satu sumber.
const FORWARD_MARKER_NATIVE = 'native';
const FORWARD_MARKER_TEXT_FALLBACK = 'text_fallback';
const FORWARD_MARKERS = [FORWARD_MARKER_NATIVE, FORWARD_MARKER_TEXT_FALLBACK];

// Prefix penanda teks. Sengaja pendek dan eksplisit: penerima harus tahu pesan
// ini diteruskan, bukan ditulis ulang.
const FORWARD_TEXT_PREFIX = '↪️ Diteruskan: ';

// `forwardingScore` >= 1 adalah sinyal "diteruskan" versi WhatsApp. Nilai yang
// lebih besar tidak menambah arti apa pun, jadi tetap 1.
const NATIVE_FORWARD_CONTEXT_INFO = { forwardingScore: 1, isForwarded: true };

/**
 * Baca field `forward` dari body request.
 *
 * `undefined`/`null` = tidak dikirim (request lama, tidak berubah), dan `false`
 * = sengaja tidak meminta penanda; keduanya normal, tanpa log. Selain itu
 * HANYA `true` yang berarti benar-benar meminta penanda; nilai lain (string
 * "true", 1, objek, ...) diperlakukan `false` dan dilaporkan lewat
 * `malformed` supaya pemanggil bisa MENOLAK SECARA BERBUNYI -- konten pesan
 * tidak boleh hilang karena field tambahan yang salah (pola degradasi F-C yang
 * sama dipakai `quoted`, bukan penolakan request).
 *
 * @param {*} raw nilai field `forward` dari body request
 * @returns {{requested: boolean, malformed: boolean}}
 */
function resolveForwardRequest(raw) {
  if (raw === undefined || raw === null) return { requested: false, malformed: false };
  if (typeof raw === 'boolean') return { requested: raw, malformed: false };
  return { requested: false, malformed: true };
}

/** Objek polos yang aman disalin dan ditambah field (bukan Buffer/array). */
function isAttachableContent(content) {
  return content !== null && typeof content === 'object' && !Array.isArray(content) && !Buffer.isBuffer(content);
}

/**
 * Terapkan penanda diteruskan pada konten Baileys.
 *
 * Tidak pernah melempar dan tidak pernah membangun konten baru kalau
 * `requested` false -- objek yang dikembalikan adalah objek yang sama seperti
 * yang masuk, sehingga jalur lama benar-benar tidak berubah satu byte pun.
 *
 * @param {object} args
 * @param {object} args.content konten Baileys (mis. `{ text }` / `{ image, caption }`)
 * @param {boolean} args.requested hasil `resolveForwardRequest().requested`
 * @param {boolean} args.nativeSupported hasil `supportsContentContextInfo()` --
 *   hanya `true` bila versi Baileys terpasang sudah terverifikasi mendukung
 *   penanda native lewat `contextInfo`.
 * @param {string|null} [args.textField] nama field teks untuk prefix fallback:
 *   `'text'` (pesan teks) atau `'caption'` (media). `null`/absent untuk konten
 *   yang tidak menerima teks sama sekali (stiker: WhatsApp mengabaikan caption,
 *   lihat §16 README) -- kasus itu tidak bisa punya teks fallback.
 * @param {string} [args.text] isi field tersebut apa adanya dari request
 * @returns {{content: object, marker: string|null, reason: string|null}}
 *   `marker` hanya terisi bila penanda diminta; `reason` hanya terisi saat
 *   jatuh ke text fallback (null pada native).
 */
function applyForwardMarker({ content, requested, nativeSupported, textField = null, text = '' }) {
  if (!requested) return { content, marker: null, reason: null };

  if (nativeSupported && isAttachableContent(content)) {
    const contextInfo = content.contextInfo && typeof content.contextInfo === 'object'
      ? content.contextInfo
      : {};
    return {
      content: { ...content, contextInfo: { ...contextInfo, ...NATIVE_FORWARD_CONTEXT_INFO } },
      marker: FORWARD_MARKER_NATIVE,
      reason: null,
    };
  }

  // Penanda native tidak tersedia -> pesan tetap terkirim dengan prefix teks
  // (REQ-002). Kalau kontennya tidak menerima teks (stiker), prefix tidak bisa
  // ditampilkan; pemanggil responsible mencatat ke log.
  if (textField === null || !isAttachableContent(content)) {
    return {
      content,
      marker: FORWARD_MARKER_TEXT_FALLBACK,
      reason: 'penanda native tidak tersedia dan konten ini tidak menerima teks fallback',
    };
  }
  return {
    content: { ...content, [textField]: `${FORWARD_TEXT_PREFIX}${text || ''}` },
    marker: FORWARD_MARKER_TEXT_FALLBACK,
    reason: `penanda native tidak tersedia; prefix teks disisipkan ke "${textField}"`,
  };
}

module.exports = {
  FORWARD_MARKER_NATIVE,
  FORWARD_MARKER_TEXT_FALLBACK,
  FORWARD_MARKERS,
  FORWARD_TEXT_PREFIX,
  resolveForwardRequest,
  applyForwardMarker,
};
