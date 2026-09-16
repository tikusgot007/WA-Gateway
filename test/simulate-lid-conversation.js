'use strict';
/**
 * Skrip simulasi (BUKAN pengganti test nyata) untuk memvalidasi LOGIKA:
 * - klasifikasi jid (pn/lid/group/unknown)
 * - penyimpanan pesan + pengelompokan conversation berdasarkan chatId
 * - isolasi antar chatId
 * - penolakan sendReply saat belum connected & saat chatId tidak valid
 *
 * Ini TIDAK menghubungi server WhatsApp sungguhan. Test end-to-end nyata
 * (TEST A/B/C/D pada laporan) wajib dijalankan di Windows dengan koneksi asli.
 */
const assert = require('assert');
const { ensureBaileysLoaded } = require('../src/whatsapp/baileysLoader');
const { classifyJid, isDecodableJid, extractPhoneIfAvailable } = require('../src/whatsapp/jidUtils');
const messageStore = require('../src/whatsapp/messageStore');
const connectionManager = require('../src/whatsapp/connectionManager');

// _handleIncomingMessage() SEKARANG async (Task Group 1.5, revisi
// LID-FIRST -> PN-LATER -- lihat _resolveLidForPhoneJid()) -- helper ini
// HARUS di-await oleh pemanggil, kalau tidak urutan messageStore.add()
// tidak terjamin untuk pesan jid_type='pn' (await SELALU menunda minimal
// 1 microtask walau tidak ada operasi async nyata yang tereksekusi).
async function simulateIncoming({ remoteJid, pushName, text, messageTimestamp, fromMe = false }) {
  await connectionManager._handleIncomingMessage({
    key: { remoteJid, fromMe, id: 'SIM-' + Math.random().toString(36).slice(2, 10).toUpperCase() },
    pushName,
    message: { conversation: text },
    messageTimestamp,
  });
}

(async () => {

// Sama seperti src/app/index.js -- baileys@6.7.24 ESM-only, harus di-load
// SEKALI di awal sebelum jidUtils.js/connectionManager.js dipakai (lihat
// baileysLoader.js untuk penjelasan lengkap).
await ensureBaileysLoaded();

console.log('--- 1. classifyJid & extractPhoneIfAvailable ---');
assert.strictEqual(classifyJid('6281234567890@s.whatsapp.net'), 'pn');
assert.strictEqual(classifyJid('255490491736112@lid'), 'lid');
assert.strictEqual(classifyJid('12345-6789@g.us'), 'group');
assert.strictEqual(classifyJid('garbage'), 'unknown');
assert.strictEqual(extractPhoneIfAvailable('6281234567890@s.whatsapp.net'), '6281234567890');
assert.strictEqual(extractPhoneIfAvailable('255490491736112@lid'), null, 'LID TIDAK BOLEH menghasilkan nomor telepon');
console.log('OK: klasifikasi JID benar, LID tidak pernah dianggap nomor telepon.');

console.log('\n--- 2. Simulasi pesan masuk: PN + LID + group ---');
const now = Math.floor(Date.now() / 1000);
await simulateIncoming({ remoteJid: '6281234567890@s.whatsapp.net', pushName: 'Budi (PN)', text: 'Halo dari PN', messageTimestamp: now });
await simulateIncoming({ remoteJid: '255490491736112@lid', pushName: 'Muhammad Anshar', text: 'Halo', messageTimestamp: now + 1 });
await simulateIncoming({ remoteJid: '255490491736112@lid', pushName: 'Muhammad Anshar', text: 'Wow', messageTimestamp: now + 2 });
await simulateIncoming({ remoteJid: '999888777666@lid', pushName: 'Pelanggan Lain', text: 'Pesan dari chat B', messageTimestamp: now + 3 });

const chats = messageStore.listConversations();
console.log(JSON.stringify(chats, null, 2));
assert.strictEqual(chats.length, 3, 'Harus ada 3 conversation terpisah (1 PN + 2 LID berbeda)');

const chatA = chats.find((c) => c.chatId === '255490491736112@lid');
const chatB = chats.find((c) => c.chatId === '999888777666@lid');
const chatPn = chats.find((c) => c.chatId === '6281234567890@s.whatsapp.net');
assert.ok(chatA && chatB && chatPn, 'Ketiga chat harus ditemukan by chatId persis');
assert.strictEqual(chatA.jidType, 'lid');
assert.strictEqual(chatA.phone, null, 'Chat A (LID) tidak boleh punya phone yang ditebak dari angka LID');
assert.strictEqual(chatPn.jidType, 'pn');
assert.strictEqual(chatPn.phone, '6281234567890');
console.log('OK: 3 conversation terbentuk terpisah berdasarkan chatId, LID tidak dapat phone palsu.');

console.log('\n--- 3. Isolasi chat: pesan A tidak masuk ke B ---');
const messagesA = messageStore.getByChatId('255490491736112@lid');
const messagesB = messageStore.getByChatId('999888777666@lid');
assert.strictEqual(messagesA.length, 2, 'Chat A harus punya 2 pesan (Halo, Wow)');
assert.strictEqual(messagesB.length, 1, 'Chat B harus punya 1 pesan');
assert.ok(messagesA.every((m) => m.chatId === '255490491736112@lid'));
assert.ok(messagesB.every((m) => m.chatId === '999888777666@lid'));
console.log('OK: isolasi chat A vs chat B terjaga (TEST C, sisi penyimpanan/pembacaan).');

console.log('\n--- 4. TEST D: chat tanpa phone number tetap valid ---');
assert.strictEqual(chatA.phone, null);
assert.strictEqual(messagesA.length > 0, true, 'Conversation dengan phone=null tetap berfungsi & punya isi pesan');
console.log('OK: conversation dengan phone=null tetap valid dan bisa dibaca.');

console.log('\n--- 5. Validasi chatId untuk endpoint reply ---');
assert.strictEqual(isDecodableJid('255490491736112@lid'), true);
assert.strictEqual(isDecodableJid('6281234567890@s.whatsapp.net'), true);
assert.strictEqual(isDecodableJid('bukan-jid-valid'), false);
assert.strictEqual(isDecodableJid(''), false);
assert.strictEqual(isDecodableJid(null), false);
console.log('OK: isDecodableJid menolak string yang bukan JID.');

console.log('\n--- 6. sendReply harus ditolak saat belum connected (tanpa koneksi nyata) ---');
  try {
    await connectionManager.sendReply('255490491736112@lid', 'test balasan');
    console.log('GAGAL: seharusnya melempar error karena belum connected');
    process.exitCode = 1;
  } catch (err) {
    assert.strictEqual(err.code, 'NOT_CONNECTED');
    console.log('OK: sendReply menolak dengan error NOT_CONNECTED saat belum connect (sesuai ekspektasi, tidak ada koneksi nyata di sandbox ini).');
  }

  try {
    await connectionManager.sendReply('bukan-jid-valid', 'test');
    console.log('GAGAL: seharusnya melempar error karena chatId tidak valid');
    process.exitCode = 1;
  } catch (err) {
    assert.strictEqual(err.code, 'INVALID_CHAT_ID');
    console.log('OK: sendReply menolak chatId yang tidak valid sebelum sempat mencoba mengirim.');
  }

console.log('\n=== SEMUA SIMULASI LOGIKA LULUS ===');
console.log('CATATAN: ini simulasi in-process, BUKAN pengiriman nyata ke WhatsApp.');

})();
