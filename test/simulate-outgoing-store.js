'use strict';
/**
 * Skrip simulasi M1 Wave 2 TASK-002: store operasi kirim keluar
 * (src/store/outgoingOperations.js) + enam variabel config baru.
 * Mencakup AC-023 (daya tahan lintas restart, tingkat store), bagian store dari
 * AC-032/AC-043 (pemangkasan TTL) dan AC-031 (operasi in_flight basi), serta
 * transisi state machine spec 4.2.
 *
 * Seluruh suite dijalankan terhadap DUA implementasi (SQLite dan fallback JSON)
 * supaya paritas terbukti (ASSUMPTION-007). Semua berkas di folder temp yang
 * dihapus setelah tes; TIDAK PERNAH menyentuh data/gateway.sqlite (TEST-010).
 * Jalankan: node test/simulate-outgoing-store.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// HARUS sebelum modul src/ mana pun di-require: config dibaca sekali saat load,
// dan singleton store langsung membuka SQLITE_PATH saat modulnya dimuat.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-outgoing-store-'));
process.env.SQLITE_PATH = path.join(tmpRoot, 'singleton', 'gateway.sqlite');
process.env.CI4_BASE_URL = '';
process.env.CI4_GATEWAY_TOKEN = '';

const assert = require('assert');
const Database = require('better-sqlite3');
const logger = require('../src/logging');
const store = require('../src/store/outgoingOperations');

const { OutgoingOperationsSqlite, OutgoingOperationsJsonFile } = store;

const T0 = Date.parse('2026-09-24T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;

let counter = 0;
const newDir = () => fs.mkdtempSync(path.join(tmpRoot, `case-${(counter += 1)}-`));

// Semua instance uji dicatat supaya bisa ditutup di akhir (Windows tidak bisa
// menghapus berkas SQLite yang handle-nya masih terbuka).
const opened = [];
const track = (instance) => {
  opened.push(instance);
  return instance;
};

const IMPLEMENTATIONS = [
  ['SQLite', (dir) => track(new OutgoingOperationsSqlite(Database, path.join(dir, 'gateway.sqlite')))],
  ['JSON fallback', (dir) => track(new OutgoingOperationsJsonFile(path.join(dir, 'gateway.sqlite')))],
];

/** Tangkap logger.error selama fn berjalan (tanpa mencetak), lalu pulihkan. */
function captureErrors(fn) {
  const original = logger.error;
  const calls = [];
  logger.error = (message, meta) => calls.push({ message, meta });
  try {
    return { result: fn(), calls };
  } finally {
    logger.error = original;
  }
}

const base = (id, extra = {}) => ({ operationId: id, payloadHash: `hash-${id}`, kind: 'text', chatId: '628123@s.whatsapp.net', ...extra });

