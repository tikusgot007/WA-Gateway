'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logging');

/**
 * Store kecil untuk memetakan `wa_message_id` (yang dikirim ke CI4 saat
 * pesan masuk) -> `{ key, message }` asli Evolution, supaya balasan
 * (`quoted`) dari kasir bisa dibentuk ulang sebagai
 * `quoted: { key: { id, remoteJid, fromMe }, message: {...} }` yang
 * dibutuhkan Evolution (lihat src/validate/message.schema.ts resmi:
 * `quoted.key.id` wajib).
 *
 * KEPUTUSAN DESAIN (§6.1 rencana): DISIMPAN, bukan didegradasi, supaya
 * quote berfungsi penuh. TTL (config.quotedStoreTtlMs, bawaan 7 hari)
 * membatasi pertumbuhan tabel -- balasan ke pesan yang lebih tua dari TTL
 * akan terdegradasi ke pesan biasa (quote_applied:false), konsisten
 * dengan pola degradasi yang sudah ada di adapter Fonnte.
 *
 * Memakai SQLite (berkas yang sama dengan incoming_queue/outgoing_operations)
 * bila `better-sqlite3` tersedia. Kutipan BUKAN data kritis (kegagalan
 * menyimpan hanya menurunkan kualitas UX balasan, bukan kehilangan pesan),
 * jadi fallback ke Map in-memory dengan TTL yang sama bila native addon
 * tidak tersedia -- TIDAK menghalangi start adapter.
 */

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS quoted_messages (
    wa_message_id TEXT PRIMARY KEY,
    key_json      TEXT NOT NULL,
    message_json  TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_quoted_messages_created_at
    ON quoted_messages (created_at);
`;

class QuotedStoreSqlite {
  constructor(Database, dbPath = config.sqlitePath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(CREATE_TABLE_SQL);

    this.upsertStmt = this.db.prepare(`
      INSERT INTO quoted_messages (wa_message_id, key_json, message_json, created_at)
      VALUES (@waMessageId, @keyJson, @messageJson, @now)
      ON CONFLICT(wa_message_id) DO UPDATE SET
        key_json = excluded.key_json, message_json = excluded.message_json
    `);
    this.getStmt = this.db.prepare('SELECT * FROM quoted_messages WHERE wa_message_id = @waMessageId');
    this.pruneStmt = this.db.prepare('DELETE FROM quoted_messages WHERE created_at < @cutoff');

    logger.info('SQLite quoted store siap', { path: dbPath });
  }

  save(waMessageId, key, message) {
    if (!waMessageId || !key) return;
    this.upsertStmt.run({
      waMessageId: String(waMessageId),
      keyJson: JSON.stringify(key),
      messageJson: JSON.stringify(message || {}),
      now: new Date().toISOString(),
    });
  }

  get(waMessageId) {
    if (!waMessageId) return null;
    const row = this.getStmt.get({ waMessageId: String(waMessageId) });
    if (!row) return null;
    try {
      return { key: JSON.parse(row.key_json), message: JSON.parse(row.message_json) };
    } catch (err) {
      return null;
    }
  }

  prune(olderThanMs = config.quotedStoreTtlMs) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    return this.pruneStmt.run({ cutoff }).changes;
  }

  close() {
    this.db.close();
  }
}

class QuotedStoreMemory {
  constructor() {
    this.map = new Map(); // waMessageId -> { key, message, createdAt }
    logger.warn('better-sqlite3 tidak tersedia, memakai fallback in-memory untuk quoted store (hilang saat restart).');
  }

  save(waMessageId, key, message) {
    if (!waMessageId || !key) return;
    this.map.set(String(waMessageId), { key, message: message || {}, createdAt: Date.now() });
  }

  get(waMessageId) {
    if (!waMessageId) return null;
    const entry = this.map.get(String(waMessageId));
    return entry ? { key: entry.key, message: entry.message } : null;
  }

  prune(olderThanMs = config.quotedStoreTtlMs) {
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const [id, entry] of this.map) {
      if (entry.createdAt < cutoff) {
        this.map.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  close() {
    // no-op
  }
}

let Database = null;
try {
  // eslint-disable-next-line global-require
  Database = require('better-sqlite3');
} catch (err) {
  // fallback ditangani di bawah
}

const instance = Database ? new QuotedStoreSqlite(Database) : new QuotedStoreMemory();

module.exports = instance;
module.exports.QuotedStoreSqlite = QuotedStoreSqlite;
module.exports.QuotedStoreMemory = QuotedStoreMemory;
