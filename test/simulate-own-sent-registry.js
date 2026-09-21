'use strict';
/**
 * Skrip simulasi M1 Wave 1 TASK-008 (REQ-003, ASSUMPTION-001): daftar ID
 * kiriman sendiri -- pencatatan, kedaluwarsa (TTL), batas ukuran, dan
 * konfigurasi env. Waktu disuntik (bukan menunggu 10 menit sungguhan).
 *
 * Tidak membuka database dan tidak menyentuh berkas apa pun.
 * Jalankan: node test/simulate-own-sent-registry.js
 */
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { OwnSentRegistry } = require('../src/whatsapp/ownSentRegistry');

/** Jam palsu yang bisa dimajukan. */
function makeClock(start = 1_000_000) {
  const clock = { t: start, now: () => clock.t, advance(ms) { clock.t += ms; } };
  return clock;
}

console.log('--- 1. register -> wasSentByUs true; ID tak dikenal -> false ---');
let clock = makeClock();
let registry = new OwnSentRegistry({ ttlMs: 600000, max: 1000, now: clock.now });
registry.register('MSG-1');
assert.strictEqual(registry.wasSentByUs('MSG-1'), true);
assert.strictEqual(registry.wasSentByUs('MSG-LAIN'), false);
assert.strictEqual(registry.wasSentByUs(undefined), false);
registry.register(null); // tidak melempar dan tidak tersimpan
registry.register('');
assert.strictEqual(registry.size(), 1, 'ID kosong diabaikan');
console.log('OK: tercatat dikenali, tak dikenal dan ID kosong ditolak.');

console.log('\n--- 2. TTL: tepat di batas masih berlaku, lewat batas kedaluwarsa dan dibersihkan ---');
clock = makeClock();
registry = new OwnSentRegistry({ ttlMs: 600000, max: 1000, now: clock.now });
registry.register('MSG-TTL');
clock.advance(600000); // tepat 10 menit
assert.strictEqual(registry.wasSentByUs('MSG-TTL'), true, 'tepat di batas TTL masih berlaku');
clock.advance(1); // lewat 10 menit + 1 ms
assert.strictEqual(registry.wasSentByUs('MSG-TTL'), false, 'lewat TTL -> kedaluwarsa');
assert.strictEqual(registry.size(), 0, 'entri kedaluwarsa dibersihkan saat dicek');
console.log('OK: kedaluwarsa setelah 10 menit dan entrinya dibersihkan.');

console.log('\n--- 3. Batas ukuran: melebihi max -> ID TERLAMA dikeluarkan ---');
clock = makeClock();
registry = new OwnSentRegistry({ ttlMs: 600000, max: 3, now: clock.now });
['A', 'B', 'C'].forEach((id) => { registry.register(id); clock.advance(10); });
registry.register('D'); // penuh -> A (terlama) keluar
assert.strictEqual(registry.size(), 3);
assert.strictEqual(registry.wasSentByUs('A'), false, 'yang terlama dikeluarkan');
['B', 'C', 'D'].forEach((id) => assert.strictEqual(registry.wasSentByUs(id), true, `${id} tetap ada`));
console.log('OK: A keluar, B/C/D bertahan.');

console.log('\n--- 4. Mencatat ulang ID yang sama -> pindah ke posisi terbaru (tidak jadi yang terlama) ---');
clock = makeClock();
registry = new OwnSentRegistry({ ttlMs: 600000, max: 3, now: clock.now });
['A', 'B', 'C'].forEach((id) => registry.register(id));
registry.register('A'); // A jadi terbaru; B sekarang terlama
registry.register('D'); // penuh -> B keluar, bukan A
assert.strictEqual(registry.wasSentByUs('B'), false, 'B (terlama setelah A diperbarui) keluar');
assert.strictEqual(registry.wasSentByUs('A'), true, 'A dipertahankan');
assert.strictEqual(registry.size(), 3, 'pencatatan ulang tidak menggandakan entri');
console.log('OK: pencatatan ulang menyegarkan usia entri.');

console.log('\n--- 5. Ukuran max=1: ID yang baru dicatat tidak pernah langsung terbuang ---');
registry = new OwnSentRegistry({ ttlMs: 600000, max: 1, now: makeClock().now });
registry.register('X');
registry.register('Y');
assert.strictEqual(registry.wasSentByUs('Y'), true);
assert.strictEqual(registry.wasSentByUs('X'), false);
console.log('OK: hanya yang terbaru bertahan.');

console.log('\n--- 6. Konfigurasi OWN_SENT_TTL_MS / OWN_SENT_MAX (GUD-001) ---');
const repoRoot = path.resolve(__dirname, '..');
const readConfig = (envOverrides) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ['-e', "const c = require('./src/config'); console.log(JSON.stringify([c.ownSentTtlMs, c.ownSentMax]))"],
      { cwd: repoRoot, env: { ...process.env, OWN_SENT_TTL_MS: '', OWN_SENT_MAX: '', ...envOverrides }, encoding: 'utf8' }
    )
  );
assert.deepStrictEqual(readConfig({}), [600000, 1000], 'bawaan 10 menit dan 1000');
assert.deepStrictEqual(readConfig({ OWN_SENT_TTL_MS: '30000', OWN_SENT_MAX: '50' }), [30000, 50], 'kustom');
assert.deepStrictEqual(readConfig({ OWN_SENT_TTL_MS: 'x', OWN_SENT_MAX: 'x' }), [600000, 1000], 'tidak valid -> bawaan');
assert.strictEqual(readConfig({ OWN_SENT_MAX: '0' })[1], 1, '0 dijaga minimal 1');
console.log('OK: bawaan, kustom, tidak valid, dan batas bawah.');

console.log('\nSemua assert simulate-own-sent-registry lolos.');
