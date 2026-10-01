'use strict';
/**
 * Simulasi adapter Evolution (Tahap 1). Memasang router kontrak CI4 + webhook
 * di server express nyata, TANPA memanggil Evolution API sungguhan
 * (evolution/client di-stub). Menguji:
 *   - auth Bearer token (kontrak CI4),
 *   - validasi payload /send, /send-media, /media/download,
 *   - idempotensi operation_id (sent/replay/reused/in_progress/not_connected),
 *   - forward -> prefix teks,
 *   - quoted -> memakai quotedStore (key+message),
 *   - webhook Evolution -> buffer durable (idempoten) -> diteruskan ke CI4,
 *   - filter echo pesan kiriman sendiri & pesan non-teks,
 *   - CONNECTION_UPDATE -> status heartbeat.
 *
 * Semua data di folder temp (SQLITE_PATH / MEDIA_STORE_DIR); TIDAK menyentuh
 * data/gateway.sqlite. Jalankan: node test/simulate-evolution-adapter.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// HARUS sebelum modul src/ mana pun di-require: config dibaca sekali saat load
// dan singleton store membuka SQLITE_PATH saat dimuat.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-adapter-'));
process.env.SQLITE_PATH = path.join(tmpRoot, 'gateway.sqlite');
process.env.MEDIA_STORE_DIR = path.join(tmpRoot, 'media');
process.env.CI4_BASE_URL = '';
process.env.CI4_GATEWAY_TOKEN = 'token-uji';
process.env.EVOLUTION_API_KEY = 'apikey-uji';
process.env.EVOLUTION_INSTANCE = 'inst-uji';
process.env.EVOLUTION_BASE_URL = 'http://127.0.0.1:8080';

const assert = require('assert');
const express = require('express');
const logger = require('../src/logging');
const incomingBuffer = require('../src/store/incomingBuffer');
const incomingDelivery = require('../src/delivery/incomingDelivery');
const evolutionClient = require('../src/evolution/client');
const evolutionState = require('../src/evolution/state');
const quotedStore = require('../src/evolution/quotedStore');
const mediaStore = require('../src/evolution/mediaStore');
const ownSent = require('../src/evolution/ownSentRegistry').instance;
const evolutionCi4Routes = require('../src/evolution/ci4Routes');
const evolutionWebhookRoutes = require('../src/evolution/webhookRoutes');
const { FORWARD_TEXT_PREFIX } = require('../src/whatsapp/forwardMarker');

// --- tangkap log (jangan cetak isi pesan) ---
const logs = [];
for (const level of ['info', 'warn', 'error', 'debug']) {
  const original = logger[level];
  logger[level] = (message, meta) => {
    logs.push({ level, message, meta });
    if (process.env.EVOLUTION_TEST_LOG_PASSTHROUGH === '1') original(message, meta);
  };
}
const logText = () => JSON.stringify(logs);

// --- stub evolution/client (tanpa jaringan) ---
const CHAT = '628111222333@s.whatsapp.net';
const stub = { sent: [], media: [], sticker: [], impl: null };
evolutionClient.sendText = async (args) => {
  stub.sent.push({ ...args });
  if (stub.impl) return stub.impl(args);
  return { messageId: `EV-${stub.sent.length}`, timestamp: '2026-10-01T10:00:00.000Z', quoteApplied: Boolean(args.quoted), key: { id: `EV-${stub.sent.length}`, remoteJid: args.number + '@s.whatsapp.net', fromMe: true } };
};
evolutionClient.sendMedia = async (args) => {
  stub.media.push(args);
  return { messageId: `EVM-${stub.media.length}`, timestamp: '2026-10-01T11:00:00.000Z', mediaRef: null, quoteApplied: Boolean(args.quoted), key: { id: `EVM-${stub.media.length}`, remoteJid: args.number + '@s.whatsapp.net', fromMe: true } };
};
evolutionClient.sendSticker = async (args) => {
  stub.sticker.push(args);
  return { messageId: `EVS-${stub.sticker.length}`, timestamp: '2026-10-01T12:00:00.000Z', mediaRef: null, quoteApplied: Boolean(args.quoted), key: { id: `EVS-${stub.sticker.length}`, remoteJid: args.number + '@s.whatsapp.net', fromMe: true } };
};
function resetStub() {
  stub.sent = [];
  stub.media = [];
  stub.sticker = [];
  stub.impl = null;
}

let server;
let baseUrl;

async function start() {
  const app = express();
  app.use('/evolution', evolutionWebhookRoutes);
  app.use(evolutionCi4Routes);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function post(route, body, { withAuth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (withAuth) headers.Authorization = 'Bearer token-uji';
  const res = await fetch(`${baseUrl}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { /* non-JSON */ }
  return { status: res.status, body: json, raw: text };
}

