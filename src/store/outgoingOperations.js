'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logging');

/**
 * Store operasi KIRIM KELUAR (M1 Wave 2 TASK-002, spec 4.1/4.4): satu baris per
 * `operation_id` yang dibuat pemanggil (frontend AuliaPos) untuk satu niat
 * kirim. Baris ini yang menentukan apakah permintaan ulang boleh mengirim ke
 * WhatsApp lagi -- tanpa itu setiap retry manusia adalah kiriman baru (GW-09).
 *
 * Ini buffer KENDALI operasi, BUKAN riwayat percakapan (CON-010): tidak ada
 * isi pesan maupun base64 media di sini, hanya hash payload (SEC-001).
 *
 * State machine (spec 4.2):
 *   in_flight -> sent | failed | abandoned   (terminal, tidak pernah berubah lagi)
 *   in_flight -> in_flight                   (markUnresolved / registerRetry)
 * Semua transisi di bawah dijaga `WHERE state = 'in_flight'`, jadi baris
 * terminal kebal terhadap pemanggilan yang terlambat/ganda.
 *
 * DUA implementasi dengan API identik, pola yang sama dengan incomingBuffer.js:
 * - OutgoingOperationsSqlite: `better-sqlite3`, berkas database yang SAMA dengan
 *   incoming_queue (D-08). Koneksinya sendiri; pemeriksaan integritas/karantina
 *   berkas korup sudah dilakukan incomingBuffer saat dimuat -- database yang
 *   gagal dibuka di sini dilempar keras (tidak pernah pindah diam-diam ke JSON,
 *   supaya operasi tidak "hilang" ke berkas yang tak dibaca lagi).
 * - OutgoingOperationsJsonFile: fallback murni JS (build Android, ASSUMPTION-007).
 *   Paritas perilakunya diuji, tetapi belum pernah dijalankan di lingkungan
 *   Android nyata (RISK-003 ii).
 *
 * Waktu lewat `this.now()` (bisa ditimpa test) supaya TTL/lease teruji tanpa menunggu.
 */

