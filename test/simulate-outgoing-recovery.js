'use strict';
/**
 * Skrip simulasi M1 Wave 2 Fase 2 -- TASK-007 (lease, batas percobaan, matriks
 * respons) dan TASK-008 (tugas start-up). Router ci4Routes.js dipasang di server
 * express NYATA pada port acak, tetapi Baileys TIDAK dipakai:
 * connectionManager.sendReply/isConnected di-stub, sehingga "kiriman yang hasilnya
 * tidak pasti" bisa dibuat deterministik.
 *
 * Cakupan: AC-026 (a/b/c; (b) STUB-ONLY, A-2), AC-028 (batas lease 35000), AC-029
 * (cap 5 -> abandoned + 502 DEAD_LETTERED + [CRITICAL], sendReply tidak dipanggil),
 * AC-030 (NOT_CONNECTED tanpa baris in_flight), AC-031 (in_flight basi dicatat saat
 * start, maksimum 20 operation_id, start tidak terblokir), AC-032 (pruneTerminal:
 * terminal tua dihapus, in_flight tetap), AC-043 (baris abandoned dicatat [CRITICAL]
 * lalu dihapus; operation_id yang sama jadi operasi baru), dan AC-042 sebagai stub
 * (pengukuran nyata ada di TASK-023).
 *
 * Waktu dikendalikan lewat store.now supaya lease/TTL teruji tanpa menunggu. Semua
 * data di folder temp (SQLITE_PATH); TIDAK PERNAH menyentuh data/gateway.sqlite
 * produksi (TEST-010). Jalankan: node test/simulate-outgoing-recovery.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// HARUS sebelum modul src/ mana pun di-require: config dibaca sekali saat load,
// dan singleton store langsung membuka SQLITE_PATH saat modulnya dimuat.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-outgoing-recovery-'));
process.env.SQLITE_PATH = path.join(tmpRoot, 'gateway.sqlite');
process.env.CI4_BASE_URL = '';
process.env.CI4_GATEWAY_TOKEN = 'token-uji';

const assert = require('assert');
const express = require('express');
const logger = require('../src/logging');

// --- tangkap semua log (dan tidak mencetaknya) untuk inspeksi [CRITICAL]/SEC-001 ---
const logs = [];
for (const level of ['info', 'warn', 'error', 'debug']) {
  const original = logger[level];
  logger[level] = (message, meta) => logs.push({ level, message, meta });
}
const drainLogs = () => {
  const copy = logs.slice();
  logs.length = 0;
  return copy;
};

const { ensureBaileysLoaded } = require('../src/whatsapp/baileysLoader');
const connectionManager = require('../src/whatsapp/connectionManager');
const incomingBuffer = require('../src/store/incomingBuffer'); // ikut terbuka lewat connectionManager; ditutup saat cleanup

// --- kendali waktu: store.now() dipakai store MAUPUN service (lease/TTL) ---
const LEASE_MS = 35000; // spec 4.6 bawaan
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-09-24T06:00:00.000Z');
let nowMs = T0;

// --- stub Baileys ---
const CHAT = '628111222333@s.whatsapp.net';
const stub = { connected: true, calls: [], impl: null, seq: 0 };
connectionManager.isConnected = () => stub.connected;
connectionManager.sendReply = async (chatId, text) => {
  stub.calls.push({ chatId, text });
  if (stub.impl) return stub.impl(chatId, text);
  stub.seq += 1;
  return { messageId: `WA-${stub.seq}`, timestamp: new Date(nowMs).toISOString() };
};
function resetStub() {
  stub.connected = true;
  stub.calls = [];
  stub.impl = null;
}
const ambiguousError = () => new Error('Gagal mengirim pesan: socket putus');

// --- server nyata di port acak; restart = muat ulang modul store/service/router ---
let server;
let baseUrl;
let store;
let svc;
const REQUIRE_PATHS = [
  '../src/store/outgoingOperations',
  '../src/delivery/outgoingOperationService',
  '../src/api/ci4Routes',
];
async function startGateway() {
  store = require('../src/store/outgoingOperations');
  svc = require('../src/delivery/outgoingOperationService');
  const ci4Routes = require('../src/api/ci4Routes');
  const app = express();
  app.use(ci4Routes);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  store.now = () => nowMs; // kendali waktu untuk store DAN service
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
const section = (title) => console.log(`\n--- ${title} ---`);

// Kosongkan tabel operasi (database temp, BUKAN produksi) supaya hitungan tugas
// start-up deterministik; mendukung SQLite maupun fallback JSON.
const wipeStore = () => {
  if (store.db) store.db.prepare('DELETE FROM outgoing_operations').run();
  else {
    store.rows.clear();
    store._persist();
  }
};

(async () => {
  await ensureBaileysLoaded();
  await startGateway();

  section('AC-026: hasil sendReply -> sent (200) / failed (500) / in_flight (504); (b) STUB-ONLY');
  nowMs = Date.parse('2026-09-24T12:00:00.000Z');
  // (a) sukses -> sent/200
  resetStub();
  let res = await sendText({ operation_id: 'OP-026-OK' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.state, 'sent');
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.replayed, false);
  assert.strictEqual(store.get('OP-026-OK').state, 'sent');
  console.log('OK: (a) sukses -> sent/200.');

  // (c) error jaringan -> ambigu -> tetap in_flight + 504 SEND_UNRESOLVED
  resetStub();
  stub.impl = async () => { throw ambiguousError(); };
  res = await sendText({ operation_id: 'OP-026-AMB' });
  assert.strictEqual(res.status, 504);
  assert.strictEqual(res.body.error_code, 'SEND_UNRESOLVED');
  assert.strictEqual(res.body.state, 'in_flight');
  assert.strictEqual(res.body.success, false);
  assert.ok(/belum pasti/i.test(res.body.message), 'pesan menyatakan hasil belum pasti');
  assert.strictEqual(store.get('OP-026-AMB').state, 'in_flight');
  console.log('OK: (c) error jaringan -> in_flight/504 SEND_UNRESOLVED.');

  // (b) INVALID_CHAT_ID -> failed + 500. STUB-ONLY: pada lalu lintas normal guard
  // isDecodableJid() (connectionManager.js:891/1037) menolak JID ini dengan 400
  // SEBELUM sendReply(), jadi cabang ini BUKAN bukti perilaku produksi (A-2, spec 6).
  resetStub();
  stub.impl = async () => { const e = new Error('JID tidak dapat didecode'); e.code = 'INVALID_CHAT_ID'; throw e; };
  res = await sendText({ operation_id: 'OP-026-BADJID' });
  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.body.state, 'failed');
  assert.strictEqual(res.body.replayed, false);
  assert.strictEqual(store.get('OP-026-BADJID').state, 'failed');
  res = await sendText({ operation_id: 'OP-026-BADJID' });
  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.body.replayed, true);
  assert.strictEqual(stub.calls.length, 1, 'replay failed tidak memanggil sendReply');
  console.log('OK: (b) INVALID_CHAT_ID -> failed/500 [STUB-ONLY], replay tetap 500.');

  section(`AC-028: lease ${LEASE_MS} -- 30 dtk -> 409 tanpa ubah attempts; 40 dtk -> retry & attempts naik`);
  resetStub();
  nowMs = Date.parse('2026-09-24T13:00:00.000Z');
  stub.impl = async () => { throw ambiguousError(); };
  res = await sendText({ operation_id: 'OP-LEASE' });
  assert.strictEqual(res.status, 504);
  let row = store.get('OP-LEASE');
  assert.strictEqual(row.state, 'in_flight');
  assert.strictEqual(row.attempts, 1);
  const callsAfterFirst = stub.calls.length;
  assert.strictEqual(callsAfterFirst, 1);

  nowMs += 30000; // masih di dalam lease 35000
  res = await sendText({ operation_id: 'OP-LEASE' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error_code, 'SEND_IN_PROGRESS');
  assert.strictEqual(res.body.state, 'in_flight');
  assert.strictEqual(res.body.replayed, true);
  assert.ok(/belum pasti/i.test(res.body.message), 'pesan menyatakan hasil belum pasti');
  row = store.get('OP-LEASE');
  assert.strictEqual(row.state, 'in_flight');
  assert.strictEqual(row.attempts, 1, 'attempts TIDAK berubah di dalam lease');
  assert.strictEqual(stub.calls.length, callsAfterFirst, 'tidak ada kiriman kedua di dalam lease');
  console.log('OK: 30 dtk (di dalam lease) -> 409 SEND_IN_PROGRESS, attempts tetap 1.');

  nowMs += 10000; // total 40 dtk sejak updated_at -> lease lewat
  stub.impl = null; // percobaan ulang kali ini sukses
  res = await sendText({ operation_id: 'OP-LEASE' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.state, 'sent');
  assert.strictEqual(res.body.replayed, false, 'percobaan ulang pasca-lease bukan replay');
  row = store.get('OP-LEASE');
  assert.strictEqual(row.state, 'sent');
  assert.strictEqual(row.attempts, 2, 'attempts naik setelah registerRetry() + kirim ulang');
  assert.strictEqual(stub.calls.length, callsAfterFirst + 1);
  console.log('OK: 40 dtk (lease lewat) -> retry, attempts 2, kirim ulang.');

  section('AC-030: NOT_CONNECTED -> 409 tanpa baris; percobaan berikutnya bersih; retry tidak habiskan attempts');
  resetStub();
  nowMs = Date.parse('2026-09-24T14:00:00.000Z');
  stub.connected = false;
  res = await sendText({ operation_id: 'OP-NC' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error_code, 'NOT_CONNECTED');
  assert.strictEqual(res.body.success, false);
  assert.strictEqual(store.get('OP-NC'), null, 'tidak ada baris in_flight palsu (REQ-030)');
  assert.strictEqual(stub.calls.length, 0);
  stub.connected = true;
  res = await sendText({ operation_id: 'OP-NC' });
  assert.strictEqual(res.status, 200);
  row = store.get('OP-NC');
  assert.strictEqual(row.state, 'sent');
  assert.strictEqual(row.attempts, 1, 'percobaan pertama yang bersih');
  console.log('OK: NOT_CONNECTED tidak meninggalkan baris; percobaan berikutnya attempts=1.');

  // Retry pasca-lease saat WhatsApp mati -> 409 NOT_CONNECTED, attempts TIDAK naik
  // (attempts = jumlah kiriman yang benar-benar dijalankan, REQ-029).
  resetStub();
  stub.impl = async () => { throw ambiguousError(); };
  res = await sendText({ operation_id: 'OP-NC-STALE' });
  assert.strictEqual(res.status, 504);
  assert.strictEqual(store.get('OP-NC-STALE').attempts, 1);
  nowMs += 60000; // lease lewat
  stub.impl = null;
  stub.connected = false;
  res = await sendText({ operation_id: 'OP-NC-STALE' });
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.error_code, 'NOT_CONNECTED');
  assert.strictEqual(store.get('OP-NC-STALE').attempts, 1, 'NOT_CONNECTED tidak menghabiskan percobaan');
  assert.strictEqual(stub.calls.length, 1, 'tidak ada kiriman saat tidak connected');
  stub.connected = true;
  console.log('OK: retry pasca-lease saat tidak connected -> 409, attempts tetap 1.');

  section('AC-029: cap 5 -> permintaan ke-6 = 502 DEAD_LETTERED + [CRITICAL], tanpa sendReply/registerRetry');
  resetStub();
  nowMs = Date.parse('2026-09-24T15:00:00.000Z');
  stub.impl = async () => { throw ambiguousError(); };
  const CAP = 5;
  for (let attempt = 1; attempt <= CAP; attempt += 1) {
    const before = stub.calls.length;
    res = await sendText({ operation_id: 'OP-CAP' });
    assert.strictEqual(res.status, 504, `percobaan ke-${attempt} ambigu`);
    const r = store.get('OP-CAP');
    assert.strictEqual(r.state, 'in_flight');
    assert.strictEqual(r.attempts, attempt, `attempts = ${attempt} (jumlah kiriman yang dijalankan)`);
    assert.strictEqual(stub.calls.length, before + 1, `sendReply dipanggil pada percobaan ke-${attempt}`);
    nowMs += 40000; // tunggu lease lewat sebelum percobaan ulang berikutnya
  }
  assert.strictEqual(stub.calls.length, CAP, 'sendReply tepat 5 kali (attempts 1..5)');

  drainLogs();
  res = await sendText({ operation_id: 'OP-CAP' }); // permintaan ke-6
  assert.strictEqual(res.status, 502);
  assert.strictEqual(res.body.error_code, 'DEAD_LETTERED');
  assert.strictEqual(res.body.state, 'abandoned');
  assert.strictEqual(res.body.success, false);
  assert.strictEqual(stub.calls.length, CAP, 'sendReply TIDAK dipanggil pada permintaan ke-6');
  const capRow = store.get('OP-CAP');
  assert.strictEqual(capRow.state, 'abandoned');
  assert.strictEqual(capRow.attempts, CAP, 'attempts dipertahankan = 5 (registerRetry tidak dipanggil lagi)');
  assert.ok(capRow.dead_lettered_at, 'dead_lettered_at terisi');
  const critical = drainLogs().filter((l) => l.level === 'error' && /^\[CRITICAL\]/.test(l.message));
  assert.strictEqual(critical.length, 1, 'tepat satu log [CRITICAL] dead-letter');
  assert.strictEqual(critical[0].meta.operationId, 'OP-CAP');
  assert.strictEqual(critical[0].meta.attempts, CAP);
  assert.strictEqual(critical[0].meta.reason, 'max_attempts');
  console.log('OK: 5 kiriman lalu permintaan ke-6 -> abandoned/502 + [CRITICAL], tanpa kirim.');

  // Permintaan ke-7: replay abandoned -> 502 replayed:true, tetap tanpa kirim.
  res = await sendText({ operation_id: 'OP-CAP' });
  assert.strictEqual(res.status, 502);
  assert.strictEqual(res.body.replayed, true);
  assert.strictEqual(res.body.state, 'abandoned');
  assert.strictEqual(stub.calls.length, CAP);
  console.log('OK: replay abandoned -> 502 replayed:true, tanpa kirim.');

  section('AC-042 (stub): operasi sent diajukan ulang SETELAH lease lewat -> 200 replayed:true tanpa kirim');
  // Catatan bukti: ini hanya pembuktian state machine di Node; pengukuran NYATA
  // AC-042 (kasir lewat AuliaPos) ada di Fase 5 TASK-023 dan tidak diklaim di sini.
  resetStub();
  nowMs = Date.parse('2026-09-24T16:00:00.000Z');
  res = await sendText({ operation_id: 'OP-042' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(stub.calls.length, 1);
  nowMs += 10 * 60 * 1000; // 10 menit, jauh melewati lease
  res = await sendText({ operation_id: 'OP-042' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.state, 'sent');
  assert.strictEqual(res.body.replayed, true);
  assert.strictEqual(stub.calls.length, 1, 'sendReply TIDAK dipanggil untuk replay pasca-lease');
  console.log('OK (stub-only; pengukuran nyata AC-042 di TASK-023).');

  section('SEC-001: log dan basis data tidak memuat isi pesan pada jalur ambigu');
  resetStub();
  const SECRET = 'RAHASIA-RECOVERY-ISI-PESAN-789';
  stub.impl = async () => { throw ambiguousError(); };
  drainLogs();
  await post('/send', { chat_id: CHAT, text: SECRET, operation_id: 'OP-SEC-R1' });
  await post('/send', { chat_id: CHAT, text: `${SECRET} lain`, operation_id: 'OP-SEC-R2' });
  const emitted = JSON.stringify(drainLogs());
  assert.ok(!emitted.includes(SECRET), 'isi pesan tidak boleh muncul di log');
  if (store.db) {
    const dump = JSON.stringify(store.db.prepare('SELECT * FROM outgoing_operations').all());
    assert.ok(!dump.includes(SECRET), 'isi pesan tidak boleh tersimpan di outgoing_operations');
  }
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
