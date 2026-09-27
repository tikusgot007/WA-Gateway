'use strict';
/**
 * Skrip simulasi Balas Pesan (Tahap 3, WA-Gateway):
 *   - kontrak outbound `quoted` di POST /send DAN POST /send-media (objek pesan
 *     Baileys minimal, semantik `fromMe`, F-C malformed -> tetap terkirim),
 *   - indikator `quote_applied` pada respons (termasuk replay idempotensi),
 *   - ekstraksi kutipan arah MASUK (`contextInfo`) -> payload webhook ke CI4.
 *
 * TIDAK menghubungi server WhatsApp: `sock.sendMessage()` di-stub. Pengujian
 * nyata reply native (`AC-002`, plan TASK-004) tetap WAJIB manual dari HP uji --
 * lihat catatan di akhir file.
 *
 * Jalankan: node test/simulate-reply-quote.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// HARUS sebelum modul src/ mana pun di-require: config dibaca sekali saat load,
// dan singleton store langsung membuka SQLITE_PATH saat modulnya dimuat.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-reply-quote-'));
process.env.SQLITE_PATH = path.join(tmpRoot, 'gateway.sqlite');
process.env.CI4_BASE_URL = '';
process.env.CI4_GATEWAY_TOKEN = 'token-uji';

const assert = require('assert');
const express = require('express');
const logger = require('../src/logging');
const { ensureBaileysLoaded } = require('../src/whatsapp/baileysLoader');
const connectionManager = require('../src/whatsapp/connectionManager');
const incomingBuffer = require('../src/store/incomingBuffer');
const messageStore = require('../src/whatsapp/messageStore');
const outgoingOperations = require('../src/store/outgoingOperations');
const { deliverOne } = require('../src/delivery/incomingDelivery');

// Tangkap log (tidak dicetak) supaya bisa memastikan degradasi F-C memang
// "berbunyi" (di-log), bukan senyap.
const logs = [];
for (const level of ['info', 'warn', 'error', 'debug']) {
  logger[level] = (message, meta = null) => {
    logs.push({ level, message, meta });
  };
}
const warnCount = (needle) => logs.filter((l) => l.level === 'warn' && l.message.includes(needle)).length;

const OWN_JID = '628111000111@s.whatsapp.net'; // JID akun-bot (sock.user.id)
const CHAT = '6281234567890@s.whatsapp.net';
const SENDER = '628999888777@s.whatsapp.net';
const IN_CHAT = '255490491736112@lid';

let sentCalls = [];
const originalStatus = connectionManager.status;
const originalSock = connectionManager.sock;

// Stub socket: mencatat opsi yang diterima sendMessage() dan mengembalikan bentuk
// ala Baileys. ID pesan tetap lewat _registerOwnSentId() seperti jalur asli.
function installSock() {
  sentCalls = [];
  connectionManager.status = 'connected';
  connectionManager.sock = {
    user: { id: OWN_JID },
    sendMessage: async (jid, content, options) => {
      sentCalls.push({ jid, content, options });
      return { key: { id: `WA-${sentCalls.length}` }, message: content };
    },
  };
}

let server;
let baseUrl;

async function startGateway() {
  const ci4Routes = require('../src/api/ci4Routes');
  const app = express();
  app.use(ci4Routes);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stopGateway() {
  if (server) await new Promise((resolve) => server.close(resolve));
}

async function post(route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-uji' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// Pesan masuk tiruan (tanpa socket WhatsApp nyata).
async function simulateIncoming(waMessageId, message) {
  await connectionManager._handleIncomingMessage({
    key: { remoteJid: IN_CHAT, fromMe: false, id: waMessageId },
    pushName: 'Pelanggan Uji',
    message,
    messageTimestamp: Math.floor(Date.now() / 1000),
  });
}

const lastCall = () => sentCalls[sentCalls.length - 1];

const findRow = (waMessageId) =>
  incomingBuffer.getDueEvents(500).find((r) => r.wa_message_id === waMessageId);

const captureDelivery = async (row) => {
  let captured = null;
  await deliverOne(row, {
    postToCI4: async (route, body) => {
      captured = { route, body };
      return { ok: true, status: 200, json: { status: 'success' } };
    },
  });
  return captured;
};

const section = (title) => console.log(`\n--- ${title} ---`);

(async () => {
  await ensureBaileysLoaded();
  installSock();
  await startGateway();

  // ===================== OUTBOUND: /send (teks) =====================

  section('A1. /send berkutipan (fromMe:false) -> quote_applied:true, objek Baileys benar');
  let res = await post('/send', {
    chat_id: CHAT,
    text: 'Baik, akan saya proseskan.',
    quoted: {
      wa_message_id: '3EB0SRC01',
      sender_jid: SENDER,
      message_type: 'text',
      fromMe: false,
      text: 'Kapan pesanan saya dikirim?',
    },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.quote_applied, true, 'quoted valid -> quote_applied:true');
  assert.strictEqual(sentCalls.length, 1);
  assert.deepStrictEqual(lastCall().options.quoted, {
    key: { id: '3EB0SRC01', remoteJid: CHAT, fromMe: false, participant: SENDER },
    message: { conversation: 'Kapan pesanan saya dikirim?' },
  });
  assert.deepStrictEqual(lastCall().content, { text: 'Baik, akan saya proseskan.' });
  console.log('OK: quoted diteruskan sebagai objek WAMessage minimal (REQ-002).');

  section('A2. Sumber outgoing (fromMe:true) -> participant = JID akun-bot');
  res = await post('/send', {
    chat_id: CHAT,
    text: 'Ini balasan saya.',
    quoted: { wa_message_id: '3EB0SRC02', message_type: 'text', fromMe: true, text: 'Halo' },
  });
  assert.strictEqual(res.body.quote_applied, true);
  assert.deepStrictEqual(lastCall().options.quoted.key, {
    id: '3EB0SRC02',
    remoteJid: CHAT,
    fromMe: true,
    participant: OWN_JID,
  });
  console.log('OK: fromMe:true -> key.participant diisi JID akun-bot sendiri (REQ-002).');

  section('A3. fromMe absent / JSON null identik false');
  res = await post('/send', {
    chat_id: CHAT,
    text: 'x',
    quoted: { wa_message_id: '3EB0SRC03', message_type: 'text', text: 'a' },
  });
  assert.strictEqual(res.body.quote_applied, true);
  assert.strictEqual(lastCall().options.quoted.key.fromMe, false);
  assert.ok(
    !('participant' in lastCall().options.quoted.key),
    'incoming privat tanpa sender_jid -> participant tidak diisi'
  );
  res = await post('/send', {
    chat_id: CHAT,
    text: 'x',
    quoted: { wa_message_id: '3EB0SRC04', message_type: 'text', fromMe: null, text: 'a' },
  });
  assert.strictEqual(res.body.quote_applied, true);
  assert.strictEqual(lastCall().options.quoted.key.fromMe, false, 'JSON null diperlakukan false');
  console.log('OK: absent/null -> false.');

  section('A4. /send tanpa quoted -> respons & pengiriman TIDAK berubah');
  res = await post('/send', { chat_id: CHAT, text: 'tanpa kutipan' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.ok(!('quote_applied' in res.body), 'tanpa quoted -> quote_applied tidak dikirim');
  assert.strictEqual(lastCall().options.quoted, undefined);
  console.log('OK: perilaku lama tidak berubah.');

  section('A5. F-C: quoted bukan objek -> tetap terkirim, quote_applied:false, di-log');
  const beforeWarn = warnCount('[SEND] kutipan');
  res = await post('/send', { chat_id: CHAT, text: 'tetap terkirim', quoted: 'bukan-objek' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.quote_applied, false);
  assert.strictEqual(lastCall().options.quoted, undefined, 'quote malformed tidak diteruskan ke Baileys');
  assert.ok(warnCount('[SEND] kutipan') > beforeWarn, 'kegagalan pembentukan quote harus di-log');
  console.log('OK: CON-001 dipatuhi, kegagalan berbunyi.');

  section('A6. F-C: wa_message_id kosong / tipe tak dikenal -> tetap terkirim, quote_applied:false');
  res = await post('/send', {
    chat_id: CHAT,
    text: 'x',
    quoted: { wa_message_id: '   ', message_type: 'text', text: 'a' },
  });
  assert.strictEqual(res.body.quote_applied, false);
  assert.strictEqual(lastCall().options.quoted, undefined);

  res = await post('/send', {
    chat_id: CHAT,
    text: 'x',
    quoted: { wa_message_id: '3EB0TIPE', message_type: 'lokasi' },
  });
  assert.strictEqual(res.body.quote_applied, false);
  assert.strictEqual(lastCall().options.quoted, undefined);
  console.log('OK.');

  section('A7. Idempotensi: replay mempertahankan quote_applied tanpa kirim ulang');
  const quotedA7 = {
    wa_message_id: '3EB0SRC07',
    sender_jid: SENDER,
    message_type: 'text',
    text: 'sumber',
  };
  res = await post('/send', {
    chat_id: CHAT,
    text: 'berkutipan idempoten',
    operation_id: 'OP-Q-1',
    quoted: quotedA7,
  });
  assert.strictEqual(res.body.quote_applied, true);
  assert.strictEqual(res.body.replayed, false);
  assert.strictEqual(outgoingOperations.get('OP-Q-1').quote_applied, 1, 'indikator tersimpan di baris operasi');
  const sendsAfterFirst = sentCalls.length;
  const replay = await post('/send', {
    chat_id: CHAT,
    text: 'berkutipan idempoten',
    operation_id: 'OP-Q-1',
    quoted: quotedA7,
  });
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.body.replayed, true);
  assert.strictEqual(replay.body.quote_applied, true, 'replay melaporkan quote_applied tersimpan');
  assert.strictEqual(sentCalls.length, sendsAfterFirst, 'replay tidak mengirim ulang');
  console.log('OK: quote_applied benar pada jalur replay (REQ-003).');

  // ===================== OUTBOUND: /send-media =====================

  const IMG = Buffer.from('ISI-GAMBAR-UJI-QUOTE');

  section('B1. /send-media berkutipan -> quote_applied:true (REQ-001a)');
  res = await post('/send-media', {
    chat_id: CHAT,
    media_type: 'image',
    media_base64: IMG.toString('base64'),
    mimetype: 'image/jpeg',
    caption: 'contoh',
    quoted: {
      wa_message_id: '3EB0M-1',
      sender_jid: SENDER,
      message_type: 'image',
      fromMe: false,
      media_type: 'image',
    },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.quote_applied, true);
  assert.deepStrictEqual(lastCall().options.quoted.message, { imageMessage: {} });
  assert.deepStrictEqual(lastCall().options.quoted.key, {
    id: '3EB0M-1',
    remoteJid: CHAT,
    fromMe: false,
    participant: SENDER,
  });
  console.log('OK: balas-dengan-media berkutipan diterapkan.');

  section('B2. /send-media tanpa quoted -> tidak ada quote_applied');
  res = await post('/send-media', {
    chat_id: CHAT,
    media_type: 'image',
    media_base64: IMG.toString('base64'),
    mimetype: 'image/jpeg',
  });
  assert.ok(!('quote_applied' in res.body));
  assert.strictEqual(lastCall().options.quoted, undefined);
  console.log('OK.');

  section('B3. F-C jalur media: quoted malformed -> media tetap terkirim, quote_applied:false');
  res = await post('/send-media', {
    chat_id: CHAT,
    media_type: 'image',
    media_base64: IMG.toString('base64'),
    mimetype: 'image/jpeg',
    quoted: { wa_message_id: '', message_type: 'image' },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.quote_applied, false);
  assert.strictEqual(lastCall().options.quoted, undefined);
  console.log('OK.');

  section('B4. /send-media replay idempoten mempertahankan quote_applied');
  const quotedB4 = { wa_message_id: '3EB0M-R', sender_jid: SENDER, message_type: 'text', text: 's' };
  res = await post('/send-media', {
    chat_id: CHAT,
    media_type: 'image',
    media_base64: IMG.toString('base64'),
    mimetype: 'image/jpeg',
    operation_id: 'OP-QM-1',
    quoted: quotedB4,
  });
  assert.strictEqual(res.body.quote_applied, true);
  const mSends = sentCalls.length;
  const mReplay = await post('/send-media', {
    chat_id: CHAT,
    media_type: 'image',
    media_base64: IMG.toString('base64'),
    mimetype: 'image/jpeg',
    operation_id: 'OP-QM-1',
    quoted: quotedB4,
  });
  assert.strictEqual(mReplay.body.replayed, true);
  assert.strictEqual(mReplay.body.quote_applied, true);
  assert.strictEqual(sentCalls.length, mSends);
  console.log('OK.');

  // ===================== INBOUND: ekstraksi contextInfo =====================

  section('C1. Kutipan MASUK (contextInfo teks) -> buffer + payload webhook');
  const inId = `SIM-IN-QUOTE-${Date.now()}`;
  await simulateIncoming(inId, {
    extendedTextMessage: {
      text: 'Baik kalau begitu, saya tunggu ya',
      contextInfo: {
        stanzaId: '3EB0ORIG-1',
        participant: SENDER,
        quotedMessage: { conversation: 'Kapan pesanan saya dikirim?' },
      },
    },
  });
  const row = findRow(inId);
  assert.ok(row, 'baris antrean pesan masuk harus ada');
  const expectedQuote = {
    wa_message_id: '3EB0ORIG-1',
    sender_jid: SENDER,
    snippet: 'Kapan pesanan saya dikirim?',
  };
  assert.deepStrictEqual(JSON.parse(row.quoted_json), expectedQuote);
  const stored = messageStore.getByChatId(IN_CHAT).find((m) => m.messageId === inId);
  assert.deepStrictEqual(stored.quoted, expectedQuote);
  const delivered = await captureDelivery(row);
  assert.strictEqual(delivered.route, '/api/inbox/gateway/messages');
  assert.deepStrictEqual(delivered.body.quoted, expectedQuote);
  console.log('OK: quoted terkirim pada payload webhook (REQ-010).');

  section('C2. Pesan masuk TANPA kutipan -> payload tidak berubah (tanpa field quoted)');
  const inId2 = `SIM-IN-NOQUOTE-${Date.now()}`;
  await simulateIncoming(inId2, { conversation: 'Halo tanpa kutipan' });
  const row2 = findRow(inId2);
  assert.ok(row2);
  assert.ok(row2.quoted_json === null || row2.quoted_json === undefined, 'tanpa kutipan -> quoted_json NULL');
  const delivered2 = await captureDelivery(row2);
  assert.ok(!('quoted' in delivered2.body), 'field quoted tidak boleh ada saat tidak ada kutipan');
  console.log('OK.');

  section('C3. Balasan masuk ke MEDIA -> snippet label jenis media ("[Foto]")');
  const inId3 = `SIM-IN-MEDIA-${Date.now()}`;
  await simulateIncoming(inId3, {
    imageMessage: {
      directPath: '/v/t62.999/in-quote-img',
      mediaKey: Buffer.from('in-media-key'),
      mimetype: 'image/jpeg',
      fileLength: '1234',
      fileSha256: Buffer.from('in-media-sha'),
      contextInfo: {
        stanzaId: '3EB0ORIG-IMG',
        participant: SENDER,
        quotedMessage: { imageMessage: { directPath: '/v/x' } },
      },
    },
  });
  const row3 = findRow(inId3);
  assert.ok(row3);
  assert.deepStrictEqual(JSON.parse(row3.quoted_json), {
    wa_message_id: '3EB0ORIG-IMG',
    sender_jid: SENDER,
    snippet: '[Foto]',
  });
  console.log('OK.');

  section('C4. Snippet teks panjang dipotong (200 karakter + ellipsis)');
  const inId4 = `SIM-IN-LONG-${Date.now()}`;
  await simulateIncoming(inId4, {
    extendedTextMessage: {
      text: 'ok',
      contextInfo: { stanzaId: '3EB0LONG', quotedMessage: { conversation: 'A'.repeat(300) } },
    },
  });
  const snippet = JSON.parse(findRow(inId4).quoted_json).snippet;
  assert.strictEqual(snippet.length, 201, '200 karakter + 1 ellipsis');
  assert.ok(snippet.endsWith('…'));
  console.log('OK.');

  console.log('\nSEMUA ASSERT LULUS (0 gagal).');
  console.log('CATATAN: ini simulasi in-process, BUKAN pengiriman/penerimaan WhatsApp nyata.');
  console.log('AC-002 (balasan tampil sebagai reply native di WhatsApp penerima) dan AC-008 (kutipan masuk dari HP asli) WAJIB diuji manual dari HP uji sebelum plan ditutup.');
})()
  .catch((err) => {
    console.error('GAGAL:', err);
    console.error('Log terakhir:', logs.slice(-8));
    process.exitCode = 1;
  })
  .finally(async () => {
    connectionManager.status = originalStatus;
    connectionManager.sock = originalSock;
    try {
      await stopGateway();
    } catch (err) {
      // sudah berhenti
    }
    try {
      outgoingOperations.close();
    } catch (err) {
      // sudah tertutup
    }
    try {
      incomingBuffer.close();
    } catch (err) {
      // sudah tertutup
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (err) {
      console.warn(`Peringatan: folder temp tidak terhapus (${tmpRoot}): ${err.message}`);
    }
  });