const TERMINAL_STATES = ['sent', 'failed', 'abandoned'];
const VALID_KINDS = ['text', 'media'];
// Enum tunggal alasan dead-letter (spec 2, A-6). Di jalur kirim keluar hanya
// `max_attempts` yang dipakai; nilai lain ikut diterima supaya enum-nya satu.
const ABANDON_REASONS = ['max_attempts', 'max_age', 'permanent_rejection'];
const MAX_LISTED_IDS = 20; // batas daftar operation_id di log (REQ-031/REQ-032)
const MAX_ERROR_LENGTH = 500; // last_error hanya diagnosa singkat, bukan dump

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS outgoing_operations (
    operation_id        TEXT PRIMARY KEY,
    payload_hash        TEXT NOT NULL,
    kind                TEXT NOT NULL,
    chat_id             TEXT NOT NULL,
    state               TEXT NOT NULL DEFAULT 'in_flight',
    wa_message_id       TEXT,
    media_ref_json      TEXT,
    attempts            INTEGER NOT NULL DEFAULT 1,
    last_error          TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    resolved_at         TEXT,
    dead_lettered_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_outgoing_operations_state
    ON outgoing_operations (state, updated_at);
`;

function assertBeginArgs({ operationId, payloadHash, kind, chatId }) {
  if (!operationId || !payloadHash || !chatId || !VALID_KINDS.includes(kind)) {
    throw new Error('outgoingOperations.begin(): operationId, payloadHash, kind (text|media), dan chatId wajib diisi');
  }
}

function assertAbandonReason(reason) {
  if (!ABANDON_REASONS.includes(reason)) {
    throw new Error(`outgoingOperations.abandon(): reason harus salah satu dari ${ABANDON_REASONS.join(', ')}, diterima: ${reason}`);
  }
}

function shortError(message) {
  return String(message == null ? '' : message).slice(0, MAX_ERROR_LENGTH);
}

// D-13/A-5: baris abandoned yang akan dipangkas MUST terlihat lebih dulu --
// jejak dead-letter tidak boleh hilang tanpa suara.
function logPrunedAbandoned(abandonedRows) {
  if (abandonedRows.length === 0) return;
  logger.error('[CRITICAL] operasi kirim keluar berstatus abandoned dipangkas (melewati TTL)', {
    severity: 'critical',
    jumlah: abandonedRows.length,
    operationIds: abandonedRows.slice(0, MAX_LISTED_IDS).map((r) => r.operation_id),
  });
}

// REQ-029/AC-029: setiap operasi yang masuk dead-letter tercatat keras, tanpa isi pesan (SEC-001).
function logAbandoned(row, reason) {
  logger.error('[CRITICAL] operasi kirim keluar mencapai batas percobaan -- abandoned (dead-letter), tidak akan dikirim lagi', {
    severity: 'critical',
    operationId: row.operation_id,
    chatId: row.chat_id,
    attempts: row.attempts,
    lastError: row.last_error,
    reason,
  });
}

class OutgoingOperationsSqlite {
  // dbPath bisa disuntik supaya testable terisolasi; pemakaian normal aplikasi
  // memakai config.sqlitePath (berkas yang sama dengan incoming_queue).
  constructor(Database, dbPath = config.sqlitePath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.now = () => Date.now();
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL'); // baris in_flight HARUS durable sebelum kirim (REQ-021)
    this.db.exec(CREATE_TABLE_SQL);

    this.insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO outgoing_operations
        (operation_id, payload_hash, kind, chat_id, state, attempts, created_at, updated_at)
      VALUES
        (@operationId, @payloadHash, @kind, @chatId, 'in_flight', 1, @now, @now)
    `);
    this.getStmt = this.db.prepare('SELECT * FROM outgoing_operations WHERE operation_id = @operationId');
    this.markSentStmt = this.db.prepare(`
      UPDATE outgoing_operations
      SET state = 'sent', wa_message_id = @waMessageId, media_ref_json = @mediaRefJson,
          resolved_at = @now, updated_at = @now
      WHERE operation_id = @operationId AND state = 'in_flight'
    `);
    this.markFailedStmt = this.db.prepare(`
      UPDATE outgoing_operations
      SET state = 'failed', last_error = @error, resolved_at = @now, updated_at = @now
      WHERE operation_id = @operationId AND state = 'in_flight'
    `);
    this.markUnresolvedStmt = this.db.prepare(`
      UPDATE outgoing_operations
      SET last_error = @error, updated_at = @now
      WHERE operation_id = @operationId AND state = 'in_flight'
    `);
    this.registerRetryStmt = this.db.prepare(`
      UPDATE outgoing_operations
      SET attempts = attempts + 1, updated_at = @now
      WHERE operation_id = @operationId AND state = 'in_flight'
    `);
    this.abandonStmt = this.db.prepare(`
      UPDATE outgoing_operations
      SET state = 'abandoned', dead_lettered_at = @now, resolved_at = @now, updated_at = @now
      WHERE operation_id = @operationId AND state = 'in_flight'
    `);
    this.listStaleStmt = this.db.prepare(`
      SELECT * FROM outgoing_operations
      WHERE state = 'in_flight' AND updated_at < @cutoff
      ORDER BY created_at ASC
    `);
    this.countInFlightStmt = this.db.prepare(`
      SELECT COUNT(*) AS n FROM outgoing_operations WHERE state = 'in_flight'
    `);
    this.listPrunableAbandonedStmt = this.db.prepare(`
      SELECT * FROM outgoing_operations WHERE state = 'abandoned' AND created_at < @cutoff
      ORDER BY created_at ASC
    `);
    this.pruneStmt = this.db.prepare(`
      DELETE FROM outgoing_operations
      WHERE state IN ('sent', 'failed', 'abandoned') AND created_at < @cutoff
    `);
    this.pruneTx = this.db.transaction((cutoff) => {
      logPrunedAbandoned(this.listPrunableAbandonedStmt.all({ cutoff }));
      return this.pruneStmt.run({ cutoff }).changes;
    });

    logger.info('SQLite outgoing operations siap', {
      path: dbPath,
      inFlightSaatStartup: this.countInFlight(),
    });
  }

  _nowIso() {
    return new Date(this.now()).toISOString();
  }

  begin(args) {
    assertBeginArgs(args);
    const info = this.insertStmt.run({ ...args, now: this._nowIso() });
    if (info.changes === 1) return { created: true };
    return { created: false, row: this.get(args.operationId) };
  }

  get(operationId) {
    return this.getStmt.get({ operationId }) || null;
  }

  markSent(operationId, { waMessageId = null, mediaRef = null } = {}) {
    const info = this.markSentStmt.run({
      operationId,
      waMessageId,
      mediaRefJson: mediaRef ? JSON.stringify(mediaRef) : null,
      now: this._nowIso(),
    });
    return info.changes === 1;
  }

  markFailed(operationId, errorMessage) {
    return this.markFailedStmt.run({ operationId, error: shortError(errorMessage), now: this._nowIso() }).changes === 1;
  }

  markUnresolved(operationId, errorMessage) {
    return this.markUnresolvedStmt.run({ operationId, error: shortError(errorMessage), now: this._nowIso() }).changes === 1;
  }

  registerRetry(operationId) {
    return this.registerRetryStmt.run({ operationId, now: this._nowIso() }).changes === 1;
  }

  abandon(operationId, reason) {
    assertAbandonReason(reason);
    const changed = this.abandonStmt.run({ operationId, now: this._nowIso() }).changes === 1;
    if (changed) logAbandoned(this.get(operationId), reason);
    return changed;
  }

  listStaleInFlight(olderThanMs) {
    return this.listStaleStmt.all({ cutoff: new Date(this.now() - olderThanMs).toISOString() });
  }

  countInFlight() {
    return this.countInFlightStmt.get().n;
  }

  pruneTerminal(olderThanMs) {
    return this.pruneTx(new Date(this.now() - olderThanMs).toISOString());
  }

  close() {
    this.db.close();
  }
}

