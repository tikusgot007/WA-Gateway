'use strict';
/**
 * Skrip simulasi (BUKAN pengganti test nyata) untuk memvalidasi LOGIKA
 * dukungan sticker WhatsApp (kirim & terima) -- pola & gaya SAMA dengan
 * simulate-audio-video.js/simulate-send-media.js yang sudah ada.
 *
 * Ini TIDAK menghubungi server WhatsApp sungguhan. Test end-to-end nyata
 * (kirim/terima sticker sungguhan dari HP, termasuk sticker animasi) WAJIB
 * dijalankan dengan koneksi asli sebelum dianggap "selesai" -- lihat
 * catatan di akhir file ini.
 */
const assert = require('assert');
const { ensureBaileysLoaded } = require('../src/whatsapp/baileysLoader');
const connectionManager = require('../src/whatsapp/connectionManager');
const messageStore = require('../src/whatsapp/messageStore');
const incomingBuffer = require('../src/store/incomingBuffer');
const { VALID_MEDIA_TYPES, isValidWebp } = require('../src/whatsapp/mediaPayload');

// Buffer WebP MINIMAL yang lolos validasi magic-bytes (RIFF....WEBP) --
// lihat komentar isValidWebp() di mediaPayload.js soal kenapa cuma magic
// bytes yang dicek di sini (bukan struktur VP8 penuh).
const FAKE_WEBP_BUFFER = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.from('dummy-vp8-data-untuk-simulasi'),
]);

// _handleIncomingMessage() async -- HARUS di-await, sama seperti
// simulate-audio-video.js/simulate-lid-conversation.js.
async function simulateIncomingRaw(remoteJid, waMessageId, messageContent, extra = {}) {
  await connectionManager._handleIncomingMessage({
    key: { remoteJid, fromMe: false, id: waMessageId },
    pushName: 'Simulasi Customer',
    message: messageContent,
    messageTimestamp: Math.floor(Date.now() / 1000),
    ...extra,
  });
}

