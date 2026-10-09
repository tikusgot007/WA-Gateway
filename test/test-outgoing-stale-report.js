'use strict';
/**
 * L2: baris `outgoing_operations` `in_flight` yang basi dilaporkan SEKALI saat
 * start, tidak membanjiri log tiap restart -- tanpa mengubah state (retry tetap
 * utuh). Penanda `stale_reported_at` di-set saat dilaporkan dan dilaporkan ulang
 * hanya setelah `OUTGOING_OPERATION_TTL_MS`.
 *
 * Diuji (T1-T7):
 *   T1 baris stale pertama kali -> log error + stale_reported_at ter-set.
 *   T2 start lagi dalam window < TTL -> tidak ada log error untuk id itu,
 *      stale_reported_at tidak berubah.
 *   T3 stale_reported_at dimundurkan > TTL -> log error lagi.
 *   T4 baris in_flight yang belum stale (< lease) -> tidak disentuh.
 *   T5 baris terminal (sent/failed/abandoned) -> tidak pernah di-update (guard).
 *   T6 listStaleInFlight() mengembalikan field stale_reported_at.
 *   T7 pruneTerminal() tetap tidak menyentuh in_flight (regression).
 *
 * Semua data di folder temp; TIDAK menyentuh data/gateway.sqlite.
 * Jalankan: node test/test-outgoing-stale-report.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// HARUS sebelum modul src/ mana pun di-require (config & singleton store
// membaca env saat modul dimuat).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-stale-report-'));
process.env.SQLITE_PATH = path.join(tmpRoot, 'gateway.sqlite');
process.env.LOG_FOLDER = '';
process.env.OUTGOING_LEASE_MS = '35000';
process.env.OUTGOING_OPERATION_TTL_MS = '86400000';

const assert = require('assert');

// Logger di-patch SEBELUM store/service di-require supaya kita bisa memeriksa
// level log (error untuk laporan pertama, info untuk yang disupresi) tanpa
// menulis ke console/file.
const logger = require('../src/logging');
const captured = { error: [], warn: [], info: [] };
logger.error = (message, meta) => { captured.error.push({ message, meta }); };
logger.warn = (message, meta) => { captured.warn.push({ message, meta }); };
logger.info = (message, meta) => { captured.info.push({ message, meta }); };

const store = require('../src/store/outgoingOperations');
const service = require('../src/delivery/outgoingOperationService');
const config = require('../src/config');

const CHAT_ID = '6281200000001@s.whatsapp.net';
const STALE_AGE_MS = 120000; // > lease 35000 -> pasti stale

function resetCaptured() {
  captured.error.length = 0;
  captured.warn.length = 0;
  captured.info.length = 0;
}

function beginInFlight(id) {
  const begun = store.begin({ operationId: id, payloadHash: `hash-${id}`, kind: 'text', chatId: CHAT_ID });
  assert.strictEqual(begun.created, true, `${id} harus dibuat`);
}

function backdate(id, ageMs) {
  store.db
    .prepare('UPDATE outgoing_operations SET updated_at = ? WHERE operation_id = ?')
    .run(new Date(Date.now() - ageMs).toISOString(), id);
}

function getRow(id) {
  return store.get(id);
}

function setStaleReportedAt(id, ms) {
  store.db
    .prepare('UPDATE outgoing_operations SET stale_reported_at = ? WHERE operation_id = ?')
    .run(ms, id);
}

function errorMentions(id) {
  return captured.error.some(
    (e) => e.meta && Array.isArray(e.meta.operationIds) && e.meta.operationIds.includes(id)
  );
}

function infoHasSuppression() {
  return captured.info.some((e) => /belum perlu dilaporkan ulang/.test(e.message));
}

// --- T6 (dicek lebih dulu karena murni-kolom) ------------------------------
beginInFlight('op-t6');
backdate('op-t6', STALE_AGE_MS);
{
  const list = store.listStaleInFlight(config.outgoingLeaseMs);
  const row = list.find((r) => r.operation_id === 'op-t6');
  assert.ok(row, 'T6: op-t6 harus terdaftar stale');
  assert.ok(
    Object.prototype.hasOwnProperty.call(row, 'stale_reported_at'),
    'T6: listStaleInFlight harus menyertakan field stale_reported_at'
  );
  assert.strictEqual(row.stale_reported_at, null, 'T6: nilai awal stale_reported_at harus null');
}
console.log('T6 PASS: listStaleInFlight mengembalikan field stale_reported_at');

// --- T1: laporan pertama -----------------------------------------------
beginInFlight('op-t1');
backdate('op-t1', STALE_AGE_MS);
resetCaptured();
service.runStartupRecovery();
assert.ok(errorMentions('op-t1'), 'T1: harus ada log error untuk op-t1');
assert.strictEqual(typeof getRow('op-t1').stale_reported_at, 'number', 'T1: stale_reported_at harus ter-set');
console.log('T1 PASS: stale in_flight pertama kali -> log error + stale_reported_at ter-set');

// --- T2: start lagi dalam window < TTL ---------------------------------
const reportedAtT1 = getRow('op-t1').stale_reported_at;
resetCaptured();
service.runStartupRecovery();
assert.ok(!errorMentions('op-t1'), 'T2: tidak boleh ada log error untuk op-t1 dalam window TTL');
assert.strictEqual(getRow('op-t1').stale_reported_at, reportedAtT1, 'T2: stale_reported_at tidak boleh berubah');
assert.ok(infoHasSuppression(), 'T2: harus ada log info "belum perlu dilaporkan ulang"');
console.log('T2 PASS: start ulang < TTL -> tanpa error, stale_reported_at tetap, ada info supresi');

// --- T3: setelah TTL, lapor lagi ---------------------------------------
setStaleReportedAt('op-t1', Date.now() - config.outgoingOperationTtlMs - 60000);
resetCaptured();
service.runStartupRecovery();
assert.ok(errorMentions('op-t1'), 'T3: harus ada log error lagi setelah TTL');
assert.ok(getRow('op-t1').stale_reported_at > reportedAtT1, 'T3: stale_reported_at harus diperbarui ke waktu baru');
console.log('T3 PASS: setelah > TTL -> log error lagi + stale_reported_at diperbarui');

// --- T4: baris belum stale (< lease) -> tidak disentuh ------------------
beginInFlight('op-t4');
backdate('op-t4', 1000); // < lease 35000 -> belum stale
resetCaptured();
service.runStartupRecovery();
assert.ok(!errorMentions('op-t4'), 'T4: op-t4 (belum stale) tidak boleh muncul di log error');
assert.strictEqual(getRow('op-t4').stale_reported_at, null, 'T4: op-t4 tidak boleh ditandai');
console.log('T4 PASS: in_flight belum stale tidak disentuh');

// --- T5: baris terminal tidak pernah di-update -------------------------
beginInFlight('op-t5a');
beginInFlight('op-t5b');
beginInFlight('op-t5c');
assert.strictEqual(store.markSent('op-t5a', { waMessageId: 'wa-t5a' }), true);
assert.strictEqual(store.markFailed('op-t5b', 'boom'), true);
assert.strictEqual(store.abandon('op-t5c', 'max_attempts'), true);
const changedTerminal = store.markStaleReported(['op-t5a', 'op-t5b', 'op-t5c'], Date.now());
assert.strictEqual(changedTerminal, 0, 'T5: markStaleReported tidak boleh mengubah baris terminal');
assert.strictEqual(getRow('op-t5a').stale_reported_at, null, 'T5: sent tidak tersentuh');
assert.strictEqual(getRow('op-t5b').stale_reported_at, null, 'T5: failed tidak tersentuh');
assert.strictEqual(getRow('op-t5c').stale_reported_at, null, 'T5: abandoned tidak tersentuh');
console.log('T5 PASS: guard state terbukti -- baris terminal tidak di-update');

// --- T7: pruneTerminal tidak menyentuh in_flight -----------------------
beginInFlight('op-t7');
backdate('op-t7', STALE_AGE_MS);
store.pruneTerminal(-60000); // cutoff ke depan -> semua baris terminal "tua"
assert.ok(getRow('op-t7') !== null, 'T7: in_flight harus tetap ada setelah pruneTerminal');
console.log('T7 PASS: pruneTerminal tidak menyentuh in_flight');

console.log('\nSEMUA TEST L2 PASS (T1-T7)');
