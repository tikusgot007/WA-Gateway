'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-dead-letter-'));
const sqlitePath = path.join(tmpDir, 'fixture.sqlite');
const singletonPath = path.join(tmpDir, 'singleton.sqlite');
const jsonPath = path.join(tmpDir, 'gateway.json');
process.env.SQLITE_PATH = singletonPath;
process.env.DELIVERY_DEAD_BURST_THRESHOLD = '2';

const Database = require('better-sqlite3');
const logger = require('../src/logging');
const incomingBufferModule = require('../src/store/incomingBuffer');
const { IncomingBufferJsonFile, IncomingBufferSqlite } = incomingBufferModule;

function makeEvent(id) {
  return {
    messageId: id,
    chatId: '628111000401@s.whatsapp.net',
    jidType: 'pn',
    messageType: 'text',
    text: `test-${id}`,
    timestamp: new Date().toISOString(),
  };
}

function captureErrors(run) {
  const original = logger.error;
  const errors = [];
  logger.error = (message, meta) => errors.push({ message, meta });
  try {
    return { result: run(), errors };
  } finally {
    logger.error = original;
  }
}

function exerciseStore(buffer, label) {
  const errors = [];
  const originalError = logger.error;
  logger.error = (message, meta) => errors.push({ message, meta });

  try {
    assert.strictEqual(buffer.logDeadLetterStartup(), 0);
    assert.strictEqual(errors.length, 0, `${label}: start tanpa dead tidak boleh error`);

    const old = new Date(Date.now() - 86401000).toISOString();
    const ageEvent = buffer.enqueue(makeEvent('SIM-AGE'));
    assert.strictEqual(ageEvent.status, 'inserted');
    const ageId = buffer.getDueEvents(10).find((row) => row.wa_message_id === 'SIM-AGE').id;
    buffer.db?.exec(`UPDATE incoming_queue SET created_at = '${old}' WHERE wa_message_id = 'SIM-AGE'`);
    if (!buffer.db) {
      buffer.rows.find((row) => row.wa_message_id === 'SIM-AGE').created_at = old;
    }

    assert.strictEqual(buffer.enqueue(makeEvent('SIM-CAP')).status, 'inserted');
    const cap = buffer.getDueEvents(10).find((row) => row.wa_message_id === 'SIM-CAP');
    buffer.db?.exec(`UPDATE incoming_queue SET attempts = 99 WHERE id = ${cap.id}`);
    if (!buffer.db) buffer.rows.find((row) => row.id === cap.id).attempts = 99;

    const ageResult = buffer.markFailedAttempt(ageId, 0, 'usia terlampaui');
    assert.strictEqual(ageResult.deadLettered, true, `${label}: AC-033 max_age`);
    assert.ok(ageResult.nextAttemptAt, `${label}: kompatibilitas return retry`);

    const capResult = buffer.markFailedAttempt(cap.id, 98, 'cap tercapai');
    assert.strictEqual(capResult.deadLettered, true, `${label}: AC-033 max_attempts`);
    const deadIds = new Set(buffer.getDueEvents(10).map((row) => row.id));
    assert.ok(!deadIds.has(ageId), `${label}: AC-034 dead tidak due`);
    assert.ok(!deadIds.has(cap.id), `${label}: AC-034 dead tidak due`);

    const rows = buffer.db
      ? buffer.db.prepare('SELECT * FROM incoming_queue WHERE id IN (?, ?)').all(ageId, cap.id)
      : buffer.rows.filter((row) => row.id === ageId || row.id === cap.id);
    const ageRow = rows.find((row) => row.id === ageId);
    const capRow = rows.find((row) => row.id === cap.id);
    assert.strictEqual(ageRow.status, 'dead');
    assert.strictEqual(ageRow.attempts, 1);
    assert.strictEqual(ageRow.last_error, 'usia terlampaui');
    assert.ok(ageRow.dead_lettered_at, `${label}: AC-035 timestamp terisi`);
    // Percobaan ke-100 dihitung sekali; transisi dead tidak menambah counter lagi.
    assert.strictEqual(capRow.attempts, 100);
    assert.strictEqual(capRow.last_error, 'cap tercapai');
    assert.ok(capRow.dead_lettered_at, `${label}: AC-035 timestamp terisi`);

    const critical = errors.filter((entry) => String(entry.message).includes('[CRITICAL]'));
    assert.strictEqual(critical.length, 2, `${label}: dua log dead`);
    assert.ok(critical.some((entry) => entry.meta.waMessageId === 'SIM-AGE' && entry.meta.reason === 'max_age'));
    assert.ok(critical.some((entry) => entry.meta.waMessageId === 'SIM-CAP' && entry.meta.reason === 'max_attempts'));

    assert.strictEqual(buffer.replayDeadLetter(ageId), true);
    const replayed = buffer.db
      ? buffer.db.prepare('SELECT status, attempts, next_attempt_at FROM incoming_queue WHERE id = ?').get(ageId)
      : buffer.rows.find((row) => row.id === ageId);
    assert.strictEqual(replayed.status, 'failed');
    assert.strictEqual(replayed.attempts, 1, `${label}: attempts replay dipertahankan`);
    assert.ok(Math.abs(Date.parse(replayed.next_attempt_at) - Date.now()) < 2000);
    assert.strictEqual(buffer.replayDeadLetter(ageId), false, `${label}: replay tepat satu siklus`);

    for (const id of ['SIM-DEAD-1', 'SIM-DEAD-2']) {
      buffer.enqueue(makeEvent(id));
      const event = buffer.getDueEvents(10).find((row) => row.wa_message_id === id);
      buffer.markPermanentDead(event.id, 'permanent rejection fixture');
    }
    const beforeBurst = buffer.countDeadLettered();
    assert.strictEqual(beforeBurst, 3, `${label}: tiga baris dead sebelum start`);
    errors.length = 0;
    assert.strictEqual(buffer.logDeadLetterStartup(), beforeBurst);
    assert.strictEqual(errors.length, 1, `${label}: AC-038 start tiga baris dead`);
    assert.strictEqual(errors[0].meta.deadLettered, 3, `${label}: jumlah dead saat start`);
    buffer.logDeadLetterBurst(beforeBurst, beforeBurst + 2);
    assert.strictEqual(errors.length, 1, `${label}: burst tepat ambang tidak critical`);
    buffer.logDeadLetterBurst(beforeBurst, beforeBurst + 3);
    assert.ok(errors.some((entry) => String(entry.message).includes('[CRITICAL]')
      && String(entry.message).includes('hentikan replay otomatis')));
  } finally {
    logger.error = originalError;
  }
}

let sqlite;
let json;
try {
  sqlite = new IncomingBufferSqlite(Database, sqlitePath);
  exerciseStore(sqlite, 'SQLite');
  sqlite.close();
  sqlite = null;
  console.log('OK SQLite: AC-033, AC-034, AC-035, AC-037, AC-038.');

  json = new IncomingBufferJsonFile(jsonPath);
  exerciseStore(json, 'JSON');
  json.close();
  json = null;
  console.log('OK JSON: AC-033, AC-034, AC-035, AC-037, AC-038.');

  console.log(`SELURUH ASSERT LULUS; database sementara: ${tmpDir}`);
} finally {
  if (sqlite) sqlite.close();
  if (json) json.close();
  incomingBufferModule.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
