'use strict';
/**
 * Guard STATIS M1 Wave 2 TASK-005 (TEST-005, REQ-021, ASSUMPTION-009): pemeriksa
 * regex atas source (BUKAN runtime) yang memastikan baris operasi `in_flight`
 * ditulis (`begin()`) SEBELUM Baileys dipanggil, pada KEDUA endpoint kirim.
 * Pola sama dengan test/check-register-before-send.js (gelombang 1).
 *
 * Kenapa statis: bug yang dijaga (mencatat SETELAH kirim, atau mengirim lewat
 * jalan pintas yang melewati service) hanya muncul sebagai duplikat langka saat
 * crash -- tidak bisa dipancing andal di tes runtime. Urutan di source adalah
 * penanda yang bisa diperiksa deterministik.
 *
 * Aturan (komentar diabaikan):
 *   S1. src/delivery/outgoingOperationService.js: di dalam runOperation(),
 *       `outgoingOperations.begin(` MUST mendahului `await send(`.
 *   R1. src/api/ci4Routes.js, handler POST /send dan POST /send-media: masing-
 *       masing MUST memanggil `runOperation(` dan meneruskan `send: doSend`.
 *   R2. Di tiap handler itu, pemanggilan `connectionManager.sendReply(` /
 *       `.sendMediaReply(` MUST tepat SATU dan berada di dalam closure
 *       `const doSend = ...` (bukan panggilan langsung yang melewati service).
 *   R3. `validateOperationId(` MUST muncul sebelum `runOperation(` di handler.
 *   R4. Di jalur lama tanpa operation_id, `await doSend()` MUST didahului
 *       `warnWithoutOperationIdOnce(` (jalur itu sengaja tanpa idempotensi dan
 *       harus terlihat di log, REQ-026).
 *
 * Keterbatasan (sengaja sederhana): berbasis teks. Melengkapi, bukan menggantikan,
 * tes runtime AC-020 (test/simulate-outgoing-idempotency.js).
 *
 * Jalankan: node test/check-outgoing-begin-before-send.js  (exit 1 bila ada pelanggaran)
 */
const fs = require('fs');
const path = require('path');