(async () => {

// Sama seperti src/app/index.js -- baileys@6.7.24 ESM-only, harus di-load
// SEKALI di awal sebelum connectionManager.js dipakai (lihat
// baileysLoader.js untuk penjelasan lengkap).
await ensureBaileysLoaded();

console.log('--- 0. VALID_MEDIA_TYPES sekarang termasuk sticker (kirim keluar) ---');
assert.deepStrictEqual(VALID_MEDIA_TYPES, ['image', 'document', 'sticker']);
console.log('OK: VALID_MEDIA_TYPES bertambah "sticker", image/document tidak berubah urutannya.');

console.log('\n--- 1. Sticker masuk dengan referensi LENGKAP -> diteruskan dengan benar ---');
await simulateIncomingRaw('6281222000001@s.whatsapp.net', 'SIM-STICKER-1', {
  stickerMessage: {
    directPath: '/v/t62.15575-24/sticker1',
    mediaKey: Buffer.from('fake-media-key-1'),
    mimetype: 'image/webp',
    fileLength: '54321',
    fileSha256: Buffer.from('fake-sha256-1'),
    isAnimated: false,
  },
});
let msgs = messageStore.getByChatId('6281222000001@s.whatsapp.net');
assert.strictEqual(msgs.length, 1, 'Harus ada 1 pesan tersimpan untuk sticker dengan referensi lengkap');
assert.strictEqual(msgs[0].messageType, 'sticker', 'message_type harus "sticker"');
assert.strictEqual(msgs[0].text, null, 'Sticker tidak punya caption -> text harus null (WhatsApp tidak izinkan caption di sticker)');
assert.ok(msgs[0].media, 'media harus terisi (bukan null) untuk referensi lengkap');
assert.strictEqual(msgs[0].media.mediaType, 'sticker');
assert.strictEqual(msgs[0].media.directPath, '/v/t62.15575-24/sticker1');
assert.strictEqual(msgs[0].media.mediaKeyBase64, Buffer.from('fake-media-key-1').toString('base64'));
assert.strictEqual(msgs[0].media.mimetype, 'image/webp');
assert.strictEqual(msgs[0].media.fileLength, 54321, 'fileLength harus dikonversi ke Number');
assert.strictEqual(msgs[0].media.fileSha256Base64, Buffer.from('fake-sha256-1').toString('base64'));
assert.strictEqual(msgs[0].media.fileName, null, 'sticker tidak punya fileName, harus null (sama seperti image)');
// KONTRAK PENTING: field `media` yang diteruskan ke CI4 harus IDENTIK
// bentuknya dengan image/document (lihat instruksi Task ini) -- TIDAK
// ada field tambahan seperti `isAnimated` yang bocor ke sini, supaya
// AuliaPos bisa proses sticker lewat cabang kode image/document yang
// sama persis, tanpa field asing yang tidak dikenal.
assert.deepStrictEqual(
  Object.keys(msgs[0].media).sort(),
  ['directPath', 'fileLength', 'fileName', 'fileSha256Base64', 'mediaKeyBase64', 'mediaType', 'mimetype'].sort(),
  'Field media sticker harus IDENTIK dengan image/document (buildMediaRef()), tidak ada field tambahan seperti isAnimated'
);
console.log('OK: sticker dengan referensi lengkap tersimpan message_type=sticker, media identik bentuknya dengan image/document.');

console.log('\n--- 2. Sticker masuk dengan referensi TIDAK LENGKAP -> DIBUANG (konsisten image/document, BUKAN audio/video) ---');
const beforeCount2 = messageStore.getByChatId('6281222000002@s.whatsapp.net').length;
await simulateIncomingRaw('6281222000002@s.whatsapp.net', 'SIM-STICKER-2', {
  stickerMessage: {
    // directPath & mediaKey SENGAJA tidak diisi -- referensi tidak lengkap.
    mimetype: 'image/webp',
    fileLength: '1000',
  },
});
const afterCount2 = messageStore.getByChatId('6281222000002@s.whatsapp.net').length;
assert.strictEqual(afterCount2, beforeCount2, 'Sticker dengan directPath/mediaKey kosong TIDAK BOLEH tersimpan/diteruskan sama sekali');
console.log('OK: sticker dengan referensi tidak lengkap dibuang (tidak diteruskan), sama seperti image/document -- BUKAN seperti audio/video yang tetap diteruskan walau metadata kosong.');

console.log('\n--- 3. Sticker ANIMASI (isAnimated: true) -> diproses SAMA seperti sticker statis (tidak ada logic bercabang) ---');
await simulateIncomingRaw('6281222000003@s.whatsapp.net', 'SIM-STICKER-3', {
  stickerMessage: {
    directPath: '/v/t62.15575-24/sticker3-animated',
    mediaKey: Buffer.from('fake-media-key-3'),
    mimetype: 'image/webp',
    fileLength: '99999',
    fileSha256: Buffer.from('fake-sha256-3'),
    isAnimated: true,
  },
});
msgs = messageStore.getByChatId('6281222000003@s.whatsapp.net');
assert.strictEqual(msgs.length, 1);
assert.strictEqual(msgs[0].messageType, 'sticker', 'Sticker animasi tetap message_type=sticker, TIDAK ADA tipe terpisah untuk animasi');
assert.deepStrictEqual(
  Object.keys(msgs[0].media).sort(),
  Object.keys(messageStore.getByChatId('6281222000001@s.whatsapp.net')[0].media).sort(),
  'Bentuk object media sticker animasi harus IDENTIK dengan sticker statis (isAnimated tidak bocor ke field media)'
);
console.log('OK: sticker animasi diproses lewat cabang kode yang sama persis dengan sticker statis (tidak ada percabangan logic khusus).');

console.log('\n--- 4. Idempotency: wa_message_id sama dikirim 2x TIDAK boleh dobel di buffer retry ---');
const beforePending = incomingBuffer.countPending();
// wa_message_id UNIK per-run (Date.now()) -- lihat catatan higiene test
// yang sama di simulate-audio-video.js soal kenapa bukan literal tetap.
const dupPayload = {
  messageId: 'SIM-DUP-STICKER-' + Date.now(),
  chatId: '6281222000004@s.whatsapp.net',
  jidType: 'pn',
  sender: { jid: '6281222000004@s.whatsapp.net', phone: '6281222000004', name: 'Dup Sticker Test' },
  text: null,
  messageType: 'sticker',
  media: {
    mediaType: 'sticker',
    directPath: '/v/dup',
    mediaKeyBase64: Buffer.from('dup-key').toString('base64'),
    mimetype: 'image/webp',
    fileLength: 1234,
    fileSha256Base64: Buffer.from('dup-sha').toString('base64'),
    fileName: null,
  },
  timestamp: new Date().toISOString(),
  direction: 'incoming',
};
incomingBuffer.enqueue(dupPayload);
incomingBuffer.enqueue(dupPayload); // dikirim ulang persis sama, mis. Gateway retry
const afterPending = incomingBuffer.countPending();
assert.strictEqual(afterPending - beforePending, 1, 'wa_message_id sticker yang sama dikirim 2x hanya boleh menghasilkan 1 baris pending baru');
console.log('OK: enqueue() sticker dengan wa_message_id sama 2x hanya menghasilkan 1 baris (idempotent, sama seperti image/document/audio/video).');

console.log('\n--- 5a. isValidWebp(): validasi format sticker KELUAR ---');
assert.strictEqual(isValidWebp(FAKE_WEBP_BUFFER), true, 'Buffer dengan magic bytes RIFF....WEBP harus valid');
assert.strictEqual(isValidWebp(Buffer.from('bukan file webp sama sekali')), false, 'Buffer acak (bukan WebP) harus ditolak');
assert.strictEqual(isValidWebp(Buffer.alloc(0)), false, 'Buffer kosong harus ditolak');
assert.strictEqual(isValidWebp(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), false, 'Magic bytes JPEG harus ditolak (bukan WebP)');
console.log('OK: isValidWebp() menerima WebP asli (magic bytes RIFF/WEBP), menolak format lain -- termasuk JPEG yang keliru dikirim sebagai "sticker".');

console.log('\n--- 5b. Kirim sticker KELUAR dengan buffer valid -> sukses, media_ref terbentuk benar ---');
// Palsukan status "connected" + sock.sendMessage() SUPAYA sendMediaMessage()
// bisa diuji tanpa koneksi WhatsApp sungguhan -- pola SAMA dengan
// simulate-send-media.js test 6 (mock connectionManager.status/sock).
const originalStatus = connectionManager.status;
const originalSock = connectionManager.sock;
connectionManager.status = 'connected';
connectionManager.sock = {
  sendMessage: async (_jid, _content) => ({
    key: { id: 'SIM-SENT-STICKER-1' },
    message: {
      stickerMessage: {
        directPath: '/v/t62.15575-24/sent-sticker',
        mediaKey: Buffer.from('sent-media-key'),
        mimetype: 'image/webp',
        fileLength: 4321,
        fileSha256: Buffer.from('sent-sha256'),
        isAnimated: true,
      },
    },
  }),
};
try {
  const result = await connectionManager.sendMediaMessage(
    '255490491736112@lid',
    'sticker',
    FAKE_WEBP_BUFFER,
    { isAnimated: true }
  );
  assert.strictEqual(result.messageId, 'SIM-SENT-STICKER-1');
  assert.ok(result.mediaRef, 'mediaRef harus terbentuk dari stickerMessage hasil sendMessage()');
  assert.strictEqual(result.mediaRef.mediaType, 'sticker');
  assert.strictEqual(result.mediaRef.directPath, '/v/t62.15575-24/sent-sticker');
  assert.strictEqual(result.mediaRef.mediaKeyBase64, Buffer.from('sent-media-key').toString('base64'));
  console.log('OK: sendMediaMessage() untuk sticker berhasil, media_ref terbentuk benar dari hasil sendMessage() Baileys (buildMediaRef() di-reuse apa adanya).');
} finally {
  connectionManager.status = originalStatus;
  connectionManager.sock = originalSock;
}

console.log('\n--- 5c. sendMediaMessage() menolak mediaType tidak dikenal (regresi -- masih sama seperti sebelum sticker ditambahkan) ---');
connectionManager.status = 'connected';
connectionManager.sock = {};
try {
  await connectionManager.sendMediaMessage('255490491736112@lid', 'audio', FAKE_WEBP_BUFFER, {});
  console.log('GAGAL: seharusnya melempar error karena mediaType tidak dikenal');
  process.exitCode = 1;
} catch (err) {
  assert.strictEqual(err.code, 'INVALID_MEDIA_TYPE');
  console.log('OK: sendMediaMessage() masih menolak mediaType di luar image/document/sticker (mis. audio) -- regresi Task Group sebelumnya aman.');
} finally {
  connectionManager.status = originalStatus;
  connectionManager.sock = originalSock;
}

console.log('\n=== SEMUA SIMULASI LOGIKA STICKER LULUS ===');
console.log('CATATAN: ini simulasi in-process, BUKAN pengiriman/penerimaan nyata dari WhatsApp.');
console.log('BELUM DIVERIFIKASI (perlu dicoba dengan koneksi WhatsApp nyata):');
console.log('  - Sticker sungguhan (statis & animasi) diterima dari HP customer beneran dan berhasil didekripsi lewat POST /media/download dengan media_type="sticker".');
console.log('  - Sticker WebP valid sungguhan berhasil terkirim ke WhatsApp lewat POST /send-media (type="sticker") dan benar-benar tampil sebagai sticker (bukan gambar biasa) di WhatsApp penerima.');
console.log('  - Perilaku Baileys/WhatsApp kalau WebP valid secara format tapi tidak memenuhi syarat sticker WhatsApp (ukuran/dimensi/dst) -- isValidWebp() SENGAJA cuma cek magic bytes, tidak memvalidasi ini.');

})();
