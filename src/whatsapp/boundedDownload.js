'use strict';

/**
 * Jalankan satu unduhan streaming dengan BATAS WAKTU yang pasti, lalu
 * kembalikan seluruh isinya sebagai satu Buffer.
 *
 * Latar belakang (plan-bugfix-inbox-media-unavailable-v1.0, REQ-005/CON-008):
 * `downloadMediaByRef()` dulu menunggu tanpa batas. Satu unduhan yang
 * menggantung (host media lambat/diam) akan menahan request HTTP `/media/download`
 * sampai klien CI4 menyerah LEBIH DULU -- dan saat itu Gateway tidak lagi
 * sempat mengirim klasifikasi apa pun, jadi CI4 hanya melihat "tidak bisa
 * menghubungi Gateway". Batas waktu di sini membuat Gateway yang MENENTUKAN
 * lebih dulu, dengan kode error yang bisa dibedakan.
 *
 * Kenapa helper terpisah, bukan langsung di method-nya: isi
 * `downloadContentFromMessage()` Baileys berasal dari namespace modul ESM
 * yang beku (tidak bisa di-stub dari test), jadi satu-satunya cara menguji
 * perilaku batas waktu ini adalah memisahkannya dari Baileys. Helper ini
 * hanya bergantung pada kontrak stream Node biasa (async iterable +
 * `destroy()`), jadi bisa diuji tanpa socket WhatsApp sama sekali.
 *
 * @param {() => Promise<AsyncIterable<Buffer> & { destroy?: Function }>} buatStream
 *        Pembuat stream; baru dipanggil SETELAH timer dipasang, supaya
 *        waktu tunggu pembuatan stream itu sendiri ikut terbatas.
 * @param {number} batasMs Batas waktu total (pembuatan stream + pembacaan).
 * @returns {Promise<Buffer>} Isi stream yang sudah digabung.
 *
 * Menolak (reject) dengan `Error` yang `code`-nya `MEDIA_DOWNLOAD_TIMEOUT`
 * kalau batas waktu terlampaui; stream yang sedang berjalan dihancurkan
 * supaya transfer tidak lanjut di latar belakang. Error lain dari stream
 * diteruskan apa adanya.
 */
async function unduhDenganBatas(buatStream, batasMs) {
  let stream = null;
  let lewatBatas = false;
  let timer = null;

  const batas = new Promise((_, reject) => {
    timer = setTimeout(() => {
      lewatBatas = true;

      const err = new Error(`unduhan media melewati batas waktu ${batasMs}ms`);
      err.code = 'MEDIA_DOWNLOAD_TIMEOUT';

      // Hancurkan transfer yang sedang berjalan; setelah klien menerima
      // 504 tidak ada gunanya socket ini terus mengunduh.
      try {
        if (stream && typeof stream.destroy === 'function') stream.destroy();
      } catch (destroyErr) {
        // tidak fatal -- yang penting promise-nya sudah ditolak
      }

      reject(err);
    }, batasMs);
  });

  const baca = (async () => {
    const s = await buatStream();
    stream = s;

    // Pembuatan stream bisa saja baru selesai SETELAH batas waktu lewat
    // (timer di atas sudah menembak saat `stream` masih null). Jangan
    // lanjut membaca.
    if (lewatBatas) {
      try {
        if (s && typeof s.destroy === 'function') s.destroy();
      } catch (destroyErr) {
        // abaikan
      }
      const err = new Error(`unduhan media melewati batas waktu ${batasMs}ms`);
      err.code = 'MEDIA_DOWNLOAD_TIMEOUT';
      throw err;
    }

    const chunks = [];
    for await (const chunk of s) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  })();

  // Promise.race() memasang handler pada `baca`, jadi rejection yang datang
  // setelah batas waktu menang pun tetap "tertangani" (tidak jadi
  // unhandledRejection) -- lihat komentar di README test.
  try {
    return await Promise.race([baca, batas]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { unduhDenganBatas };
