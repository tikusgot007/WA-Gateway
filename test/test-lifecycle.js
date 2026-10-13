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

// --- regresi: pesan grup + senderKeyDistributionMessage tidak boleh dibuang ---
// Payload nyata Evolution v2.3.7 (2026-10-12): pesan pertama anggota grup
// membawa kunci grup DI SAMPING teksnya.
const groupWithKeyPayload = {
  event: 'messages.upsert',
  instance: 't',
  data: {
    key: {
      remoteJid: '120363431232595303@g.us',
      fromMe: false,
      id: 'AC10EBE41779A3AECB8F429C3A2E855B',
      participant: '255490491736112@lid',
      participantAlt: '6281913500707@s.whatsapp.net',
      addressingMode: 'lid',
    },
    pushName: 'Muhammad Anshar',
    messageTimestamp: 1791748388,
    message: {
      senderKeyDistributionMessage: { groupId: '120363431232595303@g.us', axolotlSenderKeyDistributionMessage: 'AAA=' },
      messageContextInfo: {},
      conversation: 'M',
    },
  },
};
const r3 = normalizeMessagesUpsert(groupWithKeyPayload);
assert.ok(r3.ok && r3.event, 'pesan grup ber-senderKeyDistributionMessage harus diteruskan');
assert.equal(r3.event.jidType, 'group');
assert.equal(r3.event.messageType, 'text');
assert.equal(r3.event.text, 'M');
assert.equal(r3.event.sender_jid, '255490491736112@lid');

// Hanya kunci grup tanpa konten -> tetap dilewati (skip, bukan error).
const keyOnlyPayload = {
  event: 'messages.upsert',
  instance: 't',
  data: {
    key: { remoteJid: '120363431232595303@g.us', fromMe: false, id: 'SKDM-ONLY', participant: '255490491736112@lid' },
    messageTimestamp: 1791748388,
    message: { senderKeyDistributionMessage: { groupId: 'x' }, messageContextInfo: {} },
  },
};
const r4 = normalizeMessagesUpsert(keyOnlyPayload);
assert.ok(!r4.ok && r4.skip, 'senderKeyDistributionMessage tanpa konten tetap dilewati');

// --- regresi: grup legacy tanpa key.participant, sender berupa LID di pushName ---
// Payload nyata Evolution v2.3.7 (grup "AULIA ADA AAN" 628563324637-1623478602@g.us,
// 2026-10-13): key.participant KOSONG, identitas pengirim hanya LID di pushName.
// Dulu pesan ini dibuang oleh penjaga `key.participant`, sehingga grup legacy
// tidak pernah masuk Inbox.
const legacyGroupPayload = {
  event: 'messages.upsert',
  instance: 't',
  data: {
    key: { id: 'ACD5956C73F0198110AD453485A7AC4D', fromMe: false, remoteJid: '628563324637-1623478602@g.us' },
    pushName: '49800263282890',
    messageType: 'conversation',
    messageTimestamp: 1791354831,
    message: { conversation: 'Ijin tlat antar bocil ngaji', messageContextInfo: { threadId: [], messageSecret: 'x' } },
  },
};
const r5 = normalizeMessagesUpsert(legacyGroupPayload);
assert.ok(r5.ok && r5.event, 'grup legacy tanpa participant tidak boleh dibuang');
assert.equal(r5.event.jidType, 'group');
assert.equal(r5.event.sender_jid, '49800263282890@lid', 'sender_jid dipulihkan dari pushName LID');
assert.equal(r5.event.text, 'Ijin tlat antar bocil ngaji');

// Bila participant DAN pushName sama-sama tidak memberi identitas -> tetap dibuang.
const noIdentityPayload = {
  event: 'messages.upsert',
  instance: 't',
  data: {
    key: { id: 'NONE-1', fromMe: false, remoteJid: '628563324637-1623478602@g.us' },
    pushName: '',
    messageType: 'conversation',
    messageTimestamp: 1791354831,
    message: { conversation: 'halo' },
  },
};
const r6 = normalizeMessagesUpsert(noIdentityPayload);
assert.ok(!r6.ok && !r6.skip, 'pesan grup tanpa identitas pengirim apa pun tetap dibuang');

