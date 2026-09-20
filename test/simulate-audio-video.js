'use strict';
/**
 * Skrip simulasi (BUKAN pengganti test nyata) untuk memvalidasi LOGIKA
 * penanganan pesan masuk audio/video/voice note (Task Group 1: Audio /
 * Voice / Video Incoming) -- pola & gaya SAMA dengan
 * simulate-lid-conversation.js/simulate-send-media.js yang sudah ada.
 *
 * Ini TIDAK menghubungi server WhatsApp sungguhan. Test end-to-end nyata
 * (kirim audio/voice note/video sungguhan dari HP) WAJIB dijalankan di
 * Windows dengan koneksi asli sebelum dianggap "selesai".
 */
const assert = require('assert');
const { ensureBaileysLoaded } = require('../src/whatsapp/baileysLoader');
const connectionManager = require('../src/whatsapp/connectionManager');
const messageStore = require('../src/whatsapp/messageStore');
const incomingBuffer = require('../src/store/incomingBuffer');

// _handleIncomingMessage() SEKARANG async (Task Group 1.5, revisi
// LID-FIRST -> PN-LATER) -- HARUS di-await, kalau tidak urutan
// messageStore.add() tidak terjamin untuk pesan jid_type='pn' (semua
// remoteJid di file ini @s.whatsapp.net).
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

console.log('--- 1. Audio biasa (tanpa caption -- WhatsApp memang tidak izinkan caption di audio) ---');
await simulateIncomingRaw('6281111000001@s.whatsapp.net', 'SIM-AUDIO-1', {
  audioMessage: { mimetype: 'audio/ogg; codecs=opus', fileLength: '12345', ptt: false },
});
let msgs = messageStore.getByChatId('6281111000001@s.whatsapp.net');
assert.strictEqual(msgs.length, 1, 'Harus ada 1 pesan tersimpan untuk audio biasa');
assert.strictEqual(msgs[0].messageType, 'audio', 'message_type harus "audio"');
assert.strictEqual(msgs[0].text, null, 'Audio tanpa caption -> text harus null');
assert.strictEqual(msgs[0].media.mimetype, 'audio/ogg; codecs=opus');
assert.strictEqual(msgs[0].media.fileLength, 12345, 'fileLength harus dikonversi ke Number');
console.log('OK: audio biasa tersimpan dengan message_type=audio, metadata mimetype/fileLength benar.');

console.log('\n--- 2. Voice note (ptt=true) TETAP dianggap audio, BUKAN tipe baru ---');
await simulateIncomingRaw('6281111000002@s.whatsapp.net', 'SIM-VOICE-1', {
  audioMessage: { mimetype: 'audio/ogg; codecs=opus', fileLength: '8000', ptt: true },
});
msgs = messageStore.getByChatId('6281111000002@s.whatsapp.net');
assert.strictEqual(msgs.length, 1);
assert.strictEqual(msgs[0].messageType, 'audio', 'Voice note (ptt=true) harus tetap message_type=audio, TIDAK ADA tipe "voice" terpisah');
console.log('OK: voice note (ptt=true) masuk sebagai audio, bukan tipe/business-logic terpisah.');

console.log('\n--- 3. Video dengan caption ---');
await simulateIncomingRaw('6281111000003@s.whatsapp.net', 'SIM-VIDEO-1', {
  videoMessage: { mimetype: 'video/mp4', fileLength: '999999', caption: 'Ini rekaman barangnya' },
});
msgs = messageStore.getByChatId('6281111000003@s.whatsapp.net');
assert.strictEqual(msgs.length, 1);
assert.strictEqual(msgs[0].messageType, 'video', 'message_type harus "video"');
assert.strictEqual(msgs[0].text, 'Ini rekaman barangnya', 'Caption video harus tersimpan sebagai text');
assert.strictEqual(msgs[0].media.mimetype, 'video/mp4');
assert.strictEqual(msgs[0].media.fileLength, 999999);
console.log('OK: video dengan caption tersimpan benar (caption -> text, metadata mimetype/fileLength benar).');

console.log('\n--- 4. Video TANPA caption ---');
await simulateIncomingRaw('6281111000004@s.whatsapp.net', 'SIM-VIDEO-2', {
  videoMessage: { mimetype: 'video/mp4', fileLength: '500000' },
});
msgs = messageStore.getByChatId('6281111000004@s.whatsapp.net');
assert.strictEqual(msgs[0].text, null, 'Video tanpa caption -> text harus null');
console.log('OK: video tanpa caption tidak memaksa text jadi string kosong/undefined, tetap null.');

