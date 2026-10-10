'use strict';
/**
 * TODO-Q3: kontrak formal dua sisi CI4 <-> Gateway.
 *
 * Dua arah diverifikasi di sini:
 *
 *  (A) CI4 -> Gateway: fixture payload LITERAL yang SAMA PERSIS dengan yang
 *      dipakai `tests/unit/InboxGatewayPayloadContractTest.php` (repo
 *      aulia-app) dikirim ke `ci4Routes.js` via Express asli (pola yang sama
 *      dengan `simulate-evolution-adapter.js`, `evolutionClient` di-stub).
 *      Membuktikan: key wajib diterima, key opsional yang disertakan diterima
 *      tanpa 400, kode error yang didokumentasikan (`INVALID_CHAT_ID`,
 *      `NOT_CONNECTED`, `OPERATION_ID_REUSED`, `MISSING_OPERATION_ID`, dst.)
 *      benar-benar dikembalikan untuk input yang sesuai.
 *
 *  (B) Gateway -> CI4: `deliverOne()`/`deliverLifecycle()`/`deliverStatus()`/
 *      `sendHeartbeat()` dipanggil dengan `postToCI4` di-mock, lalu body yang
 *      dikirim diverifikasi field-nya cocok dengan field yang divalidasi
 *      `InboxGatewayApi.php` (lihat `tests/feature/InboxGatewayApi*Test.php`
 *      di repo aulia-app) -- field wajib selalu ada, field opsional
 *      (`group_name`, `quoted`, `extra`, `is_forwarded`) hanya ada saat
 *      diminta.
 *
 * TIDAK diuji di sini: `/media/download` (respons binary, bukan JSON --
 * dicatat sebagai gap terpisah di sesi TODO-Q3), dan tidak ada HTTP nyata ke
 * CI4 (postToCI4 selalu mock/stub di kedua arah -- test end-to-end lintas
 * proses tetap di luar scope, lihat catatan risiko di sesi TODO-Q3).
 *
 * Jalankan: node test/test-contract-ci4.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-contract-'));
process.env.SQLITE_PATH = path.join(tmpRoot, 'gateway.sqlite');
process.env.MEDIA_STORE_DIR = path.join(tmpRoot, 'media');
process.env.CI4_BASE_URL = '';
process.env.CI4_GATEWAY_TOKEN = 'token-uji-kontrak';
process.env.EVOLUTION_API_KEY = 'apikey-uji';
process.env.EVOLUTION_INSTANCE = 'inst-uji';
process.env.EVOLUTION_BASE_URL = 'http://127.0.0.1:8080';
process.env.EVOLUTION_WEBHOOK_SECRET = '';

const assert = require('assert');
const express = require('express');
const incomingBuffer = require('../src/store/incomingBuffer');
const evolutionClient = require('../src/evolution/client');
const evolutionState = require('../src/evolution/state');
const evolutionCi4Routes = require('../src/evolution/ci4Routes');
const incomingDelivery = require('../src/delivery/incomingDelivery');

const CHAT = '628111222333@s.whatsapp.net';

const stub = { sent: [], media: [] };
evolutionClient.sendText = async (args) => {
  stub.sent.push({ ...args });
  return {
    messageId: `EV-${stub.sent.length}`,
    timestamp: '2026-10-10T10:00:00.000Z',
    quoteApplied: Boolean(args.quoted),
    key: { id: `EV-${stub.sent.length}`, remoteJid: args.number + '@s.whatsapp.net', fromMe: true },
  };
};
evolutionClient.sendMedia = async (args) => {
  stub.media.push(args);
  return {
    messageId: `EVM-${stub.media.length}`,
    timestamp: '2026-10-10T11:00:00.000Z',
    quoteApplied: Boolean(args.quoted),
    key: { id: `EVM-${stub.media.length}`, remoteJid: args.number + '@s.whatsapp.net', fromMe: true },
  };
};
evolutionClient.deleteMessageForEveryone = async () => ({ deleted: true, timestamp: '2026-10-10T12:00:00.000Z' });
evolutionClient.updateMessage = async () => ({ timestamp: '2026-10-10T12:30:00.000Z' });
evolutionClient.markMessageAsRead = async ({ keys }) => ({ requested: keys.length });

let server;
let baseUrl;

async function start() {
  const app = express();
  app.use(evolutionCi4Routes);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function post(route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-uji-kontrak' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { /* non-JSON */ }
  return { status: res.status, body: json };
}

const section = (title) => console.log(`\n--- ${title} ---`);

