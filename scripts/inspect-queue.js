'use strict';

/**
 * inspect-queue.js -- laporkan isi buffer masuk tanpa membocorkan isi pesan.
 *
 * Hanya metadata (id, wa_message_id, status, attempts, last_error, waktu).
 * Sengaja TIDAK mencetak kolom payload supaya isi pesan pelanggan tidak masuk
 * log (aturan yang diuji oleh test "SEC: isi pesan tidak bocor ke log").
 *
 * Output: D:\kilo\logs\inspect-queue.log
 */

const path = require('path');
const Database = require('better-sqlite3');
const config = require('../src/config');

function log(msg) {
  console.log(new Date().toISOString(), msg);
}

const dbPath = config.sqlitePath;
log('=== INSPECT INCOMING QUEUE ===');
log('db: ' + dbPath);

const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM incoming_queue GROUP BY status').all();
log('ringkasan status: ' + byStatus.map((r) => `${r.status}=${r.n}`).join(', '));

const dead = db.prepare(
  `SELECT id, wa_message_id, status, attempts, last_error, created_at, updated_at, dead_lettered_at
   FROM incoming_queue WHERE status = 'dead' ORDER BY id`
).all();

log('jumlah dead: ' + dead.length);
for (const r of dead) {
  log(`  id=${r.id} wa=${r.wa_message_id} attempts=${r.attempts} dibuat=${r.created_at} deadAt=${r.dead_lettered_at}`);
  log(`    last_error: ${String(r.last_error || '').slice(0, 300)}`);
}

const pending = db.prepare(
  `SELECT COUNT(*) AS n FROM incoming_queue WHERE status IN ('pending','failed')`
).get();
log('masih pending/failed: ' + pending.n);

db.close();
log('=== SELESAI ===');
