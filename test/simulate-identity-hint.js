'use strict';
/**
 * Skrip simulasi (BUKAN pengganti test nyata) untuk memvalidasi LOGIKA
 * resolusi identity hint (Task Group 1.5, revisi LID-FIRST -> PN-LATER):
 * _resolveLidForPhoneJid() dan pemakaiannya di _handleIncomingMessage().
 *
 * PENTING -- KEJUJURAN: `sock.onWhatsApp()` di-MOCK di sini (tidak ada
 * koneksi WhatsApp sungguhan di lingkungan ini). Test ini membuktikan
 * LOGIKA Gateway (cache, gating jidType==='pn', non-fatal saat gagal,
 * normalisasi format) benar KETIKA onWhatsApp() mengembalikan nilai
 * tertentu -- BUKAN bukti bahwa onWhatsApp() sungguhan akan mengembalikan
 * nilai seperti itu dari server WhatsApp asli. Signature/perilaku
 * fungsi ini diverifikasi dari SOURCE CODE Baileys yang ter-install
 * (lib/Socket/chats.js + lib/WAUSync/Protocols/UsyncLIDProtocol.js),
 * TAPI belum pernah dipanggil terhadap server WhatsApp sungguhan.
 * WAJIB diverifikasi ulang begitu ada koneksi live (lihat
 * docs/aturan-bisnis-CHAT.md Section 12 di repo AuliaPos).
 */
const assert = require('assert');
const connectionManager = require('../src/whatsapp/connectionManager');
const incomingBuffer = require('../src/store/incomingBuffer');

function simulateIncoming(remoteJid, waMessageId, text) {
  return connectionManager._handleIncomingMessage({
    key: { remoteJid, fromMe: false, id: waMessageId },
    pushName: 'Simulasi Customer',
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
  });
}

