'use strict';
/**
 * Skrip simulasi M1 Wave 1 TASK-015 (REQ-016, REQ-017, AC-012): pemulihan
 * buffer JSON fallback (dipakai saat better-sqlite3 tidak tersedia, mis.
 * build Android) dari cadangan `.bak`, dan penanganan berkas yang rusak.
 *
 * Berkas sementara ada di folder temp dan dihapus setelah tes.
 * Jalankan: node test/simulate-json-recovery.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// HARUS sebelum modul src/ mana pun di-require: modul buffer membuat singleton
// SQLite saat di-require; arahkan ke folder temp.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-json-recovery-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'singleton.sqlite');

const assert = require('assert');
const incomingBuffer = require('../src/store/incomingBuffer');
const { IncomingBufferJsonFile } = incomingBuffer;
const logger = require('../src/logging');

function cleanup() {
  try {
    incomingBuffer.close(); // lepas handle singleton sebelum hapus folder (Windows)
  } catch (err) {
    // abaikan
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`Peringatan: folder temp tidak terhapus (${err.code}): ${tmpDir}`);
  }
}

let scenario = 0;
/** Folder + jalur berkas terpisah untuk tiap skenario. */
function fixture() {
  scenario += 1;
  const dir = path.join(tmpDir, `s${scenario}`);
  fs.mkdirSync(dir);
  const sqlitePath = path.join(dir, 'buffer.sqlite');
  const json = path.join(dir, 'buffer.json');
  return { dir, sqlitePath, json, bak: `${json}.bak`, open: () => new IncomingBufferJsonFile(sqlitePath) };
}

const makeEvent = (id, text = id) => ({
  messageId: id,
  chatId: '628111000701@s.whatsapp.net',
  jidType: 'pn',
  messageType: 'text',
  text,
  timestamp: new Date().toISOString(),
});
const idsOf = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).rows.map((r) => r.wa_message_id);
const corruptFilesOf = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'));

/** Tangkap log selama fn() (sinkron) berjalan. */
function captureLogs(fn) {
  const captured = { info: [], warn: [], error: [] };
  const original = {};
  for (const level of Object.keys(captured)) {
    original[level] = logger[level];
    logger[level] = (message, meta) => captured[level].push({ message, meta });
  }
  try {
    fn();
  } finally {
    for (const level of Object.keys(captured)) logger[level] = original[level];
  }
  return captured;
}