function runSuite(label, make) {
  console.log(`\n=== Implementasi: ${label} ===`);
  const dir = newDir();
  const s = make(dir);
  let clock = T0;
  s.now = () => clock;

  console.log('--- begin(): baris baru in_flight, attempts=1; duplikat mengembalikan baris lama ---');
  assert.deepStrictEqual(s.begin(base('OP-1')), { created: true });
  let row = s.get('OP-1');
  assert.strictEqual(row.state, 'in_flight');
  assert.strictEqual(row.attempts, 1);
  assert.strictEqual(row.kind, 'text');
  assert.strictEqual(row.payload_hash, 'hash-OP-1');
  assert.strictEqual(row.created_at, new Date(T0).toISOString());
  assert.strictEqual(row.wa_message_id, null);
  assert.strictEqual(row.dead_lettered_at, null);
  const dup = s.begin(base('OP-1', { payloadHash: 'hash-lain' }));
  assert.strictEqual(dup.created, false);
  assert.strictEqual(dup.row.payload_hash, 'hash-OP-1', 'baris lama TIDAK ditimpa oleh begin() kedua');
  assert.strictEqual(s.get('TIDAK-ADA'), null);
  console.log('OK');

  console.log('--- begin(): argumen tidak lengkap/kind salah -> error, tanpa baris ---');
  assert.throws(() => s.begin(base('OP-X', { kind: 'audio' })), /wajib diisi/);
  assert.throws(() => s.begin(base('', {})), /wajib diisi/);
  assert.throws(() => s.begin(base('OP-X', { chatId: '' })), /wajib diisi/);
  assert.strictEqual(s.get('OP-X'), null);
  console.log('OK');

  console.log('--- markUnresolved(): tetap in_flight, last_error + updated_at berubah ---');
  clock = T0 + 1000;
  assert.strictEqual(s.markUnresolved('OP-1', 'socket putus'), true);
  row = s.get('OP-1');
  assert.strictEqual(row.state, 'in_flight');
  assert.strictEqual(row.last_error, 'socket putus');
  assert.strictEqual(row.updated_at, new Date(T0 + 1000).toISOString());
  assert.strictEqual(row.attempts, 1, 'attempts tidak naik oleh markUnresolved');
  console.log('OK');

  console.log('--- registerRetry(): attempts naik hanya untuk in_flight ---');
  assert.strictEqual(s.registerRetry('OP-1'), true);
  assert.strictEqual(s.get('OP-1').attempts, 2);
  assert.strictEqual(s.registerRetry('TIDAK-ADA'), false);
  console.log('OK');

  console.log('--- markSent(): terminal, simpan wa_message_id + media_ref_json; kebal panggilan berikutnya ---');
  clock = T0 + 2000;
  assert.strictEqual(s.markSent('OP-1', { waMessageId: 'WA-1', mediaRef: { direct_path: '/d', media_key_base64: 'k' } }), true);
  row = s.get('OP-1');
  assert.strictEqual(row.state, 'sent');
  assert.strictEqual(row.wa_message_id, 'WA-1');
  assert.deepStrictEqual(JSON.parse(row.media_ref_json), { direct_path: '/d', media_key_base64: 'k' });
  assert.strictEqual(row.resolved_at, new Date(T0 + 2000).toISOString());
  assert.strictEqual(s.markFailed('OP-1', 'terlambat'), false, 'terminal tidak boleh berubah');
  assert.strictEqual(s.markSent('OP-1', { waMessageId: 'WA-2' }), false);
  assert.strictEqual(s.markUnresolved('OP-1', 'x'), false);
  assert.strictEqual(s.registerRetry('OP-1'), false);
  assert.strictEqual(s.abandon('OP-1', 'max_attempts'), false);
  assert.strictEqual(s.get('OP-1').wa_message_id, 'WA-1');
  assert.strictEqual(s.get('OP-1').state, 'sent');
  console.log('OK');

  console.log('--- markSent() tanpa mediaRef -> media_ref_json NULL ---');
  s.begin(base('OP-T'));
  s.markSent('OP-T', { waMessageId: 'WA-T' });
  assert.strictEqual(s.get('OP-T').media_ref_json, null);
  console.log('OK');

  console.log('--- markFailed(): terminal failed + last_error dipotong ---');
  s.begin(base('OP-F'));
  assert.strictEqual(s.markFailed('OP-F', 'x'.repeat(2000)), true);
  row = s.get('OP-F');
  assert.strictEqual(row.state, 'failed');
  assert.strictEqual(row.last_error.length, 500);
  assert.ok(row.resolved_at);
  console.log('OK');

  console.log('--- abandon(): terminal, dead_lettered_at terisi, log [CRITICAL] tanpa isi pesan; reason divalidasi ---');
  s.begin(base('OP-A'));
  s.registerRetry('OP-A');
  s.markUnresolved('OP-A', 'timeout');
  assert.throws(() => s.abandon('OP-A', 'alasan-ngawur'), /reason harus/);
  assert.strictEqual(s.get('OP-A').state, 'in_flight', 'reason salah tidak mengubah baris');
  const abandoned = captureErrors(() => s.abandon('OP-A', 'max_attempts'));
  assert.strictEqual(abandoned.result, true);
  row = s.get('OP-A');
  assert.strictEqual(row.state, 'abandoned');
  assert.ok(row.dead_lettered_at);
  assert.strictEqual(row.attempts, 2, 'attempts dipertahankan (non-destruktif)');
  assert.strictEqual(row.last_error, 'timeout');
  assert.strictEqual(abandoned.calls.length, 1);
  assert.ok(abandoned.calls[0].message.startsWith('[CRITICAL]'));
  assert.deepStrictEqual(
    { operationId: abandoned.calls[0].meta.operationId, attempts: abandoned.calls[0].meta.attempts, reason: abandoned.calls[0].meta.reason },
    { operationId: 'OP-A', attempts: 2, reason: 'max_attempts' }
  );
  console.log('OK');

  console.log('--- countInFlight() dan listStaleInFlight() (AC-031) ---');
  const inflight = newDir(); // suite terpisah supaya hitungan tidak bercampur
  const s2 = make(inflight);
  s2.now = () => clock;
  clock = T0;
  s2.begin(base('OLD-1'));
  clock = T0 + 10 * 60 * 1000;
  s2.begin(base('NEW-1'));
  s2.begin(base('DONE-1'));
  s2.markSent('DONE-1', { waMessageId: 'W' });
  assert.strictEqual(s2.countInFlight(), 2);
  const stale = s2.listStaleInFlight(5 * 60 * 1000);
  assert.deepStrictEqual(stale.map((r) => r.operation_id), ['OLD-1'], 'hanya in_flight yang lebih tua dari ambang');
  assert.deepStrictEqual(s2.listStaleInFlight(60 * 60 * 1000), []);
  console.log('OK');

  console.log('--- pruneTerminal() (AC-032/AC-043): terminal tua dihapus, in_flight tetap, abandoned dicatat dulu ---');
  const prune = newDir();
  const s3 = make(prune);
  s3.now = () => clock;
  clock = T0;
  s3.begin(base('OLD-SENT'));
  s3.markSent('OLD-SENT', { waMessageId: 'W' });
  s3.begin(base('OLD-FAILED'));
  s3.markFailed('OLD-FAILED', 'e');
  s3.begin(base('OLD-ABANDONED'));
  s3.abandon('OLD-ABANDONED', 'max_attempts'); // log CRITICAL abandon (bukan yang diuji di sini)
  s3.begin(base('OLD-INFLIGHT'));
  clock = T0 + 20 * HOUR;
  s3.begin(base('RECENT-SENT'));
  s3.markSent('RECENT-SENT', { waMessageId: 'W2' });
  clock = T0 + 25 * HOUR;
  const pruned = captureErrors(() => s3.pruneTerminal(24 * HOUR));
  assert.strictEqual(pruned.result, 3, 'sent + failed + abandoned yang lebih tua dari 24 jam');
  assert.strictEqual(s3.get('OLD-SENT'), null);
  assert.strictEqual(s3.get('OLD-FAILED'), null);
  assert.strictEqual(s3.get('OLD-ABANDONED'), null);
  assert.strictEqual(s3.get('OLD-INFLIGHT').state, 'in_flight', 'in_flight TIDAK PERNAH dipangkas');
  assert.strictEqual(s3.get('RECENT-SENT').state, 'sent', 'terminal yang masih dalam TTL tetap ada');
  assert.strictEqual(pruned.calls.length, 1, 'satu log CRITICAL untuk baris abandoned yang dihapus');
  assert.ok(pruned.calls[0].message.startsWith('[CRITICAL]'));
  assert.strictEqual(pruned.calls[0].meta.jumlah, 1);
  assert.deepStrictEqual(pruned.calls[0].meta.operationIds, ['OLD-ABANDONED']);
  assert.strictEqual(captureErrors(() => s3.pruneTerminal(24 * HOUR)).calls.length, 0, 'tanpa abandoned tua -> tidak ada log');
  // AC-043 tingkat store: setelah dipangkas, operation_id yang sama = operasi BARU.
  assert.deepStrictEqual(s3.begin(base('OLD-SENT')), { created: true });
  assert.strictEqual(s3.get('OLD-SENT').state, 'in_flight');
  console.log('OK');

  console.log('--- pruneTerminal(): daftar abandoned dibatasi 20 id di log ---');
  const many = make(newDir());
  many.now = () => clock;
  clock = T0;
  for (let i = 0; i < 25; i += 1) {
    many.begin(base(`AB-${i}`));
    many.abandon(`AB-${i}`, 'max_attempts');
  }
  clock = T0 + 25 * HOUR;
  const manyPruned = captureErrors(() => many.pruneTerminal(24 * HOUR));
  assert.strictEqual(manyPruned.result, 25);
  assert.strictEqual(manyPruned.calls[0].meta.jumlah, 25);
  assert.strictEqual(manyPruned.calls[0].meta.operationIds.length, 20);
  console.log('OK');

  console.log('--- AC-023 (tingkat store): data bertahan setelah instance ditutup dan dibuka ulang ---');
  s.close();
  const reopened = make(dir);
  assert.strictEqual(reopened.get('OP-1').state, 'sent');
  assert.strictEqual(reopened.get('OP-1').wa_message_id, 'WA-1');
  assert.strictEqual(reopened.get('OP-F').state, 'failed');
  assert.strictEqual(reopened.get('OP-A').state, 'abandoned');
  assert.strictEqual(reopened.begin(base('OP-1')).created, false, 'operation_id lama tetap dikenali setelah restart');
  reopened.close();
  console.log('OK');

  console.log('--- SEC-002: operation_id aneh disimpan apa adanya (kueri terparameter) ---');
  const evil = make(newDir());
  const evilId = "x'; DROP TABLE outgoing_operations; --";
  assert.deepStrictEqual(evil.begin(base(evilId)), { created: true });
  assert.strictEqual(evil.get(evilId).operation_id, evilId);
  assert.deepStrictEqual(evil.begin(base('OP-SETELAH')), { created: true }, 'tabel masih utuh');
  console.log('OK');
}