(async () => {
  const originalStatus = connectionManager.status;
  const originalSock = connectionManager.sock;

  console.log('--- 1. Belum connected -> identityHint null, TIDAK crash ---');
  connectionManager.status = 'disconnected';
  connectionManager.sock = null;
  await simulateIncoming('628111000001@s.whatsapp.net', 'SIM-IDH-1', 'halo');
  let msgs = require('../src/whatsapp/messageStore').getByChatId('628111000001@s.whatsapp.net');
  assert.strictEqual(msgs[0].identityHint, null, 'Belum connected -> identityHint harus null, bukan error');
  console.log('OK: belum connected tidak crash, identityHint null.');

  console.log('\n--- 2. Connected, onWhatsApp() mengembalikan lid (SUDAH ada "@lid") ---');
  let callCount = 0;
  connectionManager.status = 'connected';
  connectionManager.sock = {
    onWhatsApp: async (jid) => {
      callCount++;
      return [{ jid, exists: true, lid: '999888777666@lid' }];
    },
  };
  await simulateIncoming('628111000002@s.whatsapp.net', 'SIM-IDH-2', 'halo 2');
  msgs = require('../src/whatsapp/messageStore').getByChatId('628111000002@s.whatsapp.net');
  assert.deepStrictEqual(msgs[0].identityHint, { lid: '999888777666@lid' });
  assert.strictEqual(callCount, 1, 'onWhatsApp() harus terpanggil tepat 1x');
  console.log('OK: identityHint.lid terisi benar dari hasil onWhatsApp().');

  console.log('\n--- 3. Cache: pesan KEDUA dari nomor yang SAMA tidak query ulang ---');
  await simulateIncoming('628111000002@s.whatsapp.net', 'SIM-IDH-2B', 'halo lagi');
  assert.strictEqual(callCount, 1, 'onWhatsApp() TIDAK BOLEH terpanggil lagi untuk nomor yang sudah di-cache');
  console.log('OK: cache in-memory bekerja, tidak query berulang ke WhatsApp.');

  console.log('\n--- 4. Format lid TANPA "@" dinormalisasi (defensif, lihat catatan kejujuran) ---');
  connectionManager.sock = {
    onWhatsApp: async (jid) => [{ jid, exists: true, lid: '555444333' }], // raw digits, TANPA @lid
  };
  await simulateIncoming('628111000003@s.whatsapp.net', 'SIM-IDH-3', 'halo 3');
  msgs = require('../src/whatsapp/messageStore').getByChatId('628111000003@s.whatsapp.net');
  assert.deepStrictEqual(msgs[0].identityHint, { lid: '555444333@lid' }, 'Format tanpa @ harus dinormalisasi jadi JID @lid');
  console.log('OK: normalisasi format defensif bekerja.');

  console.log('\n--- 5. onWhatsApp() error/throw -> non-fatal, identityHint null ---');
  connectionManager.sock = {
    onWhatsApp: async () => { throw new Error('simulasi timeout jaringan'); },
  };
  await simulateIncoming('628111000004@s.whatsapp.net', 'SIM-IDH-4', 'halo 4');
  msgs = require('../src/whatsapp/messageStore').getByChatId('628111000004@s.whatsapp.net');
  assert.strictEqual(msgs[0].identityHint, null, 'Error onWhatsApp() harus non-fatal, identityHint null');
  console.log('OK: kegagalan onWhatsApp() tidak menjatuhkan pemrosesan pesan.');

  console.log('\n--- 6. onWhatsApp() tidak ada hasil (nomor tidak terdaftar LID) -> null ---');
  connectionManager.sock = { onWhatsApp: async () => [{ jid: 'x', exists: true }] }; // tanpa field lid
  await simulateIncoming('628111000005@s.whatsapp.net', 'SIM-IDH-5', 'halo 5');
  msgs = require('../src/whatsapp/messageStore').getByChatId('628111000005@s.whatsapp.net');
  assert.strictEqual(msgs[0].identityHint, null);
  console.log('OK: tidak ada lid di hasil -> identityHint null (bukan error).');

  console.log('\n--- 7. Pesan dari @lid TIDAK PERNAH memanggil onWhatsApp() ---');
  let calledForLid = false;
  connectionManager.sock = {
    onWhatsApp: async () => { calledForLid = true; return []; },
  };
  await simulateIncoming('123456789@lid', 'SIM-IDH-6', 'halo dari lid');
  assert.strictEqual(calledForLid, false, 'onWhatsApp() TIDAK BOLEH dipanggil untuk pesan @lid (tidak ada gunanya/tidak didukung)');
  msgs = require('../src/whatsapp/messageStore').getByChatId('123456789@lid');
  assert.strictEqual(msgs[0].identityHint, null, 'Pesan @lid harus selalu identityHint=null');
  console.log('OK: @lid tidak pernah memicu query onWhatsApp() (mencegah "menebak" dari @lid).');

  console.log('\n--- 8. identity_hint_json ikut tersimpan & terbaca lewat incomingBuffer ---');
  const before = incomingBuffer.countPending();
  // wa_message_id UNIK per-run -- incomingBuffer persisten ke file SQLite
  // di disk, ID literal tetap akan collide kalau skrip dijalankan
  // berkali-kali (soal higiene test, bukan bug produksi).
  const idhMessageId = 'SIM-IDH-7-' + Date.now();
  incomingBuffer.enqueue({
    messageId: idhMessageId,
    chatId: '628111000007@s.whatsapp.net',
    jidType: 'pn',
    sender: { jid: '628111000007@s.whatsapp.net', phone: '628111000007', name: 'Test' },
    text: 'halo',
    messageType: 'text',
    media: null,
    identityHint: { lid: '111222333@lid' },
    timestamp: new Date().toISOString(),
    direction: 'incoming',
  });
  const after = incomingBuffer.countPending();
  assert.strictEqual(after - before, 1);
  const rows = incomingBuffer.getDueEvents(50).filter((r) => r.wa_message_id === idhMessageId);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(JSON.parse(rows[0].identity_hint_json), { lid: '111222333@lid' });
  console.log('OK: identity_hint_json tersimpan & terbaca benar lewat incomingBuffer (siap diteruskan ke CI4).');

  connectionManager.status = originalStatus;
  connectionManager.sock = originalSock;

  console.log('\n=== SEMUA SIMULASI IDENTITY HINT LULUS ===');
  console.log('CATATAN: onWhatsApp() di-MOCK -- BELUM diverifikasi terhadap server WhatsApp sungguhan.');
})();
