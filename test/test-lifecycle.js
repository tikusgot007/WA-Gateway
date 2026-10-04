'use strict';

/**
 * Test TODO-F7 (pure, tanpa DB/network): deteksi penanda lifecycle "diedit"
 * dari payload MESSAGES_UPSERT `secretEncryptedMessage`, plus regresi bahwa
 * pesan biasa tetap menjadi event normal.
 *
 * Jalankan: node test/test-lifecycle.js
 */
const assert = require('node:assert/strict');
const { normalizeMessagesUpsert, extractEditTarget } = require('../src/evolution/normalize');

// --- extractEditTarget -----------------------------------------------------
assert.equal(
  extractEditTarget({ secretEncryptedMessage: { secretEncType: 2, targetMessageKey: { id: 'ORIG' } } }),
  'ORIG',
  'secretEncType=2 (MESSAGE_EDIT) -> wa_message_id pesan asli'
);
assert.equal(
  extractEditTarget({ secretEncryptedMessage: { secretEncType: 1, targetMessageKey: { id: 'X' } } }),
  null,
  'secretEncType lain BUKAN edit'
);
assert.equal(
  extractEditTarget({ secretEncryptedMessage: { secretEncType: 2, targetMessageKey: {} } }),
  null,
  'tanpa targetMessageKey.id -> null'
);
assert.equal(extractEditTarget({ conversation: 'hi' }), null, 'pesan biasa -> null');

// --- normalizeMessagesUpsert: edit -> lifecycle (BUKAN baris pesan) ---------
const editPayload = {
  event: 'messages.upsert',
  instance: 't',
  data: {
    key: { remoteJid: '6281@s.whatsapp.net', fromMe: false, id: 'EDIT1' },
    messageTimestamp: 1791104769,
    message: {
      messageContextInfo: {},
      secretEncryptedMessage: { secretEncType: 2, targetMessageKey: { id: 'ORIG1' } },
    },
  },
};
const r = normalizeMessagesUpsert(editPayload);
assert.ok(r.ok, 'edit harus normalize ok');
assert.ok(r.lifecycle, 'edit harus menghasilkan lifecycle');
assert.equal(r.lifecycle.event, 'edited');
assert.equal(r.lifecycle.targetWaMessageId, 'ORIG1');
assert.equal(r.lifecycle.chatId, '6281@s.whatsapp.net');
assert.equal(r.event, undefined, 'edit TIDAK boleh menghasilkan event pesan (tanpa baris noise)');

// --- regresi: pesan teks biasa tetap menjadi event normal -------------------
const textPayload = {
  event: 'messages.upsert',
  instance: 't',
  data: {
    key: { remoteJid: '6281@s.whatsapp.net', fromMe: false, id: 'MSG1' },
    messageTimestamp: 1791104769,
    message: { conversation: 'halo' },
  },
};
const r2 = normalizeMessagesUpsert(textPayload);
assert.ok(r2.ok && r2.event && !r2.lifecycle, 'pesan teks tetap event normal');
assert.equal(r2.event.messageType, 'text');

console.log('gateway lifecycle tests: OK');