const sendText = (extra = {}) => post('/send', { chat_id: CHAT, text: 'halo', ...extra });
const section = (title) => console.log(`\n--- ${title} ---`);

function webhookPayload(overrides = {}) {
  return {
    event: 'MESSAGES_UPSERT',
    instance: 'inst-uji',
    data: {
      key: { id: 'WAMID-1', remoteJid: '628222333444@s.whatsapp.net', fromMe: false },
      pushName: 'Budi',
      message: { conversation: 'pesan uji' },
      messageType: 'conversation',
      messageTimestamp: 1790000000,
      ...overrides.data,
    },
    ...overrides,
  };
}

(async () => {
  await start();
  await new Promise((r) => setTimeout(r, 50));
  evolutionState.setConnectionState('open', { phone: '628111222333' });

  section('Auth: tanpa/salah Bearer token -> 401');
  let res = await post('/send', { chat_id: CHAT, text: 'x' }, { withAuth: false });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.error_code, 'UNAUTHORIZED');
  console.log('OK');

  section('Validasi payload /send (operation_id, chat_id, text) tanpa mengirim');
  resetStub();
  res = await sendText({ operation_id: 'a'.repeat(65) });
  assert.strictEqual(res.body.error_code, 'INVALID_OPERATION_ID');
  res = await post('/send', { chat_id: 'bukan-jid', text: 'x' });
  assert.strictEqual(res.body.error_code, 'INVALID_CHAT_ID');
  res = await post('/send', { chat_id: CHAT, text: '   ' });
  assert.strictEqual(res.body.error_code, 'INVALID_TEXT');
  res = await post('/send', { chat_id: CHAT, text: 'x'.repeat(4097) });
  assert.strictEqual(res.body.error_code, 'TEXT_TOO_LONG');
  assert.strictEqual(stub.sent.length, 0, 'client TIDAK boleh dipanggil');
  console.log('OK');

  section('forward + quoted bersamaan -> 400 FORWARD_WITH_QUOTED');
  res = await post('/send', { chat_id: CHAT, text: 'x', forward: true, quoted: { wa_message_id: 'asal' } });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error_code, 'FORWARD_WITH_QUOTED');
  console.log('OK');

  section('/send sukses + idempotensi (sent -> replay -> reused)');
  resetStub();
  res = await sendText({ operation_id: 'OP-1' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.state, 'sent');
  assert.strictEqual(res.body.replayed, false);
  assert.strictEqual(res.body.operation_id, 'OP-1');
  assert.strictEqual(stub.sent.length, 1);
  assert.strictEqual(stub.sent[0].number, '628111222333', 'nomor polos, bukan JID');
  assert.strictEqual(stub.sent[0].text, 'halo');

  const replay = await sendText({ operation_id: 'OP-1' });
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.body.replayed, true);
  assert.strictEqual(stub.sent.length, 1, 'replay tidak mengirim ulang');

  const reused = await post('/send', { chat_id: CHAT, text: 'teks lain', operation_id: 'OP-1' });
  assert.strictEqual(reused.status, 409);
  assert.strictEqual(reused.body.error_code, 'OPERATION_ID_REUSED');
  assert.strictEqual(stub.sent.length, 1);
  console.log('OK');

  section('/send in_progress: kiriman menggantung -> 409, tanpa kirim kedua');
  resetStub();
  let release;
  const gate = new Promise((r) => { release = r; });
  stub.impl = async () => {
    await gate;
    return { messageId: 'EV-HANG', timestamp: '2026-10-01T10:05:00.000Z', key: { id: 'EV-HANG' } };
  };
  const hanging = sendText({ operation_id: 'OP-HANG' });
  while (stub.sent.length === 0) await new Promise((r) => setTimeout(r, 5));
  const second = await sendText({ operation_id: 'OP-HANG' });
  assert.strictEqual(second.status, 409);
  assert.strictEqual(second.body.error_code, 'SEND_IN_PROGRESS');
  assert.strictEqual(stub.sent.length, 1);
  release();
  const done = await hanging;
  assert.strictEqual(done.status, 200);
  console.log('OK');

  section('/send NOT_CONNECTED saat instance terputus');
  resetStub();
  evolutionState.setConnectionState('close', { reason: 'uji' });
  res = await sendText({ operation_id: 'OP-NC' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error_code, 'NOT_CONNECTED');
  assert.strictEqual(stub.sent.length, 0);
  evolutionState.setConnectionState('open', { phone: '628111222333' });
  console.log('OK');

  section('/send forward -> prefix teks + forward_marker_applied text_fallback');
  resetStub();
  res = await sendText({ operation_id: 'OP-FWD', forward: true });
  assert.strictEqual(res.body.forward_marker_applied, 'text_fallback');
  assert.strictEqual(stub.sent[0].text, `${FORWARD_TEXT_PREFIX}halo`);
  console.log('OK');

  section('/send quoted -> memakai quotedStore (key+message)');
  quotedStore.save('WAMID-Q', { id: 'WAMID-Q', remoteJid: CHAT, fromMe: false }, { conversation: 'pesan asal' });
  resetStub();
  res = await sendText({ operation_id: 'OP-QUOTE', quoted: { wa_message_id: 'WAMID-Q' } });
  assert.strictEqual(res.body.quote_applied, true);
  assert.strictEqual(stub.sent[0].quoted.key.id, 'WAMID-Q');
  assert.strictEqual(stub.sent[0].quoted.message.conversation, 'pesan asal');
  // Quote STICKER: field byte (objek JSON {"0":..}) WAJIB dikonversi ke base64
  // dan key mentah webhook dibersihkan -- tanpa ini, HP gagal merender quote.
  quotedStore.save(
    'WAMID-STK',
    { id: 'WAMID-STK', remoteJid: CHAT, remoteJidAlt: CHAT, fromMe: false, participant: '', addressingMode: 'lid' },
    { stickerMessage: { mimetype: 'image/webp', mediaKey: { 0: 145, 1: 197, 2: 3 }, fileSha256: { 0: 9, 1: 8 } }, messageContextInfo: { messageSecret: { 0: 1, 1: 2 } } }
  );
  resetStub();
  res = await sendText({ operation_id: 'OP-QUOTE-STK', quoted: { wa_message_id: 'WAMID-STK' } });
  assert.strictEqual(res.body.quote_applied, true);
  const qKey = stub.sent[0].quoted.key;
  assert.deepStrictEqual(Object.keys(qKey).sort(), ['fromMe', 'id', 'remoteJid'], 'key quote dibersihkan (buang addressingMode/remoteJidAlt/participant kosong)');
  const qMsg = stub.sent[0].quoted.message;
  assert.strictEqual(typeof qMsg.stickerMessage.mediaKey, 'string', 'mediaKey byte -> base64');
  assert.strictEqual(qMsg.stickerMessage.mediaKey, Buffer.from([145, 197, 3]).toString('base64'));
  assert.strictEqual(typeof qMsg.stickerMessage.fileSha256, 'string', 'fileSha256 byte -> base64');
  assert.strictEqual(typeof qMsg.messageContextInfo.messageSecret, 'string', 'messageSecret byte -> base64');

  // quoted yang tidak bisa dipetakan -> degradasi (tetap terkirim, quote_applied false)
  resetStub();
  res = await sendText({ operation_id: 'OP-QUOTE2', quoted: { wa_message_id: 'TIDAK-ADA' } });
  assert.strictEqual(res.body.quote_applied, false);
  assert.strictEqual(stub.sent.length, 1, 'pesan tetap terkirim walau balas didegradasi');
  console.log('OK');

  section('/send-media: validasi + kirim gambar + sticker');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  const imgB64 = Buffer.from('GAMBAR').toString('base64');
  resetStub();
  res = await post('/send-media', { chat_id: CHAT, media_type: 'image', media_base64: imgB64, mimetype: 'image/jpeg' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(stub.media.length, 1);
  assert.strictEqual(stub.media[0].mediatype, 'image');
  // Ref media keluar WAJIB terisi (bukan null) supaya Inbox bisa menampilkan
  // gambarnya; sebelumnya null -> "Gambar tidak tersedia" di POS.
  assert.ok(res.body.media_ref && String(res.body.media_ref.direct_path).startsWith('evolution-media:'), 'media_ref keluar terisi');
  assert.ok(res.body.media_ref.media_key_base64, 'media_key_base64 placeholder non-kosong');
  // Byte yang dikirim bisa diunduh ulang lewat /media/download (dipakai Inbox).
  const outDl = await fetch(`${baseUrl}/media/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-uji' },
    body: JSON.stringify({ media_type: 'image', direct_path: res.body.media_ref.direct_path, media_key_base64: res.body.media_ref.media_key_base64, mimetype: 'image/jpeg' }),
  });
  assert.strictEqual(outDl.status, 200);
  assert.strictEqual(Buffer.from(await outDl.arrayBuffer()).toString(), 'GAMBAR', 'byte media keluar kembali utuh');

  // Idempotensi media: replay operation_id yang sama mengembalikan ref tersimpan.
  resetStub();
  const mediaOp = 'OP-MEDIA-REPLAY';
  const firstMedia = await post('/send-media', { chat_id: CHAT, media_type: 'image', media_base64: imgB64, mimetype: 'image/png', operation_id: mediaOp });
  assert.ok(firstMedia.body.media_ref && firstMedia.body.media_ref.direct_path, 'kiriman pertama punya media_ref');
  const replayMedia = await post('/send-media', { chat_id: CHAT, media_type: 'image', media_base64: imgB64, mimetype: 'image/png', operation_id: mediaOp });
  assert.strictEqual(replayMedia.body.replayed, true);
  assert.deepStrictEqual(replayMedia.body.media_ref, firstMedia.body.media_ref, 'replay mengembalikan media_ref tersimpan');
  assert.strictEqual(stub.media.length, 1, 'replay tidak mengirim ulang media');

  res = await post('/send-media', { chat_id: CHAT, media_type: 'document', media_base64: imgB64 });
  assert.strictEqual(res.body.error_code, 'MISSING_FILE_NAME');
  res = await post('/send-media', { chat_id: CHAT, media_type: 'sticker', media_base64: imgB64 });
  assert.strictEqual(res.body.error_code, 'INVALID_STICKER_FORMAT');
  resetStub();
  res = await post('/send-media', { chat_id: CHAT, media_type: 'sticker', media_base64: webp.toString('base64') });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(stub.sticker.length, 1);
  assert.ok(res.body.media_ref && String(res.body.media_ref.direct_path).startsWith('evolution-media:'), 'media_ref sticker keluar terisi');
  console.log('OK');

  section('/media/download: ref non-adapter -> 501; ref adapter -> binary');
  res = await post('/media/download', { media_type: 'image', direct_path: '/v/t62/lama', media_key_base64: 'x' });
  assert.strictEqual(res.status, 501);
  assert.strictEqual(res.body.error_code, 'MEDIA_REF_NOT_SUPPORTED');
  const ref = mediaStore.save(Buffer.from('ISI-MEDIA'), { mimetype: 'image/jpeg', mediaType: 'image' });
  const dl = await fetch(`${baseUrl}/media/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-uji' },
    body: JSON.stringify({ media_type: 'image', direct_path: ref, media_key_base64: 'placeholder' }),
  });
  assert.strictEqual(dl.status, 200);
  assert.strictEqual(await dl.text(), 'ISI-MEDIA');
  const missing = await post('/media/download', { media_type: 'image', direct_path: 'evolution-media:tidak-ada' });
  assert.strictEqual(missing.status, 410);
  console.log('OK');

  section('Webhook MESSAGES_UPSERT -> buffer durable (idempoten) -> diteruskan ke CI4');
  const payload = webhookPayload();
  const pendingBefore = incomingBuffer.countPending();
  let wres = await post('/evolution/webhook', payload, { withAuth: false });
  assert.strictEqual(wres.status, 200);
  assert.strictEqual(wres.body.success, true);
  assert.strictEqual(incomingBuffer.countPending(), pendingBefore + 1, 'pesan tersimpan sekali');

  // webhook yang SAMA dikirim ulang -> tidak dobel
  wres = await post('/evolution/webhook', payload, { withAuth: false });
  assert.strictEqual(wres.status, 200);
  assert.strictEqual(incomingBuffer.countPending(), pendingBefore + 1, 'duplikat tidak menambah baris');

  const row = incomingBuffer.getDueEvents(100).find((e) => e.wa_message_id === 'WAMID-1');
  assert.ok(row, 'baris ada di antrean');
  assert.strictEqual(row.chat_id, '628222333444@s.whatsapp.net');
  assert.strictEqual(row.jid_type, 'pn');
  assert.strictEqual(row.message_type, 'text');
  assert.strictEqual(row.text, 'pesan uji');
  assert.strictEqual(row.direction, 'incoming');
  assert.ok(quotedStore.get('WAMID-1'), 'key+message disimpan untuk balas');

  let forwarded = null;
  await incomingDelivery.deliverOne(row, {
    postToCI4: async (pathSuffix, body) => {
      forwarded = { pathSuffix, body };
      return { ok: true, status: 200, json: { status: 'success' } };
    },
  });
  assert.ok(forwarded, 'deliverOne memanggil CI4');
  assert.strictEqual(forwarded.pathSuffix, '/api/inbox/gateway/messages');
  assert.strictEqual(forwarded.body.wa_message_id, 'WAMID-1');
  assert.strictEqual(forwarded.body.text, 'pesan uji');
  assert.ok(!incomingBuffer.getDueEvents(100).some((e) => e.wa_message_id === 'WAMID-1'), 'baris ditandai completed');
  console.log('OK');

  section('Webhook: pesan grup tanpa participant dilewati (tetap 200)');
  wres = await post('/evolution/webhook', webhookPayload({ data: { key: { id: 'G1', remoteJid: '123@g.us', fromMe: false } } }), { withAuth: false });
  assert.strictEqual(wres.status, 200);
  assert.strictEqual(wres.body.skipped, true);
  console.log('OK');

  section('Grup: group_name + pemetaan pengirim LID -> nomor (fetch info di-cache)');
  let groupInfoCalls = 0;
  evolutionClient.getGroupInfo = async () => {
    groupInfoCalls += 1;
    return {
      subject: 'Grup Uji',
      participants: [
        { id: '149701252890753@lid', phoneNumber: '628563324637@s.whatsapp.net' },
        { id: '36769483485210@lid', phoneNumber: '62881082323928@s.whatsapp.net' },
      ],
    };
  };
  wres = await post('/evolution/webhook', webhookPayload({
    data: { key: { id: 'GRP-1', remoteJid: '120363431232595303@g.us', fromMe: false, participant: '149701252890753@lid' }, pushName: 'Budi', message: { conversation: 'halo grup' }, messageType: 'conversation', messageTimestamp: 1790000300 },
  }), { withAuth: false });
  assert.strictEqual(wres.body.success, true);
  const gRow = incomingBuffer.getDueEvents(200).find((e) => e.wa_message_id === 'GRP-1');
  assert.ok(gRow, 'baris grup ada di antrean');
  assert.strictEqual(gRow.jid_type, 'group');
  assert.strictEqual(gRow.group_name, 'Grup Uji', 'group_name diisi dari subject');
  assert.strictEqual(gRow.sender_jid, '628563324637@s.whatsapp.net', 'LID pengirim dipetakan ke nomor');
  assert.strictEqual(gRow.phone, '628563324637');

  // Pesan grup kedua -> info grup TIDAK di-fetch ulang (cache).
  wres = await post('/evolution/webhook', webhookPayload({
    data: { key: { id: 'GRP-2', remoteJid: '120363431232595303@g.us', fromMe: false, participant: '36769483485210@lid' }, message: { conversation: 'lagi' }, messageType: 'conversation', messageTimestamp: 1790000310 },
  }), { withAuth: false });
  const gRow2 = incomingBuffer.getDueEvents(200).find((e) => e.wa_message_id === 'GRP-2');
  assert.strictEqual(gRow2.group_name, 'Grup Uji');
  assert.strictEqual(gRow2.sender_jid, '62881082323928@s.whatsapp.net');
  assert.strictEqual(groupInfoCalls, 1, 'info grup di-cache (tidak fetch ulang)');
  console.log('OK');

  section('Media masuk: image tanpa base64 dilewati; dengan base64 -> ref + diteruskan ke CI4 + bisa diunduh');
  wres = await post('/evolution/webhook', webhookPayload({ data: { key: { id: 'IMG-NOB64', remoteJid: '628222333444@s.whatsapp.net', fromMe: false }, message: { imageMessage: { caption: 'tanpa base64' } }, messageType: 'imageMessage' } }), { withAuth: false });
  assert.strictEqual(wres.status, 200);
  assert.strictEqual(wres.body.skipped, true);

  const imgBytes = Buffer.from('PNG-DUMMY-BYTES');
  wres = await post('/evolution/webhook', webhookPayload({ data: { key: { id: 'IMG1', remoteJid: '628222333444@s.whatsapp.net', fromMe: false }, pushName: 'Budi', message: { imageMessage: { mimetype: 'image/jpeg', caption: 'foto uji' }, base64: imgBytes.toString('base64') }, messageType: 'imageMessage', messageTimestamp: 1790000200 } }), { withAuth: false });
  assert.strictEqual(wres.status, 200);
  assert.strictEqual(wres.body.success, true);

  const imgRow = incomingBuffer.getDueEvents(100).find((e) => e.wa_message_id === 'IMG1');
  assert.ok(imgRow, 'baris media ada di antrean');
  assert.strictEqual(imgRow.message_type, 'image');
  assert.strictEqual(imgRow.text, 'foto uji');
  const imgMedia = JSON.parse(imgRow.media_json);
  assert.ok(imgMedia.direct_path.startsWith('evolution-media:'), 'direct_path berupa ref adapter');
  assert.ok(imgMedia.media_key_base64, 'media_key_base64 placeholder non-kosong');

  let imgForwarded = null;
  await incomingDelivery.deliverOne(imgRow, { postToCI4: async (pathSuffix, body) => { imgForwarded = { pathSuffix, body }; return { ok: true, status: 200, json: { status: 'success' } }; } });
  assert.ok(imgForwarded.body.media, 'media ikut dikirim ke CI4');
  assert.strictEqual(imgForwarded.body.media.direct_path, imgMedia.direct_path);

  const imgDl = await fetch(`${baseUrl}/media/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-uji' },
    body: JSON.stringify({ media_type: 'image', direct_path: imgMedia.direct_path, media_key_base64: 'evolution', mimetype: 'image/jpeg' }),
  });
  assert.strictEqual(imgDl.status, 200);
  assert.strictEqual(await imgDl.text(), 'PNG-DUMMY-BYTES', 'byte media kembali utuh');
  console.log('OK');

  section('Webhook: echo pesan kiriman sendiri diabaikan');
  ownSent.record('ECHO-1');
  const pendingEcho = incomingBuffer.countPending();
  wres = await post('/evolution/webhook', webhookPayload({ data: { key: { id: 'ECHO-1', remoteJid: '628222333444@s.whatsapp.net', fromMe: true }, message: { conversation: 'balasan kita' } } }), { withAuth: false });
  assert.strictEqual(wres.body.skipped, true);
  assert.strictEqual(incomingBuffer.countPending(), pendingEcho, 'echo tidak menambah baris');
  console.log('OK');

  section('CONNECTION_UPDATE mengubah status heartbeat');
  wres = await post('/evolution/webhook', { event: 'CONNECTION_UPDATE', instance: 'inst-uji', data: { state: 'close' } }, { withAuth: false });
  assert.strictEqual(wres.status, 200);
  assert.strictEqual(evolutionState.getSnapshot().status, 'disconnected');
  await post('/evolution/webhook', { event: 'CONNECTION_UPDATE', instance: 'inst-uji', data: { state: 'open', wuid: '628111222333@s.whatsapp.net' } }, { withAuth: false });
  assert.strictEqual(evolutionState.getSnapshot().status, 'connected');
  assert.strictEqual(evolutionState.getSnapshot().sessionHealth, 'ok', 'session_health selalu ok (tanpa degraded)');
  console.log('OK');

  section('SEC: isi pesan tidak bocor ke log');
  const SECRET = 'RAHASIA-PESAN-EVOLUTION-777';
  resetStub();
  await post('/send', { chat_id: CHAT, text: SECRET, operation_id: 'OP-SEC' });
  await post('/evolution/webhook', webhookPayload({ data: { key: { id: 'SEC-1', remoteJid: '628222333444@s.whatsapp.net', fromMe: false }, message: { conversation: SECRET } } }), { withAuth: false });
  assert.ok(!logText().includes(SECRET), 'isi pesan tidak boleh muncul di log');
  console.log('OK');

  section('Klien Evolution: mapping request nyata ke kontrak v2.3.7 (fetch di-stub)');
  const realFetch = global.fetch;
  const captured = [];
  global.fetch = async (url, opts) => {
    captured.push({ url, opts });
    return new Response(
      JSON.stringify({ key: { id: 'REAL-1', remoteJid: '628999@s.whatsapp.net', fromMe: true }, message: {}, status: 'PENDING' }),
      { status: 201 }
    );
  };
  // Modul client yang ASLI (bukan stub di atas router) untuk menguji HTTP client.
  delete require.cache[require.resolve('../src/evolution/client')];
  const realClient = require('../src/evolution/client');

  const realSent = await realClient.sendText({
    number: '628999',
    text: 'hai',
    quoted: { key: { id: 'Q1', remoteJid: '628999@s.whatsapp.net', fromMe: false }, message: { conversation: 'asal' } },
  });
  const sentCall = captured[0];
  assert.ok(sentCall.url.endsWith('/message/sendText/inst-uji'), 'path sendText benar');
  assert.strictEqual(sentCall.opts.headers.apikey, 'apikey-uji', 'auth memakai header apikey (bukan Bearer)');
  const sentBody = JSON.parse(sentCall.opts.body);
  assert.strictEqual(sentBody.number, '628999');
  assert.strictEqual(sentBody.text, 'hai', 'schema resmi v2.3.7 memakai field flat "text"');
  assert.strictEqual(sentBody.quoted.key.id, 'Q1');
  assert.strictEqual(realSent.messageId, 'REAL-1', 'wa_message_id diambil dari key.id');

  captured.length = 0;
  global.fetch = async (url, opts) => {
    captured.push({ url, opts });
    return new Response(JSON.stringify({ webhook: {} }), { status: 201 });
  };
  await realClient.setWebhook({ url: 'http://127.0.0.1:3000/evolution/webhook', events: ['MESSAGES_UPSERT'] });
  const webhookCall = captured[0];
  assert.ok(webhookCall.url.endsWith('/webhook/set/inst-uji'), 'path webhook/set benar');
  const webhookBody = JSON.parse(webhookCall.opts.body);
  assert.ok(webhookBody.webhook, 'body webhook WAJIB dibungkus { webhook: {...} } (v2.3.7)');
  assert.strictEqual(webhookBody.webhook.url, 'http://127.0.0.1:3000/evolution/webhook');
  assert.deepStrictEqual(webhookBody.webhook.events, ['MESSAGES_UPSERT']);

  // sendSticker WAJIB JSON { number, sticker: base64 }, BUKAN multipart `file`:
  // Evolution v2.3.7 mediaSticker() memakai data.sticker (bukan file) sehingga
  // upload file -> convertToWebP(undefined) -> 500 "Invalid URL".
  captured.length = 0;
  global.fetch = async (url, opts) => {
    captured.push({ url, opts });
    return new Response(JSON.stringify({ key: { id: 'STK-1', remoteJid: '628999@s.whatsapp.net', fromMe: true }, message: {}, status: 'PENDING' }), { status: 201 });
  };
  const stickerBytes = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
  const realSticker = await realClient.sendSticker({ number: '628999', buffer: stickerBytes });
  const stkCall = captured[0];
  assert.ok(stkCall.url.endsWith('/message/sendSticker/inst-uji'), 'path sendSticker benar');
  assert.strictEqual(stkCall.opts.headers['Content-Type'], 'application/json', 'sticker dikirim sebagai JSON');
  assert.strictEqual(typeof stkCall.opts.body, 'string', 'body JSON string, bukan FormData');
  const stkBody = JSON.parse(stkCall.opts.body);
  assert.strictEqual(stkBody.number, '628999');
  assert.strictEqual(stkBody.sticker, stickerBytes.toString('base64'), 'sticker = base64 di body');
  assert.strictEqual(realSticker.messageId, 'STK-1');

  global.fetch = realFetch;
  console.log('OK: mapping klien benar.');

  console.log('\nSEMUA ASSERT LULUS (0 gagal).');
})()
  .catch((err) => {
    console.error('GAGAL:', err);
    console.error('Log terakhir:', logs.slice(-8));
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await new Promise((resolve) => server.close(resolve)); } catch (err) { /* */ }
    try { incomingBuffer.close(); } catch (err) { /* */ }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { /* */ }
  });
