'use strict';
/**
 * Skrip simulasi (BUKAN pengganti test nyata) untuk memvalidasi perbaikan
 * E-01 (docs/decisions/2026-09-21-m1-ticket02-audit-enqueue.md, M1 Ticket
 * 02): pesan bertipe 'append' (dikirim ulang WhatsApp setelah Gateway
 * reconnect) sekarang diproses, bukan dibuang begitu saja seperti
 * sebelumnya. Tipe lain di luar 'notify'/'append' (mis. 'prepend' dari
 * history sync) tetap diabaikan.
 *
 * TIDAK ada koneksi WhatsApp sungguhan -- payload `messages-upsert` dibuat
 * manual, sama seperti simulate-identity-hint.js.
 */
const assert = require('assert');
const { ensureBaileysLoaded } = require('../src/whatsapp/baileysLoader');
const connectionManager = require('../src/whatsapp/connectionManager');
const messageStore = require('../src/whatsapp/messageStore');

function buildUpsertPayload(type, remoteJid, waMessageId, text) {
  return {
    type,
    messages: [
      {
        key: { remoteJid, fromMe: false, id: waMessageId },
        pushName: 'Simulasi Customer',
        message: { conversation: text },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ],
  };
}

(async () => {
  await ensureBaileysLoaded();

  connectionManager.status = 'disconnected';
  connectionManager.sock = null;

  console.log("--- 1. type='append' -> pesan diproses (tidak dibuang) ---");
  await connectionManager._onMessagesUpsert(
    buildUpsertPayload('append', '628111000101@s.whatsapp.net', 'SIM-APPEND-1', 'pesan offline'),
    connectionManager.generation
  );
  let msgs = messageStore.getByChatId('628111000101@s.whatsapp.net');
  assert.strictEqual(msgs.length, 1, "type='append' harus tersimpan, bukan dibuang");
  assert.strictEqual(msgs[0].messageId, 'SIM-APPEND-1');
  console.log('OK: pesan append tersimpan.');

  console.log("\n--- 2. type='notify' (baseline) tetap diproses seperti sebelumnya ---");
  await connectionManager._onMessagesUpsert(
    buildUpsertPayload('notify', '628111000102@s.whatsapp.net', 'SIM-NOTIFY-1', 'pesan realtime'),
    connectionManager.generation
  );
  msgs = messageStore.getByChatId('628111000102@s.whatsapp.net');
  assert.strictEqual(msgs.length, 1, "type='notify' harus tetap tersimpan");
  console.log('OK: pesan notify tersimpan (tidak ada regresi).');

  console.log("\n--- 3. type lain (mis. 'prepend', history sync) tetap diabaikan ---");
  await connectionManager._onMessagesUpsert(
    buildUpsertPayload('prepend', '628111000103@s.whatsapp.net', 'SIM-PREPEND-1', 'histori lama'),
    connectionManager.generation
  );
  msgs = messageStore.getByChatId('628111000103@s.whatsapp.net');
  assert.strictEqual(msgs.length, 0, "type='prepend' harus tetap diabaikan");
  console.log('OK: pesan prepend tetap diabaikan.');

  console.log('\nSemua simulasi type append lolos.');
  process.exit(0);
})().catch((err) => {
  console.error('SIMULASI GAGAL:', err);
  process.exit(1);
});
