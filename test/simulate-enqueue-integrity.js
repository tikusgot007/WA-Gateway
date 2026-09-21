'use strict';
/**
 * Skrip simulasi M1 Wave 1 TASK-001 (REQ-006/007/008, AC-005, AC-006):
 * integritas enqueue() -- validasi field wajib, pemeriksaan hasil insert,
 * dan status 'inserted' / 'duplicate'. Dibuat TASK-001, dilengkapi TASK-006.
 *
 * Semua berkas sementara ada di folder temp dan dihapus setelah tes.
 * Jalankan: node test/simulate-enqueue-integrity.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-enqueue-integrity-'));
// Singleton di modul incomingBuffer dibuat saat require -- arahkan ke temp
// supaya tidak menyentuh data/ asli.
process.env.SQLITE_PATH = path.join(tmpDir, 'singleton.sqlite');

const incomingBuffer = require('../src/store/incomingBuffer');
const { IncomingBufferSqlite, IncomingBufferJsonFile, EnqueueValidationError } = incomingBuffer;
const Database = require('better-sqlite3');

function makeEvent(overrides = {}) {
  return {
    messageId: 'SIM-INT-1',
    chatId: '628111000301@s.whatsapp.net',
    jidType: 'pn',
    messageType: 'text',
    text: 'halo',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function rowCount(buffer) {
  return buffer.db.prepare('SELECT COUNT(*) AS n FROM incoming_queue').get().n;
}

try {
  const sqliteBuffer = new IncomingBufferSqlite(Database, path.join(tmpDir, 'isolated.sqlite'));

  console.log('--- 1. AC-005: field wajib kosong -> EnqueueValidationError, tanpa baris ---');
  for (const field of ['messageId', 'chatId', 'jidType', 'messageType', 'timestamp']) {
    const before = rowCount(sqliteBuffer);
    assert.throws(
      () => sqliteBuffer.enqueue(makeEvent({ [field]: null })),
      (err) => {
        assert.ok(err instanceof EnqueueValidationError, `${field}: harus EnqueueValidationError`);
        assert.deepStrictEqual(err.missing, [field]);
        assert.match(err.message, /field wajib kosong/);
        return true;
      },
      `${field} kosong harus ditolak`
    );
    assert.strictEqual(rowCount(sqliteBuffer), before, `${field} kosong: tidak boleh ada baris baru`);
  }
  console.log('OK: 5 field wajib masing-masing ditolak dengan EnqueueValidationError.');

  console.log('\n--- 2. Event valid -> {status:"inserted"} ---');
  assert.deepStrictEqual(sqliteBuffer.enqueue(makeEvent()), { status: 'inserted' });
  assert.strictEqual(rowCount(sqliteBuffer), 1);
  console.log('OK: event valid tersimpan, status inserted.');

  console.log('\n--- 3. Duplikat wa_message_id -> {status:"duplicate"}, bukan error, tetap satu baris ---');
  assert.deepStrictEqual(sqliteBuffer.enqueue(makeEvent()), { status: 'duplicate' });
  assert.strictEqual(rowCount(sqliteBuffer), 1);
  console.log('OK: duplikat diabaikan, status duplicate.');

  console.log('\n--- 4. AC-006: insert tanpa baris padahal ID belum ada -> error tak terduga ---');
  const realRun = sqliteBuffer.insertStmt.run.bind(sqliteBuffer.insertStmt);
  sqliteBuffer.insertStmt.run = () => ({ changes: 0 }); // simulasi baris "hilang" senyap
  assert.throws(
    () => sqliteBuffer.enqueue(makeEvent({ messageId: 'SIM-INT-GHOST' })),
    (err) => {
      assert.ok(!(err instanceof EnqueueValidationError), 'bukan error validasi (agar tetap di-retry)');
      assert.match(err.message, /kondisi tak terduga/);
      return true;
    }
  );
  sqliteBuffer.insertStmt.run = realRun;
  assert.strictEqual(rowCount(sqliteBuffer), 1, 'tidak ada baris tambahan');
  console.log('OK: baris hilang senyap dilempar sebagai error tak terduga.');

  console.log('\n--- 5. Fallback JSON: kontrak yang sama ---');
  const jsonBuffer = new IncomingBufferJsonFile(path.join(tmpDir, 'fallback.sqlite'));
  assert.throws(
    () => jsonBuffer.enqueue(makeEvent({ messageType: undefined })),
    (err) => err instanceof EnqueueValidationError && err.missing[0] === 'messageType'
  );
  assert.strictEqual(jsonBuffer.rows.length, 0);
  assert.deepStrictEqual(jsonBuffer.enqueue(makeEvent()), { status: 'inserted' });
  assert.deepStrictEqual(jsonBuffer.enqueue(makeEvent()), { status: 'duplicate' });
  assert.strictEqual(jsonBuffer.rows.length, 1);
  console.log('OK: JSON fallback mengembalikan status dan menolak event tidak valid.');

  sqliteBuffer.close();
  console.log('\nSemua assert simulate-enqueue-integrity lolos.');
} finally {
  try {
    incomingBuffer.close(); // lepas handle singleton sebelum folder temp dihapus (Windows)
  } catch (err) {
    // abaikan
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
