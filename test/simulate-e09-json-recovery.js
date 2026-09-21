'use strict';
/**
 * Skrip simulasi (BUKAN pengganti test nyata) untuk memvalidasi perbaikan
 * E-09 (docs/decisions/2026-09-21-m1-ticket02-audit-enqueue.md, M1 Ticket
 * 02, P0 #2): pemulihan `IncomingBufferJsonFile` (fallback tanpa
 * better-sqlite3) saat file JSON-nya korup.
 *
 * Sebelum fix: file korup -> antrean mulai dari kosong TANPA cadangan,
 * dan penulisan berikutnya menimpa file lama yang sebenarnya masih ada
 * isinya (hilang permanen).
 * Sesudah fix: file utama yang korup dikarantina (di-rename, bukan
 * ditimpa), lalu dicoba dipulihkan dari cadangan `.bak` yang ditulis di
 * setiap `_persist()` sebelum file utama ditimpa.
 *
 * Pakai path SQLITE_PATH terpisah (test-e09-buffer) supaya tidak
 * bersinggungan dengan data Gateway nyata atau simulasi lain. TIDAK
 * memuat Baileys sama sekali -- IncomingBufferJsonFile murni file I/O.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const testSqlitePath = path.resolve(__dirname, '..', 'data', 'test-e09-buffer.sqlite');
const testJsonPath = testSqlitePath.replace(/\.sqlite$/i, '') + '.json';

function cleanup() {
  for (const suffix of ['', '.bak', '.tmp']) {
    const p = testJsonPath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  const dir = path.dirname(testJsonPath);
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(path.basename(testJsonPath) + '.corrupt-')) {
        fs.unlinkSync(path.join(dir, name));
      }
    }
  }
}

process.env.SQLITE_PATH = testSqlitePath;
cleanup();

const { IncomingBufferJsonFile } = require('../src/store/incomingBuffer');

function makeEvent(messageId) {
  return {
    messageId,
    chatId: '628111000401@s.whatsapp.net',
    jidType: 'pn',
    messageType: 'text',
    text: `pesan ${messageId}`,
    timestamp: new Date().toISOString(),
  };
}

(async () => {
  console.log('--- 1. Round trip normal: enqueue lalu instance baru bisa membaca lagi ---');
  let buf = new IncomingBufferJsonFile();
  buf.enqueue(makeEvent('SIM-E09-1'));
  assert.strictEqual(buf.countPending(), 1);
  let buf2 = new IncomingBufferJsonFile();
  assert.strictEqual(buf2.countPending(), 1, 'instance baru harus membaca data yang sama dari disk');
  console.log('OK: round trip normal bekerja (tidak ada regresi).');

  console.log('\n--- 2. File utama korup, cadangan (.bak) ada -> pulih dari .bak, file korup dikarantina ---');
  // enqueue kedua supaya _persist() kedua menulis .bak berisi state SETELAH enqueue pertama.
  buf2.enqueue(makeEvent('SIM-E09-2'));
  assert.ok(fs.existsSync(`${testJsonPath}.bak`), '.bak harus ada setelah _persist() kedua');
  const bakContent = fs.readFileSync(`${testJsonPath}.bak`, 'utf8');
  const bakRowCount = JSON.parse(bakContent).rows.length;

  fs.writeFileSync(testJsonPath, '{ ini bukan JSON valid');
  const buf3 = new IncomingBufferJsonFile();
  assert.strictEqual(buf3.countPending(), bakRowCount, 'harus pulih dari .bak, jumlah baris sama seperti isi .bak');

  const dir = path.dirname(testJsonPath);
  const quarantined = fs.readdirSync(dir).filter((name) => name.startsWith(path.basename(testJsonPath) + '.corrupt-'));
  assert.strictEqual(quarantined.length, 1, 'file korup harus dikarantina (di-rename), bukan ditimpa/dibuang');
  console.log(`OK: pulih dari .bak (${bakRowCount} baris), file korup dikarantina sebagai ${quarantined[0]}.`);

  console.log('\n--- 3. File utama DAN cadangan sama-sama korup -> mulai kosong, tidak crash ---');
  fs.writeFileSync(testJsonPath, 'korup utama');
  fs.writeFileSync(`${testJsonPath}.bak`, 'korup cadangan juga');
  const buf4 = new IncomingBufferJsonFile();
  assert.strictEqual(buf4.countPending(), 0, 'harus mulai dari kosong kalau utama dan cadangan sama-sama korup');
  console.log('OK: kedua file korup -> mulai kosong tanpa crash (perilaku lama tetap jadi fallback terakhir).');

  cleanup();
  console.log('\nSemua simulasi E-09 lolos.');
  process.exit(0);
})().catch((err) => {
  console.error('SIMULASI GAGAL:', err);
  cleanup();
  process.exit(1);
});