(async () => {
  for (const [label, make] of IMPLEMENTATIONS) runSuite(label, make);

  console.log('\n=== Skema SQLite sesuai spec 4.4 ===');
  {
    const dir = newDir();
    const dbPath = path.join(dir, 'gateway.sqlite');
    track(new OutgoingOperationsSqlite(Database, dbPath)).close();
    const db = new Database(dbPath, { readonly: true });
    const cols = db.prepare("PRAGMA table_info('outgoing_operations')").all();
    assert.deepStrictEqual(
      cols.map((c) => c.name),
      ['operation_id', 'payload_hash', 'kind', 'chat_id', 'state', 'wa_message_id', 'media_ref_json',
        'attempts', 'last_error', 'created_at', 'updated_at', 'resolved_at', 'dead_lettered_at']
    );
    assert.strictEqual(cols.find((c) => c.name === 'operation_id').pk, 1);
    const idx = db.prepare("PRAGMA index_list('outgoing_operations')").all().map((i) => i.name);
    assert.ok(idx.includes('idx_outgoing_operations_state'));
    db.close();
    console.log('OK: 13 kolom + indeks idx_outgoing_operations_state.');
  }

  console.log('\n=== Singleton memakai SQLITE_PATH temp (bukan data/gateway.sqlite produksi) ===');
  assert.ok(store instanceof OutgoingOperationsSqlite);
  assert.ok(store.dbPath.startsWith(tmpRoot), `singleton harus di folder temp: ${store.dbPath}`);
  console.log('OK');

  console.log('\n=== Config: enam variabel baru (GUD-003) ===');
  const repoRoot = path.resolve(__dirname, '..');
  const KEYS = ['OUTGOING_MAX_ATTEMPTS', 'OUTGOING_LEASE_MS', 'OUTGOING_OPERATION_TTL_MS',
    'DELIVERY_MAX_ATTEMPTS', 'DELIVERY_DEAD_AFTER_MS', 'DELIVERY_DEAD_BURST_THRESHOLD'];
  const readConfig = (overrides) => {
    const env = { ...process.env };
    KEYS.forEach((k) => delete env[k]);
    Object.assign(env, overrides);
    const out = execFileSync(process.execPath, ['-e',
      "const c=require('./src/config');console.log(JSON.stringify([c.outgoingMaxAttempts,c.outgoingLeaseMs,c.outgoingOperationTtlMs,c.deliveryMaxAttempts,c.deliveryDeadAfterMs,c.deliveryDeadBurstThreshold]))"],
    { cwd: repoRoot, env, encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').pop());
  };
  assert.deepStrictEqual(readConfig({}), [5, 35000, 86400000, 100, 86400000, 10], 'nilai bawaan spec 4.6');
  assert.deepStrictEqual(
    readConfig(Object.fromEntries(KEYS.map((k) => [k, '0']))),
    [1, 1, 1, 1, 0, 1],
    'clamp minimum 1, kecuali DELIVERY_DEAD_AFTER_MS minimum 0 (tanpa batas usia)'
  );
  assert.deepStrictEqual(
    readConfig(Object.fromEntries(KEYS.map((k) => [k, '-7']))),
    [1, 1, 1, 1, 0, 1],
    'nilai negatif ikut di-clamp'
  );
  assert.deepStrictEqual(
    readConfig(Object.fromEntries(KEYS.map((k) => [k, 'abc']))),
    [5, 35000, 86400000, 100, 86400000, 10],
    'nilai tidak valid -> bawaan utuh'
  );
  assert.deepStrictEqual(
    readConfig({ OUTGOING_MAX_ATTEMPTS: '3', OUTGOING_LEASE_MS: '40000', DELIVERY_DEAD_AFTER_MS: '0' }),
    [3, 40000, 86400000, 100, 0, 10],
    'override lewat env tanpa ubah kode'
  );
  console.log('OK');

  console.log('\nSEMUA ASSERT LULUS (0 gagal).');
})()
  .catch((err) => {
    console.error('GAGAL:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    [...opened, store].forEach((instance) => {
      try {
        instance.close();
      } catch (err) {
        // sudah tertutup
      }
    });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