console.log('\n--- 5. MIME/ukuran tidak tersedia -- tidak boleh crash, media tetap object dengan null ---');
await simulateIncomingRaw('6281111000005@s.whatsapp.net', 'SIM-AUDIO-2', {
  audioMessage: {},
});
msgs = messageStore.getByChatId('6281111000005@s.whatsapp.net');
assert.strictEqual(msgs.length, 1, 'Pesan tetap diteruskan walau mimetype/fileLength kosong (beda dari image/document yang WAJIB directPath/mediaKey)');
assert.strictEqual(msgs[0].media.mimetype, null);
assert.strictEqual(msgs[0].media.fileLength, null);
console.log('OK: audio/video tanpa mimetype/fileLength tetap diteruskan (bukan direct_path/mediaKey yang wajib seperti image/document).');

console.log('\n--- 6. Tidak tertukar dengan text/image/document ---');
await simulateIncomingRaw('6281111000006@s.whatsapp.net', 'SIM-TEXT-1', { conversation: 'Halo teks biasa' });
await simulateIncomingRaw('6281111000006@s.whatsapp.net', 'SIM-IMG-1', { imageMessage: { caption: 'foto', directPath: '/x', mediaKey: Buffer.from('k'), mimetype: 'image/jpeg', fileLength: '111' } });
await simulateIncomingRaw('6281111000006@s.whatsapp.net', 'SIM-DOC-1', { documentMessage: { caption: 'dok', directPath: '/y', mediaKey: Buffer.from('k'), mimetype: 'application/pdf', fileName: 'a.pdf', fileLength: '222' } });
await simulateIncomingRaw('6281111000006@s.whatsapp.net', 'SIM-AUD-3', { audioMessage: { mimetype: 'audio/ogg', fileLength: '333' } });
msgs = messageStore.getByChatId('6281111000006@s.whatsapp.net');
assert.strictEqual(msgs.length, 4, 'Keempat message_type harus tersimpan sebagai 4 pesan terpisah di chat yang sama');
assert.deepStrictEqual(msgs.map((m) => m.messageType), ['text', 'image', 'document', 'audio']);
console.log('OK: text/image/document/audio hidup berdampingan tanpa saling tertukar (regresi image/document aman).');

console.log('\n--- 7. Idempotency transport layer: webhook/event sama (wa_message_id sama) TIDAK boleh dobel di SQLite buffer ---');
const before = incomingBuffer.countPending();
// wa_message_id UNIK per-run (bukan literal tetap) -- incomingBuffer
// persisten ke file SQLite di disk (BUKAN in-memory), jadi ID literal
// tetap akan collide (INSERT OR IGNORE otomatis diabaikan) kalau skrip
// ini dijalankan berkali-kali, membuat assertion "before/after" salah
// walau logic-nya sendiri benar. Ini soal higiene test, bukan bug produksi.
const dupPayload = {
  messageId: 'SIM-DUP-AUDIO-' + Date.now(),
  chatId: '6281111000007@s.whatsapp.net',
  jidType: 'pn',
  sender: { jid: '6281111000007@s.whatsapp.net', phone: '6281111000007', name: 'Dup Test' },
  text: null,
  messageType: 'audio',
  media: { mimetype: 'audio/ogg', fileLength: 1000 },
  timestamp: new Date().toISOString(),
  direction: 'incoming',
};
incomingBuffer.enqueue(dupPayload);
incomingBuffer.enqueue(dupPayload); // dikirim ulang persis sama, mis. Gateway retry
const after = incomingBuffer.countPending();
assert.strictEqual(after - before, 1, 'wa_message_id yang sama dikirim 2x hanya boleh menghasilkan 1 baris pending baru (INSERT OR IGNORE + UNIQUE)');
console.log('OK: enqueue() dengan wa_message_id sama 2x hanya menghasilkan 1 baris (idempotent di level SQLite buffer).');
console.log('CATATAN: idempotency di level AuliaPos/CI4 (existsByWaMessageId) TIDAK diubah oleh Task Group ini -- logic-nya sudah generik untuk semua message_type sejak awal, tidak spesifik ke text/image/document.');

console.log('\n=== SEMUA SIMULASI LOGIKA AUDIO/VIDEO LULUS ===');
console.log('CATATAN: ini simulasi in-process, BUKAN pengiriman/penerimaan nyata dari WhatsApp.');

})();