try {
  console.log('--- 1. REQ-016: tiap penulisan menyimpan salinan penulisan SEBELUMNYA sebagai .bak ---');
  let f = fixture();
  let buf = f.open();
  buf.enqueue(makeEvent('A'));
  assert.ok(!fs.existsSync(f.bak), 'penulisan pertama: belum ada yang dicadangkan');
  buf.enqueue(makeEvent('B'));
  assert.deepStrictEqual(idsOf(f.json), ['A', 'B'], 'berkas utama = keadaan terbaru');
  assert.deepStrictEqual(idsOf(f.bak), ['A'], '.bak = penulisan sebelumnya');
  console.log('OK: utama {A,B}, .bak {A}.');

  console.log('\n--- 2. AC-012: utama korup + cadangan valid -> pulih dari .bak, peringatan (bukan error) ---');
  const truncated = '{"nextId": 3, "rows": [ {"id":1, "wa_mess';
  fs.writeFileSync(f.json, truncated);
  let logs = captureLogs(() => {
    buf = f.open();
  });
  assert.strictEqual(buf.countPending(), 1, 'pulih ke keadaan .bak: {A}');
  assert.strictEqual(logs.error.length, 0, 'pemulihan sukses hanya peringatan');
  const recoveredWarn = logs.warn.find((l) => /dipulihkan dari cadangan/.test(l.message));
  assert.ok(recoveredWarn, 'peringatan pemulihan tercatat');
  assert.strictEqual(recoveredWarn.meta.sizeBytes, truncated.length);
  assert.strictEqual(corruptFilesOf(f.dir).length, 1, 'berkas utama korup dikarantina, bukan ditimpa');
  assert.strictEqual(fs.readFileSync(path.join(f.dir, corruptFilesOf(f.dir)[0]), 'utf8'), truncated, 'isi asli utuh untuk diperiksa manual');
  buf.enqueue(makeEvent('C'));
  assert.deepStrictEqual(idsOf(f.json), ['A', 'C'], 'setelah pulih, antrean berfungsi normal');
  assert.strictEqual(JSON.parse(fs.readFileSync(f.json, 'utf8')).rows[1].id, 2, 'nextId dilanjutkan dari cadangan');
  console.log('OK: pulih {A}, karantina berisi isi asli, penulisan berikutnya normal.');

  console.log('\n--- 3. AC-012: utama DAN cadangan korup -> utama dipindah, antrean kosong, error keras berisi UKURAN berkas ---');
  f = fixture();
  buf = f.open();
  buf.enqueue(makeEvent('A'));
  buf.enqueue(makeEvent('B'));
  const garbageMain = 'x'.repeat(1234);
  fs.writeFileSync(f.json, garbageMain);
  fs.writeFileSync(f.bak, 'bukan json juga');
  logs = captureLogs(() => {
    buf = f.open();
  });
  assert.strictEqual(buf.countPending(), 0, 'antrean mulai dari kosong');
  assert.strictEqual(logs.error.length, 1, 'tepat satu error keras');
  assert.strictEqual(logs.error[0].meta.severity, 'critical');
  assert.strictEqual(logs.error[0].meta.sizeBytes, 1234, 'error memuat ukuran berkas asli (REQ-017)');
  assert.ok(logs.error[0].meta.quarantinePath.includes('.corrupt-'));
  const quarantined = corruptFilesOf(f.dir);
  assert.strictEqual(quarantined.length, 1);
  assert.strictEqual(fs.statSync(path.join(f.dir, quarantined[0])).size, 1234, 'berkas dipindah utuh, bukan dihapus');
  buf.enqueue(makeEvent('D'));
  assert.deepStrictEqual(idsOf(f.json), ['D'], 'berkas baru valid dan berfungsi');
  console.log('OK: dikarantina 1234 byte, error keras memuat ukuran, antrean baru berfungsi.');

  console.log('\n--- 4. Utama HILANG tapi cadangan valid -> pulih dari .bak (REQ-017 "tidak terbaca") ---');
  f = fixture();
  buf = f.open();
  buf.enqueue(makeEvent('A'));
  buf.enqueue(makeEvent('B'));
  fs.unlinkSync(f.json);
  logs = captureLogs(() => {
    buf = f.open();
  });
  assert.strictEqual(buf.countPending(), 1, 'pulih dari .bak {A}');
  assert.ok(logs.warn.some((l) => /hilang, dipulihkan/.test(l.message)));
  assert.strictEqual(logs.error.length, 0);
  assert.strictEqual(corruptFilesOf(f.dir).length, 0, 'tidak ada yang dikarantina (berkas utama memang tidak ada)');
  console.log('OK: berkas utama hilang dipulihkan dari cadangan.');

  console.log('\n--- 5. Belum ada berkas sama sekali -> mulai kosong tanpa peringatan/error ---');
  f = fixture();
  logs = captureLogs(() => {
    buf = f.open();
  });
  assert.strictEqual(buf.countPending(), 0);
  assert.strictEqual(logs.warn.length + logs.error.length, 0, 'awal bersih bukan kegagalan');
  console.log('OK: start pertama senyap.');

  console.log('\n--- 6. JSON valid tapi BENTUK salah ({} / [] / null) dianggap rusak, bukan antrean kosong yang sehat ---');
  for (const shape of ['{}', '[]', 'null', '{"nextId":5}', '"teks"']) {
    f = fixture();
    buf = f.open();
    buf.enqueue(makeEvent('A'));
    buf.enqueue(makeEvent('B'));
    fs.writeFileSync(f.json, shape);
    logs = captureLogs(() => {
      buf = f.open();
    });
    assert.strictEqual(buf.countPending(), 1, `${shape}: harus pulih dari .bak, bukan kosong diam-diam`);
    assert.ok(logs.warn.some((l) => /dipulihkan dari cadangan/.test(l.message)), `${shape}: peringatan pemulihan`);
    assert.strictEqual(corruptFilesOf(f.dir).length, 1, `${shape}: dikarantina`);
  }
  console.log('OK: lima bentuk salah ditangani sebagai berkas rusak.');

  console.log('\n--- 7. Cadangan TIDAK diracuni: utama rusak saat berjalan -> .bak yang baik tidak ditimpa ---');
  f = fixture();
  buf = f.open();
  buf.enqueue(makeEvent('A'));
  buf.enqueue(makeEvent('B')); // .bak = {A}
  const bakBefore = fs.readFileSync(f.bak, 'utf8');
  fs.writeFileSync(f.json, 'RUSAK DI TENGAH OPERASI'); // rusak saat instance masih hidup
  logs = captureLogs(() => buf.enqueue(makeEvent('C')));
  assert.strictEqual(fs.readFileSync(f.bak, 'utf8'), bakBefore, '.bak lama utuh, tidak tertimpa berkas rusak');
  assert.ok(logs.warn.some((l) => /TIDAK ditimpa/.test(l.message)), 'peringatan tercatat');
  assert.deepStrictEqual(idsOf(f.json), ['A', 'B', 'C'], 'berkas utama ditulis ulang valid dari memori');
  console.log('OK: .bak tetap {A}, utama pulih {A,B,C}.');

  console.log('\n--- 8. Gagal menyalin cadangan tidak menghalangi penulisan utama (non-fatal) ---');
  f = fixture();
  buf = f.open();
  buf.enqueue(makeEvent('A'));
  fs.mkdirSync(f.bak); // .bak berupa folder -> copyFileSync pasti gagal
  logs = captureLogs(() => buf.enqueue(makeEvent('B')));
  assert.ok(logs.warn.some((l) => /Gagal menyalin cadangan/.test(l.message)), 'peringatan gagal-salin tercatat');
  assert.deepStrictEqual(idsOf(f.json), ['A', 'B'], 'penulisan utama tetap berhasil');
  console.log('OK: kegagalan cadangan non-fatal.');

  // Refactor TASK-205/206 (PRN-002, CR-03): dipindah dari simulate-e09-json-recovery.js #1
  // (skrip lama itu menulis ke data/ repo, bukan folder sementara).
  console.log('\n--- 9. Round trip normal: instance baru membaca berkas utama yang SEHAT apa adanya ---');
  f = fixture();
  buf = f.open();
  buf.enqueue(makeEvent('A'));
  buf.enqueue(makeEvent('B'));
  logs = captureLogs(() => {
    buf = f.open();
  });
  assert.strictEqual(buf.countPending(), 2, 'instance baru membaca {A,B} dari berkas utama, bukan dari .bak {A}');
  assert.strictEqual(logs.warn.length + logs.error.length, 0, 'berkas sehat dibuka senyap');
  assert.strictEqual(corruptFilesOf(f.dir).length, 0, 'berkas sehat tidak dikarantina');
  buf.enqueue(makeEvent('C'));
  assert.deepStrictEqual(idsOf(f.json), ['A', 'B', 'C'], 'penulisan berikutnya melanjutkan antrean yang dibaca');
  console.log('OK: berkas sehat dibaca ulang {A,B} tanpa peringatan, lalu berlanjut {A,B,C}.');

  console.log('\nSemua assert simulate-json-recovery lolos.');
  cleanup();
} catch (err) {
  console.error('SIMULASI GAGAL:', err);
  cleanup();
  process.exit(1);
}