// --- regresi: balasan LID (bug 2026-10-13) --------------------------------
// Pesan 1:1 ber-identitas @lid tapi membawa nomor asli di remoteJidAlt:
// identitas efektif harus PN (@s.whatsapp.net), dan LID asli dipertahankan
// sebagai identity_hint.lid supaya CI4 merekonsiliasi conversation @lid lama.
const lidToPnPayload = {
  event: 'messages.upsert',
  instance: 't',
  data: {
    key: { id: 'LID1', fromMe: false, remoteJid: '182690745680043@lid', remoteJidAlt: '6282245422009@s.whatsapp.net' },
    pushName: 'Pelanggan 4R',
    messageTimestamp: 1791748388,
    message: { conversation: 'Cetak 4R satu lembar' },
  },
};
const r7 = normalizeMessagesUpsert(lidToPnPayload);
assert.ok(r7.ok && r7.event, 'pesan 1:1 @lid dengan remoteJidAlt harus diteruskan');
assert.equal(r7.event.chatId, '6282245422009@s.whatsapp.net', 'chatId pakai PN dari remoteJidAlt, bukan @lid');
assert.equal(r7.event.jidType, 'pn');
assert.equal(r7.event.sender.phone, '6282245422009', 'sender.phone pakai nomor asli');
assert.equal(r7.event.sender.jid, '6282245422009@s.whatsapp.net');
assert.deepEqual(r7.event.identityHint, { lid: '182690745680043@lid' }, 'LID asli dipertahankan sebagai identity_hint.lid');

// @lid TANPA remoteJidAlt PN -> tidak boleh menebak nomor; tetap @lid apa adanya.
const lidNoAltPayload = {
  event: 'messages.upsert',
  instance: 't',
  data: {
    key: { id: 'LID2', fromMe: false, remoteJid: '182690745680043@lid' },
    pushName: 'Pelanggan 4R',
    messageTimestamp: 1791748388,
    message: { conversation: 'Cetak 4R satu lembar' },
  },
};
const r8 = normalizeMessagesUpsert(lidNoAltPayload);
assert.ok(r8.ok && r8.event, '@lid tanpa alt tetap diteruskan');
assert.equal(r8.event.chatId, '182690745680043@lid', 'tanpa remoteJidAlt, chatId tetap @lid (tidak menebak)');
assert.equal(r8.event.identityHint, null, 'tanpa resolusi PN, tidak ada identity_hint');

// remoteJidAlt yang BUKAN @s.whatsapp.net tidak dipakai sebagai identitas.
const lidWeirdAltPayload = {
  event: 'messages.upsert',
  instance: 't',
  data: {
    key: { id: 'LID3', fromMe: false, remoteJid: '182690745680043@lid', remoteJidAlt: '182690745680043@lid' },
    pushName: 'Pelanggan 4R',
    messageTimestamp: 1791748388,
    message: { conversation: 'Cetak 4R satu lembar' },
  },
};
const r9 = normalizeMessagesUpsert(lidWeirdAltPayload);
assert.equal(r9.event.chatId, '182690745680043@lid', 'remoteJidAlt non-PN diabaikan');

// Grup TIDAK boleh tersentuh resolusi LID (pakai logika grup existing).
const groupLidPayload = {
  event: 'messages.upsert',
  instance: 't',
  data: {
    key: {
      id: 'GLID1',
      fromMe: false,
      remoteJid: '120363431232595303@g.us',
      remoteJidAlt: '628123456789@s.whatsapp.net',
      participant: '255490491736112@lid',
    },
    pushName: 'Anshar',
    messageTimestamp: 1791748388,
    message: { conversation: 'halo grup' },
  },
};
const r10 = normalizeMessagesUpsert(groupLidPayload);
assert.ok(r10.ok && r10.event, 'grup tetap diteruskan');
assert.equal(r10.event.chatId, '120363431232595303@g.us', 'chatId grup tidak diubah oleh remoteJidAlt');
assert.equal(r10.event.jidType, 'group');
assert.equal(r10.event.identityHint, null, 'grup tidak menghasilkan identity_hint');

console.log('gateway lifecycle tests: OK');
