'use strict';
/**
 * Simulasi pemeliharaan/retensi (TODO-O2): memastikan fungsi prune yang
 * dulu tak pernah dipanggil benar-benar menjaga batas pertumbuhan tanpa
 * menyentuh data yang masih dibutuhkan.
 *
 * Diuji:
 *   - incomingBuffer.pruneCompleted: hanya baris `completed` tua yang
 *     dibuang; `pending`/`failed` tetap.
 *   - IncomingBufferJsonFile.pruneCompleted (fallback tanpa better-sqlite3).
 *   - mediaStore.prune: media lebih tua dari retensi dihapus, yang baru tetap.
 *   - quotedStore.prune: kutipan lama dihapus, yang baru tetap.
 *
 * Semua data di folder temp; TIDAK menyentuh data/gateway.sqlite.
 * Jalankan: node test/simulate-maintenance.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// HARUS sebelum modul src/ mana pun di-require (config & singleton store
// membaca env saat modul dimuat).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-maintenance-'));
process.env.SQLITE_PATH = path.join(tmpRoot, 'gateway.sqlite');
process.env.MEDIA_STORE_DIR = path.join(tmpRoot, 'media');
process.env.INCOMING_QUEUE_RETENTION_DAYS = '30';

const assert = require('assert');
const incomingBuffer = require('../src/store/incomingBuffer');
const mediaStore = require('../src/evolution/mediaStore');
const quotedStore = require('../src/evolution/quotedStore');
const config = require('../src/config');

const DAY_MS = 24 * 3600 * 1000;
const FAR_FUTURE = 1000 * DAY_MS; // retensi sangat besar -> tidak ada yang "tua"
const FORCE_ALL = -60000; // cutoff 60 dtk ke depan -> semua `completed` dianggap tua

function event(messageId) {
  return {
    messageId,
    chatId: '6281200000001@s.whatsapp.net',
    jidType: 'pn',
    messageType: 'text',
    text: 'halo',
    timestamp: new Date().toISOString(),
  };
}

// enqueue() mengembalikan {status} saja, jadi id diambil lewat getDueEvents()
// (semua baris baru masih `pending` sehingga ikut terambil).
function idOf(buffer, waMessageId) {
  const row = buffer.getDueEvents(50).find((r) => r.wa_message_id === waMessageId);
  assert.ok(row, `baris ${waMessageId} harus ada`);
  return row.id;
}

// -- 1. incomingBuffer.pruneCompleted (implementasi singleton yang aktif) ----
incomingBuffer.enqueue(event('mnt-1'));
incomingBuffer.enqueue(event('mnt-2'));
incomingBuffer.enqueue(event('mnt-3'));

incomingBuffer.markCompleted(idOf(incomingBuffer, 'mnt-1'));
incomingBuffer.markFailedAttempt(idOf(incomingBuffer, 'mnt-2'), 0, 'uji gagal'); // -> failed
// mnt-3 tetap pending

assert.strictEqual(
  incomingBuffer.pruneCompleted(FAR_FUTURE),
  0,
  'retensi besar tidak boleh menghapus completed yang masih baru'
);

const removedSqlite = incomingBuffer.pruneCompleted(FORCE_ALL);
assert.ok(removedSqlite >= 1, 'completed (mnt-1) harus terhapus');
// mnt-2 (failed) & mnt-3 (pending) tetap ada -> countPending masih 2
assert.strictEqual(incomingBuffer.countPending(), 2, 'pending/failed tidak boleh ikut terhapus');

// -- 2. fallback JSON --------------------------------------------------------
const jsonBuffer = new incomingBuffer.IncomingBufferJsonFile(path.join(tmpRoot, 'jsonbuf.sqlite'));
jsonBuffer.enqueue(event('mnt-json-1'));
jsonBuffer.enqueue(event('mnt-json-2'));
jsonBuffer.markCompleted(idOf(jsonBuffer, 'mnt-json-1'));

assert.strictEqual(jsonBuffer.pruneCompleted(FAR_FUTURE), 0);
assert.strictEqual(jsonBuffer.pruneCompleted(FORCE_ALL), 1, 'completed JSON harus terhapus');
assert.strictEqual(jsonBuffer.countPending(), 1, 'pending JSON harus tetap ada');

// -- 3. mediaStore.prune -----------------------------------------------------
fs.mkdirSync(config.mediaStoreDir, { recursive: true });
const oldMedia = path.join(config.mediaStoreDir, 'lama.bin');
const newMedia = path.join(config.mediaStoreDir, 'baru.bin');
fs.writeFileSync(oldMedia, 'x');
fs.writeFileSync(newMedia, 'x');
const oldDate = new Date(Date.now() - 10 * DAY_MS);
fs.utimesSync(oldMedia, oldDate, oldDate); // 10 hari > retensi 7 hari

const removedMedia = mediaStore.prune(7 * DAY_MS);
assert.strictEqual(removedMedia, 1, '1 media lama harus dihapus');
assert.ok(!fs.existsSync(oldMedia), 'media lama harus hilang');
assert.ok(fs.existsSync(newMedia), 'media baru harus tetap ada');

// -- 4. quotedStore.prune ----------------------------------------------------
quotedStore.save('mnt-quote-lama', { id: 'k1' }, { text: 'lama' });
assert.ok(quotedStore.get('mnt-quote-lama'), 'kutipan baru harus tersimpan');
assert.strictEqual(quotedStore.prune(FAR_FUTURE), 0, 'retensi besar tidak menghapus kutipan baru');
assert.strictEqual(quotedStore.prune(FORCE_ALL), 1, 'kutipan lama harus terhapus');
assert.strictEqual(quotedStore.get('mnt-quote-lama'), null, 'kutipan lama harus hilang');

console.log('simulate-maintenance: OK');