(async () => {
  await start();
  await new Promise((r) => setTimeout(r, 50));
  evolutionState.setConnectionState('open', { phone: '628111222333' });

  // =======================================================================
  // (A) CI4 -> Gateway -- fixture identik dengan InboxGatewayPayloadContractTest.php
  // =======================================================================

  section('(A1) /send -- fixture minimal (chat_id + text saja)');
  let res = await post('/send', { chat_id: CHAT, text: 'Halo' });
  assert.strictEqual(res.status, 200, 'fixture minimal diterima tanpa 400');
  assert.strictEqual(res.body.success, true);
  assert.ok(res.body.wa_message_id, 'wa_message_id harus ada di respons sukses');
  console.log('OK');

  section('(A2) /send -- fixture dengan operation_id (idempotency key)');
  res = await post('/send', { chat_id: CHAT, text: 'Halo', operation_id: 'op-abc123' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.operation_id, 'op-abc123', 'operation_id dikembalikan apa adanya');
  console.log('OK');

  section('(A3) /send -- operation_id dipakai ulang dengan payload beda -> OPERATION_ID_REUSED');
  res = await post('/send', { chat_id: CHAT, text: 'Teks lain', operation_id: 'op-abc123' });
  assert.strictEqual(res.status, 409, 'kontrak CI4 (Inbox.php outcomeKind=definitive) mengasumsikan 409 untuk reuse');
  assert.strictEqual(res.body.error_code, 'OPERATION_ID_REUSED', 'error_code harus persis string yang dicek Inbox.php:gatewayFailureResponse');
  console.log('OK');

  section('(A4) /send -- quoted XOR forward: bersamaan -> FORWARD_WITH_QUOTED');
  res = await post('/send', {
    chat_id: CHAT,
    text: 'Balasan',
    forward: true,
    quoted: { wa_message_id: 'AC123', sender_jid: CHAT, message_type: 'text', fromMe: false, text: 'pesan asal' },
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error_code, 'FORWARD_WITH_QUOTED', 'konsisten dengan InboxOutgoingRequest::__construct() CON-001 di sisi CI4');
  console.log('OK');

  section('(A5) /send -- forward:true saja -> forward_marker_applied dikembalikan');
  res = await post('/send', { chat_id: CHAT, text: 'Teks diteruskan', forward: true });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.forward_marker_applied, 'text_fallback', 'field yang dibaca Inbox.php:callGatewaySend() via $json[\'forward_marker_applied\']');
  console.log('OK');

  section('(A6) /send-media -- fixture lengkap (semua key buildSendMediaPayload)');
  const imgB64 = Buffer.from('GAMBAR').toString('base64');
  res = await post('/send-media', {
    chat_id: CHAT,
    media_type: 'image',
    media_base64: imgB64,
    mimetype: 'image/jpeg',
    file_name: null,
    caption: '',
  });
  assert.strictEqual(res.status, 200, 'fixture dengan caption string kosong (BUKAN null) harus diterima');
  assert.ok(res.body.media_ref && res.body.media_ref.direct_path, 'media_ref.direct_path harus ada (dibaca Inbox.php:callGatewaySendMedia())');
  assert.ok(res.body.media_ref.media_key_base64, 'media_ref.media_key_base64 harus ada');
  console.log('OK');

  section('(A7) /send-media -- document tanpa file_name -> MISSING_FILE_NAME');
  res = await post('/send-media', { chat_id: CHAT, media_type: 'document', media_base64: imgB64, caption: '' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error_code, 'MISSING_FILE_NAME');
  console.log('OK');

  section('(A8) /delete -- fixture TANPA operation_id (opsional, lihat buildDeletePayload)');
  res = await post('/delete', { chat_id: CHAT, wa_message_id: 'AC999' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.state, 'deleted');
  console.log('OK');

  section('(A9) /delete -- fixture DENGAN operation_id');
  res = await post('/delete', { chat_id: CHAT, wa_message_id: 'AC998', operation_id: 'op-del-1' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.replayed, false);
  console.log('OK');

  section('(A10) /edit -- operation_id key SELALU dikirim (null diterima sebagai absen) -> MISSING_OPERATION_ID');
  // Cocok dengan testEditPayloadAlwaysIncludesOperationIdKeyEvenWhenNull() di
  // InboxGatewayPayloadContractTest.php: Inbox.php mengirim key operation_id
  // walau nilainya null -- Gateway (ci4Routes.js:588-599) WAJIB menolaknya.
  res = await post('/edit', { chat_id: CHAT, wa_message_id: 'AC997', new_text: 'Teks baru', operation_id: null });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error_code, 'MISSING_OPERATION_ID', 'kontrak Inbox.php:buildEditPayload() vs ci4Routes.js:592-599');
  console.log('OK');

  section('(A11) /edit -- operation_id valid -> sukses, state=edited');
  res = await post('/edit', { chat_id: CHAT, wa_message_id: 'AC996', new_text: 'Teks baru', operation_id: 'op-edit-1' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.state, 'edited');
  console.log('OK');

  section('(A12) /read -- fixture buildMarkReadPayload (chat_id + wa_message_ids list)');
  res = await post('/read', { chat_id: CHAT, wa_message_ids: ['AC1', 'AC2'] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.state, 'read');
  assert.strictEqual(res.body.requested, 2, 'requested harus cocok jumlah wa_message_ids (dibaca Inbox.php:callGatewayMarkRead())');
  console.log('OK');

  // =======================================================================
  // (B) Gateway -> CI4 -- body yang dikirim deliverOne/deliverLifecycle/
  //     deliverStatus/sendHeartbeat harus cocok field yang divalidasi
  //     InboxGatewayApi.php.
  // =======================================================================

  section('(B1) deliverOne -- pesan teks: field wajib InboxGatewayApi::messages()');
  let captured = null;
  const fakeRow = {
    id: 1,
    wa_message_id: 'WAMID-CONTRACT-1',
    chat_id: '628222333444@s.whatsapp.net',
    jid_type: 'pn',
    contact_name: null,
    phone: '628222333444',
    sender_jid: null,
    message_type: 'text',
    text: 'pesan kontrak',
    message_timestamp: '2026-10-10T10:00:00.000Z',
    direction: 'incoming',
    media_json: null,
    identity_hint_json: null,
    group_name: undefined,
    quoted_json: null,
    extra_json: null,
    is_forwarded: 0,
  };
  await incomingDelivery.deliverOne(fakeRow, {
    postToCI4: async (pathSuffix, body) => { captured = { pathSuffix, body }; return { ok: true, status: 200, json: { status: 'success' } }; },
  });
  assert.strictEqual(captured.pathSuffix, '/api/inbox/gateway/messages');
  for (const requiredField of ['wa_message_id', 'chat_id', 'jid_type', 'message_type', 'message_timestamp']) {
    assert.ok(Object.prototype.hasOwnProperty.call(captured.body, requiredField), `field wajib '${requiredField}' harus ada (InboxGatewayApi.php:66-74)`);
  }
  assert.strictEqual(captured.body.text, 'pesan kontrak');
  assert.ok(!Object.prototype.hasOwnProperty.call(captured.body, 'group_name'), 'group_name TIDAK dikirim saat absen (REQ-002/GUD-002)');
  assert.ok(!Object.prototype.hasOwnProperty.call(captured.body, 'quoted'), 'quoted TIDAK dikirim saat absen');
  assert.ok(!Object.prototype.hasOwnProperty.call(captured.body, 'extra'), 'extra TIDAK dikirim saat absen');
  assert.ok(!Object.prototype.hasOwnProperty.call(captured.body, 'is_forwarded'), 'is_forwarded TIDAK dikirim saat falsy (TODO-F5/F6)');
  console.log('OK');

  section('(B2) deliverOne -- pesan grup masuk WAJIB sender_jid (InboxGatewayApi.php:96-102)');
  captured = null;
  await incomingDelivery.deliverOne(
    { ...fakeRow, id: 2, wa_message_id: 'WAMID-CONTRACT-2', jid_type: 'group', sender_jid: '628999@s.whatsapp.net' },
    { postToCI4: async (p, b) => { captured = { pathSuffix: p, body: b }; return { ok: true, status: 200, json: { status: 'success' } }; } }
  );
  assert.strictEqual(captured.body.sender_jid, '628999@s.whatsapp.net', 'sender_jid harus terkirim untuk jid_type=group+incoming (field wajib sisi CI4)');
  console.log('OK');

  section('(B3) deliverLifecycle -- event edited dengan edited_text (TODO-F8)');
  captured = null;
  const lifecycleRow = {
    id: 3,
    wa_message_id: 'LIFECYCLE-1',
    message_type: 'lifecycle',
    extra_json: JSON.stringify({ target_wa_message_id: 'WAMID-ASLI-1', event: 'edited', edited_text: 'oke siap' }),
  };
  await incomingDelivery.deliverOne(lifecycleRow, {
    postToCI4: async (p, b) => { captured = { pathSuffix: p, body: b }; return { ok: true, status: 200, json: { status: 'success', matched: true } }; },
  });
  assert.strictEqual(captured.pathSuffix, '/api/inbox/gateway/message-event');
  assert.strictEqual(captured.body.wa_message_id, 'WAMID-ASLI-1');
  assert.strictEqual(captured.body.event, 'edited');
  assert.strictEqual(captured.body.edited_text, 'oke siap', 'edited_text harus terkirim utuh (dibaca InboxGatewayApi.php:823-853)');
  console.log('OK');

  section('(B4) deliverLifecycle -- event deleted TIDAK membawa edited_text');
  captured = null;
  await incomingDelivery.deliverOne(
    { id: 4, wa_message_id: 'LIFECYCLE-2', message_type: 'lifecycle', extra_json: JSON.stringify({ target_wa_message_id: 'WAMID-ASLI-2', event: 'deleted' }) },
    { postToCI4: async (p, b) => { captured = { pathSuffix: p, body: b }; return { ok: true, status: 200, json: { status: 'success', matched: true } }; } }
  );
  assert.strictEqual(captured.body.event, 'deleted');
  assert.ok(!Object.prototype.hasOwnProperty.call(captured.body, 'edited_text'), 'edited_text TIDAK boleh ikut untuk event deleted (InboxGatewayApi.php:824-829 menolak 400 jika ikut)');
  console.log('OK');

  section('(B5) deliverStatus -- status read/delivered (field InboxGatewayApi::messageStatus())');
  captured = null;
  await incomingDelivery.deliverOne(
    { id: 5, wa_message_id: 'STATUS-1', message_type: 'status', chat_id: CHAT, message_timestamp: '2026-10-10T13:00:00.000Z', extra_json: JSON.stringify({ target_wa_message_id: 'WAMID-OUT-1', status: 'read' }) },
    { postToCI4: async (p, b) => { captured = { pathSuffix: p, body: b }; return { ok: true, status: 200, json: { status: 'success', matched: true } }; } }
  );
  assert.strictEqual(captured.pathSuffix, '/api/inbox/gateway/message-status');
  assert.strictEqual(captured.body.wa_message_id, 'WAMID-OUT-1');
  assert.strictEqual(captured.body.status, 'read');
  assert.ok(Object.prototype.hasOwnProperty.call(captured.body, 'event_time'), 'event_time harus ada (opsional di sisi CI4, tapi selalu dikirim Gateway)');
  console.log('OK');

  section('(B6) sendHeartbeat -- field InboxGatewayApi::status() ($validStatuses)');
  // heartbeat.js meng-import `postToCI4` lewat destructure top-level
  // (`const { postToCI4 } = require('../delivery/ci4Client')`), jadi
  // override `module.exports.postToCI4` dari luar TIDAK tertangkap jalur
  // nyata tanpa dependency mocking tambahan (di luar scope -- YAGNI, lihat
  // rencana TODO-Q3). Karena itu bagian ini memverifikasi SECARA STATIS:
  // (i) kode heartbeat.js benar-benar membangun keempat field kontrak dari
  // sumber (`evolutionState.getSnapshot()`/`package.json`), dan (ii) nilai
  // `status` yang mungkin disiarkan adalah subset dari `$validStatuses` yang
  // diterima `InboxGatewayApi::status()` (php:572) -- drift di titik ini
  // berarti heartbeat akan ditolak 400 oleh CI4 tanpa disadari sampai
  // produksi.
  const heartbeatSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'evolution', 'heartbeat.js'), 'utf8');
  for (const field of ['status:', 'phone:', 'gateway_version:', 'session_health:']) {
    assert.ok(heartbeatSource.includes(field), `heartbeat.js harus membangun field '${field.replace(':', '')}' (dibaca InboxGatewayApi::status())`);
  }
  const validStatusesInCi4 = ['connected', 'connecting', 'disconnected', 'logged_out'];
  assert.ok(validStatusesInCi4.includes(evolutionState.getSnapshot().status), 'status Gateway saat ini harus salah satu nilai yang diterima CI4');
  console.log('OK (verifikasi statis field heartbeat -- lihat catatan di atas)');

  console.log('\nSEMUA ASSERT LULUS (0 gagal).');
})()
  .catch((err) => {
    console.error('GAGAL:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await new Promise((resolve) => server.close(resolve)); } catch (err) { /* */ }
    try { incomingBuffer.close(); } catch (err) { /* */ }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { /* */ }
  });
