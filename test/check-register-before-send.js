'use strict';
/**
 * Guard STATIS M1 Wave 1 TASK-011 (RISK-001, D-03): pemeriksa regex atas source
 * code (BUKAN runtime) yang memastikan setiap titik kirim mencatat ID pesan ke
 * ownSentRegistry SEBELUM `sock.sendMessage()`.
 *
 * Kenapa statis: bug yang dijaga (mencatat ID SETELAH `await sendMessage()`)
 * hanya muncul sebagai balapan dengan event `append` Baileys asli, yang tidak
 * bisa dipancing andal di tes runtime. Urutan teks di source adalah penanda
 * yang bisa diperiksa deterministik.
 *
 * Aturan (dipindai di semua berkas src/**\/*.js, komentar diabaikan):
 *   1. Setiap panggilan `.sendMessage(` MUST didahului, DI DALAM method/fungsi
 *      yang sama, oleh `_registerOwnSentId(` atau `ownSentRegistry.register(`.
 *   2. Panggilan `.sendMessage(` MUST meneruskan opsi `messageId`.
 *   3. Di dalam `_registerOwnSentId`, `ownSentRegistry.register(` MUST berupa
 *      statement langsung -- bukan dibungkus setImmediate/setTimeout/.then
 *      (itu sama dengan mencatat terlambat).
 *
 * Keterbatasan (sengaja sederhana): batas method dikenali dari pola method
 * kelas berindentasi 2 spasi; berkas tanpa pola itu diperiksa sebagai satu
 * blok. Guard ini melengkapi, bukan menggantikan, tes runtime AC-002.
 *
 * Jalankan: node test/check-register-before-send.js  (exit 1 kalau ada pelanggaran)
 */
const fs = require('fs');
const path = require('path');

/** Ganti komentar dengan spasi (panjang & nomor baris tetap) supaya tidak ikut dicocokkan. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

/** Pecah source menjadi blok method kelas (indentasi 2 spasi); tanpa pola -> satu blok. */
function splitIntoBlocks(code) {
  const header = /^ {2}(?:async\s+)?(?:static\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{\s*$/gm;
  const starts = [];
  let match;
  while ((match = header.exec(code)) !== null) starts.push(match.index);
  if (starts.length === 0) return [{ offset: 0, text: code }];
  return starts.map((start, i) => ({
    offset: start,
    text: code.slice(start, i + 1 < starts.length ? starts[i + 1] : code.length),
  }));
}

const lineOf = (code, index) => code.slice(0, index).split('\n').length;

/**
 * @param {string} source isi berkas
 * @param {string} label nama berkas untuk pesan
 * @returns {{violations: string[], sendPoints: number}}
 */
function checkSource(source, label = '<source>') {
  const code = stripComments(source);
  const violations = [];
  let sendPoints = 0;

  for (const block of splitIntoBlocks(code)) {
    const sendRe = /\.sendMessage\s*\(/g;
    let send;
    while ((send = sendRe.exec(block.text)) !== null) {
      sendPoints += 1;
      const absolute = block.offset + send.index;
      const where = `${label}:${lineOf(code, absolute)}`;
      const before = block.text.slice(0, send.index);

      // Aturan 1: ada register SEBELUM titik kirim, dalam blok yang sama.
      if (!/(?:_registerOwnSentId\s*\(|ownSentRegistry\s*\.\s*register\s*\()/.test(before)) {
        violations.push(`${where}: sendMessage() tanpa register() ID kiriman sendiri SEBELUMNYA di method yang sama (RISK-001)`);
      }

      // Aturan 2: opsi messageId diteruskan (ambil argumen sampai ')' penutup panggilan).
      let depth = 0;
      let end = send.index + send[0].length - 1;
      for (let i = end; i < block.text.length; i += 1) {
        if (block.text[i] === '(') depth += 1;
        if (block.text[i] === ')') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const args = block.text.slice(send.index, end + 1);
      if (!/\bmessageId\b/.test(args)) {
        violations.push(`${where}: sendMessage() tidak meneruskan opsi messageId (D-03)`);
      }
    }
  }

  // Aturan 3: register() di dalam _registerOwnSentId harus statement langsung.
  const helper = code.match(/_registerOwnSentId\s*\([^)]*\)\s*\{([\s\S]*?)\n {2}\}/);
  if (helper) {
    const body = helper[1];
    if (!/^\s*ownSentRegistry\s*\.\s*register\s*\(/m.test(body)) {
      violations.push(`${label}: _registerOwnSentId() tidak memanggil ownSentRegistry.register() sebagai statement langsung`);
    }
    if (/(setImmediate|setTimeout|process\.nextTick|\.then\s*\()/.test(body)) {
      violations.push(`${label}: _registerOwnSentId() menunda register() (setImmediate/setTimeout/nextTick/.then) -- mencatat terlambat`);
    }
  }

  return { violations, sendPoints };
}

function listJsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

/** Pindai seluruh src/. */
function checkRepo(srcDir = path.resolve(__dirname, '..', 'src')) {
  const violations = [];
  let sendPoints = 0;
  for (const file of listJsFiles(srcDir)) {
    const result = checkSource(fs.readFileSync(file, 'utf8'), path.relative(path.resolve(__dirname, '..'), file));
    violations.push(...result.violations);
    sendPoints += result.sendPoints;
  }
  return { violations, sendPoints };
}

module.exports = { checkSource, checkRepo };

if (require.main === module) {
  // Argumen opsional: folder lain yang dipindai (dipakai tes guard ini sendiri).
  const { violations, sendPoints } = checkRepo(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  if (sendPoints === 0) {
    console.error('GUARD GAGAL: tidak ada titik sendMessage() yang ditemukan di src/ -- pola pemindaian mungkin rusak.');
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error(`GUARD GAGAL: ${violations.length} pelanggaran urutan register() vs sendMessage():`);
    violations.forEach((v) => console.error(`  - ${v}`));
    process.exit(1);
  }
  console.log(`OK: ${sendPoints} titik sendMessage() di src/ semuanya didahului register() ID dan meneruskan messageId.`);
}