/** Ganti komentar dengan spasi (panjang & nomor baris tetap) supaya tidak ikut dicocokkan. */
function stripComments(source) {
  // Berkas di Windows bisa CRLF (git autocrlf); semua pola di bawah memakai \n.
  return source
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

/** Badan `async function runOperation(...) { ... }` sampai `}` penutup di kolom 0. */
function extractRunOperation(code) {
  const start = code.search(/async\s+function\s+runOperation\s*\(/);
  if (start === -1) return null;
  const end = code.indexOf('\n}\n', start);
  return code.slice(start, end === -1 ? code.length : end);
}

/** @returns {string[]} pelanggaran aturan S1 */
function checkService(source, label = 'outgoingOperationService.js') {
  const body = extractRunOperation(stripComments(source));
  if (body === null) return [`${label}: fungsi runOperation() tidak ditemukan -- pola pemindaian mungkin rusak`];

  const begin = body.search(/outgoingOperations\s*\.\s*begin\s*\(/);
  const send = body.search(/await\s+send\s*\(/);
  const violations = [];
  if (begin === -1) violations.push(`${label}: runOperation() tidak memanggil outgoingOperations.begin()`);
  if (send === -1) violations.push(`${label}: runOperation() tidak memanggil await send() -- pola pemindaian mungkin rusak`);
  if (begin !== -1 && send !== -1 && begin > send) {
    violations.push(`${label}: outgoingOperations.begin() muncul SETELAH await send() -- baris in_flight harus ditulis SEBELUM kirim (S1, REQ-021)`);
  }
  return violations;
}

/** Pecah source router menjadi blok per `router.post(` (route handler). */
function extractHandlers(code) {
  const starts = [];
  const re = /router\.post\(\s*'([^']+)'/g;
  let match;
  while ((match = re.exec(code)) !== null) starts.push({ route: match[1], index: match.index });
  return starts.map((s, i) => ({
    route: s.route,
    text: code.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : code.length),
  }));
}

/** @returns {{violations: string[], handlersChecked: number}} pelanggaran aturan R1-R4 */
function checkRoutes(source, label = 'ci4Routes.js') {
  const violations = [];
  const handlers = extractHandlers(stripComments(source));
  const targets = ['/send', '/send-media'];
  let handlersChecked = 0;

  for (const route of targets) {
    const handler = handlers.find((h) => h.route === route);
    if (!handler) {
      violations.push(`${label}: handler POST ${route} tidak ditemukan -- pola pemindaian mungkin rusak`);
      continue;
    }
    handlersChecked += 1;
    const where = `${label} POST ${route}`;
    const { text } = handler;

    // R1
    const runIdx = text.search(/outgoingOperationService\s*\.\s*runOperation\s*\(/);
    if (runIdx === -1) violations.push(`${where}: tidak memanggil runOperation() -- kirim tanpa idempotensi (R1)`);
    if (!/send\s*:\s*doSend\b/.test(text)) violations.push(`${where}: runOperation() tidak menerima send: doSend (R1)`);

    // R2: tepat satu panggilan langsung, dan di dalam closure doSend.
    const sendCall = route === '/send' ? /connectionManager\s*\.\s*sendReply\s*\(/g : /connectionManager\s*\.\s*sendMediaReply\s*\(/g;
    const calls = [...text.matchAll(sendCall)].map((m) => m.index);
    const doSendIdx = text.search(/const\s+doSend\s*=/);
    if (doSendIdx === -1) {
      violations.push(`${where}: closure "const doSend =" tidak ditemukan (R2)`);
    } else if (calls.length !== 1) {
      violations.push(`${where}: ditemukan ${calls.length} pemanggilan langsung ke Baileys wrapper, seharusnya tepat 1 di dalam doSend (R2)`);
    } else if (calls[0] < doSendIdx) {
      violations.push(`${where}: pemanggilan Baileys wrapper berada SEBELUM/di luar closure doSend (R2)`);
    }

    // R3
    const validateIdx = text.search(/validateOperationId\s*\(/);
    if (validateIdx === -1 || (runIdx !== -1 && validateIdx > runIdx)) {
      violations.push(`${where}: validateOperationId() harus dipanggil SEBELUM runOperation() (R3)`);
    }

    // R4
    const warnIdx = text.search(/warnWithoutOperationIdOnce\s*\(/);
    const legacyIdx = text.search(/await\s+doSend\s*\(/);
    if (legacyIdx === -1) {
      violations.push(`${where}: jalur lama "await doSend()" tidak ditemukan -- pola pemindaian mungkin rusak (R4)`);
    } else if (warnIdx === -1 || warnIdx > legacyIdx) {
      violations.push(`${where}: jalur tanpa operation_id tidak memanggil warnWithoutOperationIdOnce() sebelum await doSend() (R4)`);
    }
  }

  return { violations, handlersChecked };
}

function checkRepo(root = path.resolve(__dirname, '..')) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const serviceViolations = checkService(read('src/delivery/outgoingOperationService.js'), 'src/delivery/outgoingOperationService.js');
  const routes = checkRoutes(read('src/api/ci4Routes.js'), 'src/api/ci4Routes.js');
  return {
    violations: [...serviceViolations, ...routes.violations],
    handlersChecked: routes.handlersChecked,
  };
}

module.exports = { checkService, checkRoutes, checkRepo };

if (require.main === module) {
  // Argumen opsional: root repo lain yang dipindai (dipakai tes guard ini sendiri).
  const { violations, handlersChecked } = checkRepo(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  if (handlersChecked < 2) {
    console.error(`GUARD GAGAL: hanya ${handlersChecked} dari 2 handler kirim yang terperiksa -- pola pemindaian mungkin rusak.`);
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error(`GUARD GAGAL: ${violations.length} pelanggaran urutan begin() vs kirim:`);
    violations.forEach((v) => console.error(`  - ${v}`));
    process.exit(1);
  }
  console.log(`OK: begin() mendahului kirim di runOperation(); ${handlersChecked} endpoint (/send, /send-media) hanya memanggil Baileys lewat doSend di dalam service.`);
}
