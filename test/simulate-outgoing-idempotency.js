'use strict';
/**
 * Skrip simulasi M1 Wave 2 TASK-003 (jalur teks; TASK-004 menambah jalur media):
 * idempotensi POST /send lewat `operation_id`. Router ci4Routes.js dipasang di
 * server express nyata pada port acak, tetapi Baileys TIDAK dipakai:
 * connectionManager.sendReply/isConnected di-stub, sehingga kegagalan dan
 * kiriman yang menggantung bisa dibuat deterministik.
 *
 * Mencakup AC-019 (operation_id tidak valid), AC-020 (in_flight tercatat SEBELUM
 * sendMessage), AC-021 (replay), AC-022 (OPERATION_ID_REUSED), AC-023 (bertahan
 * setelah restart), AC-024 (field respons), AC-025/AC-044 (tanpa operation_id),
 * serta cabang state machine yang sudah ada di service (stub-only, lihat A-2).
 *
 * Semua data di folder temp (SQLITE_PATH); TIDAK PERNAH menyentuh
 * data/gateway.sqlite produksi (TEST-010).
 * Jalankan: node test/simulate-outgoing-idempotency.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// HARUS sebelum modul src/ mana pun di-require: config dibaca sekali saat load,
// dan singleton store langsung membuka SQLITE_PATH saat modulnya dimuat.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-outgoing-idem-'));
process.env.SQLITE_PATH = path.join(tmpRoot, 'gateway.sqlite');
process.env.CI4_BASE_URL = '';
process.env.CI4_GATEWAY_TOKEN = 'token-uji';

const assert = require('assert');
const express = require('express');
const logger = require('../src/logging');
const { ensureBaileysLoaded } = require('../src/whatsapp/baileysLoader');
const connectionManager = require('../src/whatsapp/connectionManager');
const incomingBuffer = require('../src/store/incomingBuffer'); // ikut terbuka lewat connectionManager; ditutup saat cleanup

// --- tangkap semua log (dan tidak mencetaknya) untuk pemindaian SEC-001 / hitungan warn ---
// Bawaan: log ditangkap dan TIDAK dicetak. Dengan OUTGOING_TEST_LOG_PASSTHROUGH=1 log
// juga diteruskan ke logger asli (pino -> berkas LOG_FOLDER), dipakai
// test/check-outgoing-log-scan.js untuk memindai berkas log sungguhan (AC-039).
const logs = [];
const passthrough = process.env.OUTGOING_TEST_LOG_PASSTHROUGH === '1';
for (const level of ['info', 'warn', 'error', 'debug']) {
  const original = logger[level];
  logger[level] = (message, meta) => {
    logs.push({ level, message, meta });
    if (passthrough) original(message, meta);
  };
}
const logText = () => JSON.stringify(logs);

// --- stub Baileys ---
const CHAT = '628111222333@s.whatsapp.net';
const stub = {
  connected: true,
  calls: [], // { chatId, text, stateAtCall }
  impl: null, // (chatId, text) => Promise<{messageId, timestamp}>; null = sukses default
  seq: 0,
};
connectionManager.isConnected = () => stub.connected;
connectionManager.sendReply = async (chatId, text) => {
  const call = { chatId, text };
  stub.calls.push(call);
  if (stub.onCall) stub.onCall(call);
  if (stub.impl) return stub.impl(chatId, text);
  stub.seq += 1;
  return { messageId: `WA-${stub.seq}`, timestamp: `2026-09-24T10:00:0${stub.seq % 10}.000Z` };
};
// Stub jalur media: mencatat panggilan (termasuk buffer hasil decode) dan mengembalikan
// mediaRef ala Baileys (directPath/mediaKeyBase64), sama seperti sendMediaReply() asli.
stub.mediaCalls = [];
stub.mediaImpl = null;
stub.onMediaCall = null;
connectionManager.sendMediaReply = async (chatId, mediaType, buffer, options) => {
  const call = { chatId, mediaType, buffer, options };
  stub.mediaCalls.push(call);
  if (stub.onMediaCall) stub.onMediaCall(call);
  if (stub.mediaImpl) return stub.mediaImpl(call);
  stub.seq += 1;
  return {
    messageId: `WAM-${stub.seq}`,
    timestamp: `2026-09-24T11:00:0${stub.seq % 10}.000Z`,
    mediaRef: { directPath: `/v/t62/${stub.seq}`, mediaKeyBase64: 'a2V5LWJhc2U2NA==' },
  };
};
function resetStub() {
  stub.connected = true;
  stub.calls = [];
  stub.impl = null;
  stub.onCall = null;
  stub.mediaCalls = [];
  stub.mediaImpl = null;
  stub.onMediaCall = null;
}

// --- server nyata di port acak; restart = muat ulang modul store/service/router ---
let server;
let baseUrl;
let store;

const REQUIRE_PATHS = [
  '../src/store/outgoingOperations',
  '../src/delivery/outgoingOperationService',
  '../src/api/ci4Routes',
];

async function startGateway() {
  store = require('../src/store/outgoingOperations');
  const ci4Routes = require('../src/api/ci4Routes');
  const app = express();
  app.use(ci4Routes);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stopGateway() {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  REQUIRE_PATHS.forEach((p) => delete require.cache[require.resolve(p)]);
}

async function post(route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-uji' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const sendText = (extra = {}) => post('/send', { chat_id: CHAT, text: 'halo', ...extra });
const IMG = Buffer.from('ISI-GAMBAR-UJI-AAAA');
const sendMedia = (extra = {}) => post('/send-media', {
  chat_id: CHAT,
  media_type: 'image',
  media_base64: IMG.toString('base64'),
  mimetype: 'image/jpeg',
  caption: 'foto produk',
  ...extra,
});
const rowCount = () => store.db.prepare('SELECT COUNT(*) AS n FROM outgoing_operations').get().n;
const section = (title) => console.log(`\n--- ${title} ---`);

(async () => {
  // isDecodableJid() memakai jidDecode milik Baileys (ESM-only) -- harus dimuat sekali di awal.
  await ensureBaileysLoaded();
  await startGateway();

  section('AC-019: operation_id tidak valid -> 400, tanpa baris, sendMessage tidak dipanggil');
  const invalidIds = [
    ['65 karakter (batas atas + 1)', 'a'.repeat(65)],
    ['karakter di luar pola (spasi)', 'ada spasi'],
    ['karakter di luar pola (/)', 'a/b'],
    ['string kosong', ''],
    ['bukan string (angka)', 12345],
    ['bukan string (objek)', { id: 1 }],
  ];
  for (const [label, value] of invalidIds) {
    resetStub();
    const res = await sendText({ operation_id: value });
    assert.strictEqual(res.status, 400, label);
    assert.strictEqual(res.body.error_code, 'INVALID_OPERATION_ID', label);
    assert.strictEqual(res.body.success, false, label);
    assert.strictEqual(stub.calls.length, 0, `${label}: sendReply TIDAK boleh dipanggil`);
  }
  assert.strictEqual(rowCount(), 0, 'tidak ada baris operasi dari operation_id tidak valid');
  console.log('OK: 6 bentuk tidak valid ditolak.');

  section('AC-019 (batas): 64 karakter dan karakter . _ : - diterima');
  resetStub();
  const id64 = 'A'.repeat(20) + '.' + '_'.repeat(10) + ':' + '-'.repeat(10) + '9'.repeat(22);
  assert.strictEqual(id64.length, 64);
  let res = await sendText({ operation_id: id64 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.operation_id, id64);
  console.log('OK: 64 karakter valid diterima.');

  section('Validasi payload lama tetap berlaku dan TIDAK meninggalkan baris (A-7)');
  resetStub();
  const before = rowCount();
  res = await post('/send', { chat_id: 'bukan-jid', text: 'x', operation_id: 'OP-BAD-CHAT' });
  assert.strictEqual(res.body.error_code, 'INVALID_CHAT_ID');
  res = await post('/send', { chat_id: CHAT, text: '   ', operation_id: 'OP-BAD-TEXT' });
  assert.strictEqual(res.body.error_code, 'INVALID_TEXT');
  res = await post('/send', { chat_id: CHAT, text: 'x'.repeat(4097), operation_id: 'OP-LONG' });
  assert.strictEqual(res.body.error_code, 'TEXT_TOO_LONG');
  assert.strictEqual(rowCount(), before, 'payload ditolak -> tidak ada baris in_flight');
  assert.strictEqual(stub.calls.length, 0);
  console.log('OK');

  section('AC-020: baris in_flight sudah tersimpan SEBELUM sendMessage dipanggil (kirim menggantung)');
  resetStub();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let stateAtCall = null;
  stub.onCall = () => {
    stateAtCall = store.get('OP-HANG');
  };
  stub.impl = async () => {
    await gate;
    return { messageId: 'WA-HANG', timestamp: '2026-09-24T10:05:00.000Z' };
  };
  const hanging = sendText({ operation_id: 'OP-HANG' });
  while (stub.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
  assert.ok(stateAtCall, 'baris operasi HARUS sudah ada saat sendReply terpanggil');
  assert.strictEqual(stateAtCall.state, 'in_flight');
  assert.strictEqual(stateAtCall.attempts, 1);
  assert.strictEqual(stateAtCall.kind, 'text');
  assert.strictEqual(stateAtCall.chat_id, CHAT);
  assert.strictEqual(stateAtCall.wa_message_id, null);
  console.log('OK: in_flight (attempts=1) tercatat sebelum kirim.');

  section('Permintaan kedua saat kiriman masih menggantung -> 409 SEND_IN_PROGRESS, tanpa kirim kedua');
  res = await sendText({ operation_id: 'OP-HANG' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error_code, 'SEND_IN_PROGRESS');
  assert.strictEqual(res.body.state, 'in_flight');
  assert.strictEqual(res.body.success, false);
  assert.ok(/belum pasti/i.test(res.body.message), 'pesan menyatakan hasil belum pasti');
  assert.strictEqual(stub.calls.length, 1, 'sendReply tetap 1 kali');
  release();
  const first = await hanging;
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.state, 'sent');
  assert.strictEqual(store.get('OP-HANG').state, 'sent');
  console.log('OK');

  section('AC-021: permintaan ulang (payload identik) setelah sent -> 200 replayed:true, tanpa kirim');
  resetStub();
  res = await sendText({ operation_id: 'OP-R1' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.replayed, false);
  const original = res.body;
  assert.strictEqual(stub.calls.length, 1);
  const replay = await sendText({ operation_id: 'OP-R1' });
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.body.replayed, true);
  assert.strictEqual(replay.body.state, 'sent');
  assert.strictEqual(replay.body.success, true);
  assert.strictEqual(replay.body.wa_message_id, original.wa_message_id, 'wa_message_id sama');
  assert.strictEqual(replay.body.timestamp, original.timestamp, 'timestamp replay = timestamp kirim asli');
  assert.strictEqual(replay.body.operation_id, 'OP-R1');
  assert.strictEqual(stub.calls.length, 1, 'sendReply TIDAK dipanggil lagi pada replay');
  console.log('OK');

  section('AC-022: operation_id sama, teks berbeda -> 409 OPERATION_ID_REUSED, tanpa kirim');
  const reused = await post('/send', { chat_id: CHAT, text: 'teks BERBEDA', operation_id: 'OP-R1' });
  assert.strictEqual(reused.status, 409);
  assert.strictEqual(reused.body.error_code, 'OPERATION_ID_REUSED');
  assert.strictEqual(reused.body.replayed, false);
  assert.strictEqual(reused.body.success, false);
  assert.strictEqual(stub.calls.length, 1);
  // chat_id berbeda dengan teks sama juga dianggap payload berbeda
  const otherChat = await post('/send', { chat_id: '628999@s.whatsapp.net', text: 'halo', operation_id: 'OP-R1' });
  assert.strictEqual(otherChat.body.error_code, 'OPERATION_ID_REUSED');
  assert.strictEqual(stub.calls.length, 1);
  assert.strictEqual(store.get('OP-R1').state, 'sent', 'baris asli tidak berubah');
  console.log('OK');

  section('AC-024: field lama tetap ada + state/replayed (dengan dan tanpa operation_id)');
  resetStub();
  res = await sendText({ operation_id: 'OP-F1' });
  assert.deepStrictEqual(
    Object.keys(res.body).sort(),
    ['operation_id', 'replayed', 'state', 'success', 'timestamp', 'wa_message_id']
  );
  assert.strictEqual(res.body.success, true);
  assert.ok(res.body.wa_message_id);
  assert.ok(res.body.timestamp);
  console.log('OK: dengan operation_id.');

  section('AC-025/AC-044: tanpa operation_id -> perilaku lama, tanpa baris, satu warn per proses');
  resetStub();
  const rowsBefore = rowCount();
  const warnsBefore = logs.filter((l) => l.level === 'warn' && /tanpa operation_id/.test(l.message)).length;
  const legacy1 = await sendText();
  const legacy2 = await sendText();
  const legacy3 = await sendText({ operation_id: null }); // null = tidak dikirim
  for (const r of [legacy1, legacy2, legacy3]) {
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(Object.keys(r.body).sort(), ['replayed', 'state', 'success', 'timestamp', 'wa_message_id']);
    assert.strictEqual(r.body.state, 'sent');
    assert.strictEqual(r.body.replayed, false);
    assert.ok(!('operation_id' in r.body), 'Gateway TIDAK membuat kunci di server (REQ-039)');
  }
  assert.strictEqual(stub.calls.length, 3, 'setiap panggilan tetap mengirim (tanpa idempotensi)');
  assert.notStrictEqual(legacy1.body.wa_message_id, legacy2.body.wa_message_id);
  assert.strictEqual(rowCount(), rowsBefore, 'tidak ada baris operasi');
  const warnsAfter = logs.filter((l) => l.level === 'warn' && /tanpa operation_id/.test(l.message)).length;
  assert.strictEqual(warnsAfter - warnsBefore, 1, 'tepat SATU warn per proses, bukan per permintaan');
  console.log('OK');

  section('Jalur lama tanpa operation_id: NOT_CONNECTED dan kegagalan kirim tidak berubah');
  resetStub();
  stub.connected = false;
  res = await sendText();
  assert.strictEqual(res.status, 409);
  assert.deepStrictEqual(res.body, { success: false, error_code: 'NOT_CONNECTED', message: 'WhatsApp belum connected.' });
  stub.connected = true;
  stub.impl = async () => {
    const err = new Error('Gagal mengirim pesan: socket putus');
    err.code = 'SEND_FAILED';
    throw err;
  };
  res = await sendText();
  assert.strictEqual(res.status, 500);
  assert.deepStrictEqual(res.body, { success: false, error_code: 'SEND_FAILED', message: 'Gagal mengirim pesan: socket putus' });
  console.log('OK');

  section('Cabang state machine (stub-only, A-2): error ambigu -> 504 SEND_UNRESOLVED, tetap in_flight');
  resetStub();
  stub.impl = async () => {
    const err = new Error('Gagal mengirim pesan: socket putus');
    err.code = 'SEND_FAILED';
    throw err;
  };
  res = await sendText({ operation_id: 'OP-AMB' });
  assert.strictEqual(res.status, 504);
  assert.strictEqual(res.body.error_code, 'SEND_UNRESOLVED');
  assert.strictEqual(res.body.state, 'in_flight');
  assert.strictEqual(res.body.replayed, false);
  assert.strictEqual(store.get('OP-AMB').state, 'in_flight');
  assert.ok(store.get('OP-AMB').last_error.includes('socket putus'));
  // Retry segera: TIDAK boleh mengirim lagi (lease/retry menyusul di Fase 2).
  stub.impl = null;
  res = await sendText({ operation_id: 'OP-AMB' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error_code, 'SEND_IN_PROGRESS');
  assert.strictEqual(stub.calls.length, 1, 'tidak ada kiriman kedua untuk operasi ambigu');
  console.log('OK');

  section('Cabang state machine (stub-only, A-2): INVALID_CHAT_ID -> 500 failed, replay tanpa kirim');
  resetStub();
  stub.impl = async () => {
    const err = new Error('chatId tidak valid');
    err.code = 'INVALID_CHAT_ID';
    throw err;
  };
  res = await sendText({ operation_id: 'OP-FAILED' });
  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.body.error_code, 'INVALID_CHAT_ID');
  assert.strictEqual(res.body.state, 'failed');
  assert.strictEqual(res.body.replayed, false);
  assert.strictEqual(store.get('OP-FAILED').state, 'failed');
  stub.impl = null;
  res = await sendText({ operation_id: 'OP-FAILED' });
  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.body.state, 'failed');
  assert.strictEqual(res.body.replayed, true);
  assert.strictEqual(stub.calls.length, 1, 'replay failed tidak mengirim ulang');
  console.log('OK');

  section('NOT_CONNECTED untuk operasi baru: tidak ada baris; replay tetap dijawab saat tidak connected');
  resetStub();
  stub.connected = false;
  const rowsNc = rowCount();
  res = await sendText({ operation_id: 'OP-NC' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error_code, 'NOT_CONNECTED');
  assert.strictEqual(store.get('OP-NC'), null, 'tidak meninggalkan in_flight palsu');
  assert.strictEqual(rowCount(), rowsNc);
  res = await sendText({ operation_id: 'OP-R1' }); // sudah sent sebelumnya
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.replayed, true);
  assert.strictEqual(stub.calls.length, 0);
  stub.connected = true;
  console.log('OK');

  section('Gagal mencatat SEBELUM kirim -> 500 OPERATION_STORE_ERROR dan pesan TIDAK dikirim (fail closed)');
  resetStub();
  const realBegin = store.begin;
  store.begin = () => {
    throw new Error('disk penuh');
  };
  res = await sendText({ operation_id: 'OP-STORE-ERR' });
  store.begin = realBegin;
  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.body.error_code, 'OPERATION_STORE_ERROR');
  assert.strictEqual(stub.calls.length, 0, 'tanpa catatan durable, tidak boleh mengirim');
  console.log('OK');

  section('Gagal mencatat SETELAH kirim sukses -> tetap 200 sent (pesan memang terkirim)');
  resetStub();
  const realMarkSent = store.markSent;
  store.markSent = () => {
    throw new Error('disk penuh');
  };
  res = await sendText({ operation_id: 'OP-MARK-ERR' });
  store.markSent = realMarkSent;
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.state, 'sent');
  assert.strictEqual(stub.calls.length, 1);
  assert.strictEqual(store.get('OP-MARK-ERR').state, 'in_flight', 'baris tinggal in_flight (terlihat sebagai basi saat start)');
  console.log('OK');

  section('AC-023: hasil sent bertahan setelah Gateway restart (modul dimuat ulang, berkas sama)');
  resetStub();
  res = await sendText({ operation_id: 'OP-RESTART' });
  const beforeRestart = res.body;
  assert.strictEqual(stub.calls.length, 1);
  await stopGateway();
  await startGateway();
  res = await sendText({ operation_id: 'OP-RESTART' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.replayed, true);
  assert.strictEqual(res.body.wa_message_id, beforeRestart.wa_message_id);
  assert.strictEqual(stub.calls.length, 1, 'tidak ada kiriman baru setelah restart');
  console.log('OK');

  // ===================== TASK-004: /send-media =====================

  section('Media, AC-019: operation_id tidak valid dan payload media tidak valid -> 400, tanpa baris/kirim');
  resetStub();
  const mediaRowsBefore = rowCount();
  res = await sendMedia({ operation_id: 'a'.repeat(65) });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error_code, 'INVALID_OPERATION_ID');
  res = await sendMedia({ operation_id: 'OP-M-BAD-B64', media_base64: 'bukan base64 valid !!!' });
  assert.strictEqual(res.body.error_code, 'INVALID_MEDIA_BASE64');
  res = await sendMedia({ operation_id: 'OP-M-BAD-TYPE', media_type: 'video' });
  assert.strictEqual(res.body.error_code, 'INVALID_MEDIA_TYPE');
  res = await sendMedia({ operation_id: 'OP-M-BAD-DOC', media_type: 'document' });
  assert.strictEqual(res.body.error_code, 'MISSING_FILE_NAME');
  res = await sendMedia({ operation_id: 'OP-M-BAD-STK', media_type: 'sticker' }); // bukan WebP
  assert.strictEqual(res.body.error_code, 'INVALID_STICKER_FORMAT');
  res = await sendMedia({ operation_id: 'OP-M-BAD-CAP', caption: 'x'.repeat(1025) });
  assert.strictEqual(res.body.error_code, 'CAPTION_TOO_LONG');
  assert.strictEqual(stub.mediaCalls.length, 0, 'sendMediaReply TIDAK boleh dipanggil');
  assert.strictEqual(rowCount(), mediaRowsBefore, 'payload media ditolak -> tidak ada baris in_flight (A-7)');
  console.log('OK');

  section('Media, AC-020: in_flight (kind=media) tersimpan SEBELUM sendMediaReply dipanggil');
  resetStub();
  let releaseMedia;
  const mediaGate = new Promise((resolve) => {
    releaseMedia = resolve;
  });
  let mediaStateAtCall = null;
  stub.onMediaCall = () => {
    mediaStateAtCall = store.get('OP-M-HANG');
  };
  stub.mediaImpl = async () => {
    await mediaGate;
    return { messageId: 'WAM-HANG', timestamp: '2026-09-24T11:05:00.000Z', mediaRef: null };
  };
  const hangingMedia = sendMedia({ operation_id: 'OP-M-HANG' });
  while (stub.mediaCalls.length === 0) await new Promise((r) => setTimeout(r, 5));
  assert.ok(mediaStateAtCall, 'baris operasi HARUS sudah ada saat sendMediaReply terpanggil');
  assert.strictEqual(mediaStateAtCall.state, 'in_flight');
  assert.strictEqual(mediaStateAtCall.kind, 'media');
  assert.strictEqual(mediaStateAtCall.attempts, 1);
  res = await sendMedia({ operation_id: 'OP-M-HANG' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error_code, 'SEND_IN_PROGRESS');
  assert.strictEqual(stub.mediaCalls.length, 1, 'tanpa kiriman kedua');
  releaseMedia();
  const hangDone = await hangingMedia;
  assert.strictEqual(hangDone.status, 200);
  assert.strictEqual(hangDone.body.media_ref, null, 'mediaRef null tetap dijawab sebagai media_ref:null');
  const hangReplay = await sendMedia({ operation_id: 'OP-M-HANG' });
  assert.strictEqual(hangReplay.body.replayed, true);
  assert.strictEqual(hangReplay.body.media_ref, null);
  console.log('OK');

  section('Media, AC-021/AC-024: replay -> 200 replayed:true, wa_message_id + media_ref identik, tanpa kirim');
  resetStub();
  res = await sendMedia({ operation_id: 'OP-M1' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(
    Object.keys(res.body).sort(),
    ['media_ref', 'operation_id', 'replayed', 'state', 'success', 'timestamp', 'wa_message_id']
  );
  assert.strictEqual(res.body.replayed, false);
  assert.deepStrictEqual(res.body.media_ref, { direct_path: res.body.media_ref.direct_path, media_key_base64: 'a2V5LWJhc2U2NA==' });
  assert.ok(res.body.media_ref.direct_path.startsWith('/v/t62/'));
  assert.strictEqual(stub.mediaCalls.length, 1);
  assert.ok(stub.mediaCalls[0].buffer.equals(IMG), 'buffer hasil decode diteruskan apa adanya');
  const mediaOriginal = res.body;
  const mediaReplay = await sendMedia({ operation_id: 'OP-M1' });
  assert.strictEqual(mediaReplay.status, 200);
  assert.strictEqual(mediaReplay.body.replayed, true);
  assert.strictEqual(mediaReplay.body.wa_message_id, mediaOriginal.wa_message_id);
  assert.strictEqual(mediaReplay.body.timestamp, mediaOriginal.timestamp);
  assert.deepStrictEqual(mediaReplay.body.media_ref, mediaOriginal.media_ref);
  assert.strictEqual(stub.mediaCalls.length, 1, 'sendMediaReply TIDAK dipanggil lagi pada replay');
  console.log('OK');

  section('Media, AC-022: kunci sama, isi/metadata berbeda -> 409 OPERATION_ID_REUSED, tanpa kirim');
  const sameSizeOtherBytes = Buffer.from('ISI-GAMBAR-UJI-BBBB'); // panjang sama, SHA-256 beda
  assert.strictEqual(sameSizeOtherBytes.length, IMG.length);
  const variants = [
    ['konten beda (ukuran sama)', { media_base64: sameSizeOtherBytes.toString('base64') }],
    ['caption beda', { caption: 'caption lain' }],
    ['mimetype beda', { mimetype: 'image/png' }],
    ['file_name beda', { file_name: 'lain.jpg' }],
    ['is_animated beda', { is_animated: true }],
    ['chat_id beda', { chat_id: '628999@s.whatsapp.net' }],
  ];
  for (const [label, extra] of variants) {
    const r = await sendMedia({ operation_id: 'OP-M1', ...extra });
    assert.strictEqual(r.status, 409, label);
    assert.strictEqual(r.body.error_code, 'OPERATION_ID_REUSED', label);
    assert.strictEqual(r.body.replayed, false, label);
  }
  assert.strictEqual(stub.mediaCalls.length, 1);
  // Kunci yang dipakai jalur teks tidak bisa dipakai jalur media (kind masuk fingerprint).
  res = await sendMedia({ operation_id: 'OP-R1' }); // OP-R1 sudah dipakai /send teks
  assert.strictEqual(res.body.error_code, 'OPERATION_ID_REUSED');
  assert.strictEqual(store.get('OP-M1').state, 'sent', 'baris asli tidak berubah');
  console.log('OK');

  section('Media, AC-025/AC-044: tanpa operation_id -> perilaku lama, tanpa baris, warn sekali per proses');
  resetStub();
  const mediaRowsLegacy = rowCount();
  const warnsMediaBefore = logs.filter((l) => l.level === 'warn' && /tanpa operation_id/.test(l.message)).length;
  const legacyMedia1 = await sendMedia();
  const legacyMedia2 = await sendMedia();
  for (const r of [legacyMedia1, legacyMedia2]) {
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(Object.keys(r.body).sort(), ['media_ref', 'replayed', 'state', 'success', 'timestamp', 'wa_message_id']);
    assert.strictEqual(r.body.state, 'sent');
    assert.strictEqual(r.body.replayed, false);
    assert.ok(r.body.media_ref.direct_path && r.body.media_ref.media_key_base64, 'media_ref bentuk lama tetap ada');
  }
  assert.strictEqual(stub.mediaCalls.length, 2, 'setiap panggilan tetap mengirim');
  assert.strictEqual(rowCount(), mediaRowsLegacy);
  // Modul dimuat ulang oleh tes restart -> flag "sudah warn" baru: tepat 1 warn untuk 2 permintaan.
  const warnsMediaAfter = logs.filter((l) => l.level === 'warn' && /tanpa operation_id/.test(l.message)).length;
  assert.strictEqual(warnsMediaAfter - warnsMediaBefore, 1);
  console.log('OK');

  section('Media: kegagalan kirim tanpa operation_id tetap 500 seperti sebelumnya');
  resetStub();
  stub.mediaImpl = async () => {
    const err = new Error('Gagal mengirim media: socket putus');
    err.code = 'SEND_FAILED';
    throw err;
  };
  res = await sendMedia();
  assert.strictEqual(res.status, 500);
  assert.deepStrictEqual(res.body, { success: false, error_code: 'SEND_FAILED', message: 'Gagal mengirim media: socket putus' });
  // dan dengan operation_id: ambigu -> 504, tetap in_flight (stub-only, A-2)
  res = await sendMedia({ operation_id: 'OP-M-AMB' });
  assert.strictEqual(res.status, 504);
  assert.strictEqual(res.body.error_code, 'SEND_UNRESOLVED');
  assert.strictEqual(store.get('OP-M-AMB').state, 'in_flight');
  console.log('OK');

  section('SEC-001: log dan basis data tidak memuat isi pesan');
  resetStub();
  // Rahasia bisa disuplai pemindai berkas log lewat env; bila tidak, memakai nilai bawaan.
  const SECRET = process.env.OUTGOING_TEST_SECRET_TEXT || 'RAHASIA-ISI-PESAN-PELANGGAN-123';
  const MEDIA_MARKER = process.env.OUTGOING_TEST_SECRET_MEDIA || 'RAHASIA-ISI-MEDIA-PELANGGAN-456-';
  stub.impl = async () => {
    throw new Error('Gagal mengirim pesan: socket putus');
  };
  await post('/send', { chat_id: CHAT, text: SECRET, operation_id: 'OP-SEC-FAIL' });
  stub.impl = null;
  await post('/send', { chat_id: CHAT, text: SECRET, operation_id: 'OP-SEC-OK' });
  await post('/send', { chat_id: CHAT, text: `${SECRET} beda`, operation_id: 'OP-SEC-OK' }); // reused
  await post('/send', { chat_id: CHAT, text: SECRET }); // tanpa operation_id
  // Media: gagal (ambigu), sukses, reused, dan tanpa operation_id -- semuanya membawa base64 rahasia.
  const SECRET_MEDIA = Buffer.from(MEDIA_MARKER.repeat(4));
  const SECRET_B64 = SECRET_MEDIA.toString('base64');
  stub.mediaImpl = async () => {
    throw new Error('Gagal mengirim media: socket putus');
  };
  await sendMedia({ operation_id: 'OP-SEC-M-FAIL', media_base64: SECRET_B64, caption: SECRET });
  stub.mediaImpl = null;
  await sendMedia({ operation_id: 'OP-SEC-M-OK', media_base64: SECRET_B64, caption: SECRET });
  await sendMedia({ operation_id: 'OP-SEC-M-OK', media_base64: SECRET_B64, caption: `${SECRET} beda` }); // reused
  await sendMedia({ media_base64: SECRET_B64, caption: SECRET }); // tanpa operation_id
  await sendMedia({ operation_id: 'OP-SEC-M-BAD', media_base64: `${SECRET_B64.slice(0, 20)} !!!` }); // base64 rusak
  const everything = logText();
  assert.ok(!everything.includes(SECRET), 'isi pesan/caption tidak boleh muncul di log');
  assert.ok(!everything.includes(SECRET_B64), 'string media_base64 tidak boleh muncul di log');
  assert.ok(!everything.includes(SECRET_B64.slice(0, 20)), 'potongan media_base64 tidak boleh muncul di log');
  assert.ok(!everything.includes(MEDIA_MARKER), 'isi media hasil decode tidak boleh muncul di log');
  const dump = JSON.stringify(store.db.prepare('SELECT * FROM outgoing_operations').all());
  assert.ok(!dump.includes(SECRET), 'isi pesan tidak boleh tersimpan di outgoing_operations');
  assert.ok(!dump.includes(SECRET_B64) && !dump.includes(MEDIA_MARKER), 'isi media tidak boleh tersimpan di outgoing_operations');
  console.log('OK');

  console.log('\nSEMUA ASSERT LULUS (0 gagal).');
})()
  .catch((err) => {
    console.error('GAGAL:', err);
    console.error('Log terakhir:', logs.slice(-8));
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await stopGateway();
    } catch (err) {
      // sudah berhenti
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
