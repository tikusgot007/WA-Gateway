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
process.env.CI4_BASE_URL = 'http://127.0.0.1:1';
process.env.CI4_GATEWAY_TOKEN = 'test-token';

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

async function exerciseDelivery() {
  const { deliverOne } = require('../src/delivery/incomingDelivery');
  const calls = [];
  const baseEvent = {
    id: 401,
    wa_message_id: 'SIM-PERMANENT',
    chat_id: '628111000401@s.whatsapp.net',
    jid_type: 'pn',
    message_type: 'text',
    text: 'fixture',
    message_timestamp: new Date().toISOString(),
    direction: 'incoming',
    attempts: 4,
  };
  const makeDependencies = (status) => {
    const state = { status: 'pending', attempts: 4, lastError: null, nextAttemptAt: null };
    return {
      state,
      deps: {
        postToCI4: async (path) => {
          calls.push({ path, body: baseEvent });
          return { ok: false, status, json: null, error: `HTTP ${status}` };
        },
        incomingBuffer: {
          markPermanentDead: (id, error) => {
            state.status = 'dead';
            state.lastError = error;
          },
          markFailedAttempt: (id, attempts, error) => {
            state.status = 'failed';
            state.attempts += 1;
            state.lastError = error;
            state.nextAttemptAt = new Date(Date.now() + 3000).toISOString();
            return { delayMs: 3000, nextAttemptAt: state.nextAttemptAt, deadLettered: false };
          },
        },
        logger: { info() {}, warn() {} },
      },
    };
  };

  for (const status of [400, 422]) {
    const { state, deps } = makeDependencies(status);
    await deliverOne(baseEvent, deps);
    assert.strictEqual(state.status, 'dead', `HTTP ${status} harus dead`);
    assert.strictEqual(state.attempts, 4, `HTTP ${status} tidak boleh menambah attempts`);
    assert.strictEqual(state.lastError, `HTTP ${status}`);
  }

  for (const status of [401, 500]) {
    const { state, deps } = makeDependencies(status);
    await deliverOne(baseEvent, deps);
    assert.strictEqual(state.status, 'failed', `HTTP ${status} harus retryable`);
    assert.strictEqual(state.attempts, 5, `HTTP ${status} harus menambah attempts`);
    assert.ok(state.nextAttemptAt, `HTTP ${status} harus dijadwalkan ulang`);
  }

  assert.ok(calls.every((call) => call.path === '/api/inbox/gateway/messages'));
  console.log('OK delivery: AC-036 HTTP 400/422 permanen; HTTP 401/500 retryable.');
}

async function exerciseBurstTick() {
  const { tick } = require('../src/delivery/incomingDelivery');
  let deadCount = 0;
  let burstLogged = false;
  const buffer = {
    countDeadLettered: () => deadCount,
    getDueEvents: () => [{ id: 1 }, { id: 2 }, { id: 3 }],
    logDeadLetterBurst: (before, after) => {
      assert.strictEqual(before, 0);
      assert.strictEqual(after, 3);
      burstLogged = true;
    },
  };
  await tick({
    incomingBuffer: buffer,
    deliverOne: async () => {
      deadCount += 1;
    },
  });
  assert.strictEqual(deadCount, 3);
  assert.strictEqual(burstLogged, true);
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

  exerciseDelivery().then(exerciseBurstTick).then(() => {
    console.log('OK burst tick: pertambahan dead > ambang memicu [CRITICAL].');
    console.log(`SELURUH ASSERT LULUS; database sementara: ${tmpDir}`);
  }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  }).finally(() => {
    incomingBufferModule.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
} finally {
  if (sqlite) sqlite.close();
  if (json) json.close();
}