class OutgoingOperationsJsonFile {
  constructor(sqlitePath = config.sqlitePath) {
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });

    this.now = () => Date.now();
    this.filePath = `${sqlitePath.replace(/\.sqlite$/i, '')}.outgoing.json`;
    this.rows = new Map();

    this._load();

    logger.info('JSON outgoing operations siap (fallback, better-sqlite3 tidak tersedia)', {
      path: this.filePath,
      inFlightSaatStartup: this.countInFlight(),
    });
  }

  _load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!parsed || !Array.isArray(parsed.rows)) throw new Error('bentuk berkas tidak dikenali');
      this.rows = new Map(parsed.rows.map((row) => [row.operation_id, row]));
    } catch (err) {
      // Karantina (bukan hapus) supaya bisa diperiksa manual; mulai kosong.
      const target = `${this.filePath}.corrupt-${Date.now()}`;
      logger.error('[CRITICAL] berkas JSON outgoing operations korup -- dipindahkan, mulai dari kosong', {
        severity: 'critical',
        filePath: this.filePath,
        quarantinePath: target,
        error: err.message,
      });
      fs.renameSync(this.filePath, target);
      this.rows = new Map();
    }
  }

  // Tulis ke berkas sementara lalu rename: berkas utama tidak pernah setengah tertulis.
  _persist() {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ rows: [...this.rows.values()] }));
    fs.renameSync(tmp, this.filePath);
  }

  _nowIso() {
    return new Date(this.now()).toISOString();
  }

  // Ubah baris HANYA bila masih in_flight (sama dengan `WHERE state = 'in_flight'` di SQLite).
  _updateInFlight(operationId, mutate) {
    const row = this.rows.get(operationId);
    if (!row || row.state !== 'in_flight') return false;
    mutate(row, this._nowIso());
    this._persist();
    return true;
  }

  begin(args) {
    assertBeginArgs(args);
    const existing = this.rows.get(args.operationId);
    if (existing) return { created: false, row: { ...existing } };
    const now = this._nowIso();
    this.rows.set(args.operationId, {
      operation_id: args.operationId,
      payload_hash: args.payloadHash,
      kind: args.kind,
      chat_id: args.chatId,
      state: 'in_flight',
      wa_message_id: null,
      media_ref_json: null,
      attempts: 1,
      last_error: null,
      created_at: now,
      updated_at: now,
      resolved_at: null,
      dead_lettered_at: null,
    });
    this._persist();
    return { created: true };
  }

  get(operationId) {
    const row = this.rows.get(operationId);
    return row ? { ...row } : null;
  }

  markSent(operationId, { waMessageId = null, mediaRef = null } = {}) {
    return this._updateInFlight(operationId, (row, now) => {
      row.state = 'sent';
      row.wa_message_id = waMessageId;
      row.media_ref_json = mediaRef ? JSON.stringify(mediaRef) : null;
      row.resolved_at = now;
      row.updated_at = now;
    });
  }

  markFailed(operationId, errorMessage) {
    return this._updateInFlight(operationId, (row, now) => {
      row.state = 'failed';
      row.last_error = shortError(errorMessage);
      row.resolved_at = now;
      row.updated_at = now;
    });
  }

  markUnresolved(operationId, errorMessage) {
    return this._updateInFlight(operationId, (row, now) => {
      row.last_error = shortError(errorMessage);
      row.updated_at = now;
    });
  }

  registerRetry(operationId) {
    return this._updateInFlight(operationId, (row, now) => {
      row.attempts += 1;
      row.updated_at = now;
    });
  }

  abandon(operationId, reason) {
    assertAbandonReason(reason);
    const changed = this._updateInFlight(operationId, (row, now) => {
      row.state = 'abandoned';
      row.dead_lettered_at = now;
      row.resolved_at = now;
      row.updated_at = now;
    });
    if (changed) logAbandoned(this.get(operationId), reason);
    return changed;
  }

  listStaleInFlight(olderThanMs) {
    const cutoff = new Date(this.now() - olderThanMs).toISOString();
    return [...this.rows.values()]
      .filter((row) => row.state === 'in_flight' && row.updated_at < cutoff)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
      .map((row) => ({ ...row }));
  }

  countInFlight() {
    return [...this.rows.values()].filter((row) => row.state === 'in_flight').length;
  }

  pruneTerminal(olderThanMs) {
    const cutoff = new Date(this.now() - olderThanMs).toISOString();
    const prunable = [...this.rows.values()].filter(
      (row) => TERMINAL_STATES.includes(row.state) && row.created_at < cutoff
    );
    logPrunedAbandoned(prunable.filter((row) => row.state === 'abandoned'));
    prunable.forEach((row) => this.rows.delete(row.operation_id));
    if (prunable.length > 0) this._persist();
    return prunable.length;
  }

  close() {
    // no-op -- tidak ada handle yang perlu ditutup untuk berkas biasa.
  }
}

// Pemilihan implementasi mengikuti incomingBuffer.js: modul better-sqlite3
// TIDAK ADA -> fallback JSON (build Android); database yang GAGAL dibuka ->
// dilempar keras, tidak pindah diam-diam ke JSON.
let Database = null;
try {
  // eslint-disable-next-line global-require
  Database = require('better-sqlite3');
} catch (err) {
  logger.warn('better-sqlite3 tidak tersedia, memakai fallback JSON file untuk outgoing operations.', {
    error: err.message,
  });
}

const instance = Database ? new OutgoingOperationsSqlite(Database) : new OutgoingOperationsJsonFile();

process.on('exit', () => {
  try {
    instance.close();
  } catch (err) {
    // abaikan saat shutdown
  }
});

module.exports = instance;
// Diekspos HANYA supaya test bisa membuat instance terisolasi (path disuntik)
// dan menguji paritas SQLite vs JSON; aplikasi memakai `instance` di atas.
module.exports.OutgoingOperationsSqlite = OutgoingOperationsSqlite;
module.exports.OutgoingOperationsJsonFile = OutgoingOperationsJsonFile;
module.exports.ABANDON_REASONS = ABANDON_REASONS;
