'use strict';
/**
 * Skrip simulasi (BUKAN pengganti test nyata) untuk memvalidasi LOGIKA fitur
 * kirim media KELUAR (sendMediaMessage/sendMediaReply + util mediaPayload.js):
 * - decodeBase64Media: validasi ukuran & base64 tidak valid
 * - sendMediaReply: penolakan saat chatId tidak valid & saat belum connected
 * - sendMediaMessage: penolakan mediaType tidak dikenal
 *
 * Ini TIDAK menghubungi server WhatsApp sungguhan. Test end-to-end nyata
 * (kirim gambar/dokumen sungguhan lewat /api/chats/:chatId/reply-media atau
 * /send-media) WAJIB dijalankan di Windows dengan koneksi asli.
 */
const assert = require('assert');
const { ensureBaileysLoaded } = require('../src/whatsapp/baileysLoader');
const connectionManager = require('../src/whatsapp/connectionManager');
const { VALID_MEDIA_TYPES, decodeBase64Media } = require('../src/whatsapp/mediaPayload');
const config = require('../src/config');

console.log('--- 1. decodeBase64Media: validasi dasar ---');
assert.strictEqual(decodeBase64Media('').ok, false, 'base64 kosong harus ditolak');
assert.strictEqual(decodeBase64Media(undefined).ok, false, 'base64 undefined harus ditolak');
assert.strictEqual(decodeBase64Media('bukan base64 valid !!!').ok, false, 'base64 tidak valid harus ditolak');

const smallBuffer = Buffer.from('halo dari test simulasi kirim media');
const decodedSmall = decodeBase64Media(smallBuffer.toString('base64'));
assert.strictEqual(decodedSmall.ok, true, 'base64 valid & di bawah limit harus diterima');
assert.ok(decodedSmall.buffer.equals(smallBuffer), 'buffer hasil decode harus sama persis dengan aslinya');
console.log('OK: decodeBase64Media menerima base64 valid & menolak yang tidak valid/kosong.');

console.log('\n--- 2. decodeBase64Media: batas ukuran maksimum ---');
const tooLargeBuffer = Buffer.alloc(config.maxMediaUploadBytes + 1024, 1);
const decodedTooLarge = decodeBase64Media(tooLargeBuffer.toString('base64'));
assert.strictEqual(decodedTooLarge.ok, false, 'media di atas MAX_MEDIA_UPLOAD_MB harus ditolak');
assert.ok(/batas maksimum/.test(decodedTooLarge.reason), 'alasan penolakan harus menyebut batas maksimum');
console.log(`OK: media > ${Math.round(config.maxMediaUploadBytes / 1024 / 1024)}MB ditolak sebelum dikirim ke Baileys.`);

console.log('\n--- 3. VALID_MEDIA_TYPES konsisten dengan yang didukung media MASUK ---');
// 'sticker' ditambahkan belakangan (lihat test/simulate-sticker.js) --
// dicek di sini juga supaya kalau ada yang tidak sengaja menghapusnya lagi,
// test manapun yang jalan duluan akan menangkapnya.
assert.deepStrictEqual(VALID_MEDIA_TYPES, ['image', 'document', 'sticker']);
console.log('OK: jenis media keluar (image/document/sticker) sama dengan yang didukung untuk media masuk.');

console.log('\n--- 4. sendMediaReply harus ditolak saat chatId tidak valid (sebelum cek koneksi) ---');
(async () => {
  // Sama seperti src/app/index.js -- baileys@6.7.24 ESM-only, harus di-load
  // SEKALI di awal sebelum connectionManager.js dipakai (lihat
  // baileysLoader.js untuk penjelasan lengkap).
  await ensureBaileysLoaded();

  try {
    await connectionManager.sendMediaReply('bukan-jid-valid', 'image', smallBuffer, {});
    console.log('GAGAL: seharusnya melempar error karena chatId tidak valid');
    process.exitCode = 1;
  } catch (err) {
    assert.strictEqual(err.code, 'INVALID_CHAT_ID');
    console.log('OK: sendMediaReply menolak chatId yang tidak valid sebelum sempat mencoba mengirim.');
  }

  console.log('\n--- 5. sendMediaReply harus ditolak saat belum connected (tanpa koneksi nyata) ---');
  try {
    await connectionManager.sendMediaReply('255490491736112@lid', 'image', smallBuffer, {});
    console.log('GAGAL: seharusnya melempar error karena belum connected');
    process.exitCode = 1;
  } catch (err) {
    assert.strictEqual(err.code, 'NOT_CONNECTED');
    console.log('OK: sendMediaReply menolak dengan error NOT_CONNECTED saat belum connect (sesuai ekspektasi, tidak ada koneksi nyata di sandbox ini).');
  }

  console.log('\n--- 6. sendMediaMessage harus menolak mediaType yang tidak dikenal ---');
  // Palsukan status "connected" sementara SUPAYA validasi mediaType (yang
  // memang baru dicek SETELAH cek koneksi di sendMediaMessage) benar-benar
  // teruji, tanpa perlu socket Baileys sungguhan.
  const originalStatus = connectionManager.status;
  const originalSock = connectionManager.sock;
  connectionManager.status = 'connected';
  connectionManager.sock = {};
  try {
    await connectionManager.sendMediaMessage('255490491736112@lid', 'audio', smallBuffer, {});
    console.log('GAGAL: seharusnya melempar error karena mediaType tidak dikenal');
    process.exitCode = 1;
  } catch (err) {
    assert.strictEqual(err.code, 'INVALID_MEDIA_TYPE');
    console.log('OK: sendMediaMessage menolak mediaType di luar image/document (mis. audio).');
  } finally {
    connectionManager.status = originalStatus;
    connectionManager.sock = originalSock;
  }

  console.log('\n=== SEMUA SIMULASI LOGIKA KIRIM MEDIA LULUS ===');
  console.log('CATATAN: ini simulasi in-process, BUKAN pengiriman nyata ke WhatsApp.');
})();
