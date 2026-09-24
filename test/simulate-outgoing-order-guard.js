'use strict';
/**
 * Skrip simulasi M1 Wave 2 TASK-005: membuktikan guard statis
 * test/check-outgoing-begin-before-send.js BENAR-BENAR gagal untuk urutan/pola
 * yang salah -- guard yang tidak pernah terbukti bisa gagal sama dengan tidak ada
 * guard (pola test/simulate-register-order-guard.js gelombang 1). Mutasi
 * disuntikkan ke SALINAN source di folder temp; source asli tidak diubah.
 *
 * Jalankan: node test/simulate-outgoing-order-guard.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkService, checkRoutes, checkRepo } = require('./check-outgoing-begin-before-send');

const repoRoot = path.resolve(__dirname, '..');
const SERVICE_REL = 'src/delivery/outgoingOperationService.js';
const ROUTES_REL = 'src/api/ci4Routes.js';
// CRLF dinormalkan ke LF supaya teks mutasi multi-baris di bawah cocok di Windows.
const readNormalized = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
const realService = readNormalized(SERVICE_REL);
const realRoutes = readNormalized(ROUTES_REL);

/** Ganti kemunculan PERTAMA `from`; gagal keras bila tidak ada (mutasi tidak boleh diam-diam tidak berlaku). */
function mutate(source, from, to) {
  assert.ok(source.includes(from), `mutasi tidak berlaku, teks tidak ditemukan: ${from}`);
  return source.replace(from, to);
}

/** Seperti mutate(), tetapi hanya pada bagian source SETELAH `marker` (mis. handler kedua). */
function mutateFrom(source, marker, from, to) {
  const at = source.indexOf(marker);
  assert.ok(at !== -1, `marker tidak ditemukan: ${marker}`);
  return source.slice(0, at) + mutate(source.slice(at), from, to);
}

console.log('--- 1. Source asli lolos ---');
const real = checkRepo(repoRoot);
assert.deepStrictEqual(real.violations, []);
assert.strictEqual(real.handlersChecked, 2);
console.log('OK: 0 pelanggaran, 2 handler terperiksa.');

console.log('\n--- 2. S1: begin() SETELAH send() di runOperation -> pelanggaran ---');
const BAD_SERVICE = `
async function runOperation() {
  const result = await send();
  outgoingOperations.begin({});
  return result;
}
`;
const GOOD_SERVICE = `
async function runOperation() {
  outgoingOperations.begin({});
  const result = await send();
  return result;
}
`;
assert.deepStrictEqual(checkService(GOOD_SERVICE), []);
let v = checkService(BAD_SERVICE);
assert.strictEqual(v.length, 1);
assert.ok(/SETELAH await send\(\)/.test(v[0]));
// begin() hanya ada di komentar -> dianggap tidak ada
v = checkService(`
async function runOperation() {
  // outgoingOperations.begin({});
  const result = await send();
  return result;
}
`);
assert.ok(v.some((m) => /tidak memanggil outgoingOperations\.begin/.test(m)), 'komentar tidak boleh dihitung');
// begin() dipindah di source asli
v = checkService(mutate(
  realService,
  'const begun = outgoingOperations.begin({ operationId, payloadHash, kind, chatId });',
  'const begun = { created: true };'
));
assert.ok(v.some((m) => /tidak memanggil outgoingOperations\.begin/.test(m)));
v = checkService('const x = 1;');
assert.ok(v.some((m) => /runOperation\(\) tidak ditemukan/.test(m)), 'pola rusak harus gagal keras, bukan lolos diam-diam');
console.log('OK: 4 pola pelanggaran S1 terdeteksi.');

console.log('\n--- 3. R1-R4 pada ci4Routes.js ---');
const routeMutations = [
  ['R1: /send tidak lagi meneruskan send: doSend', mutate(realRoutes, 'send: doSend,', 'send: () => null,'), /R1/],
  ['R1: /send-media tidak memanggil runOperation', mutateFrom(realRoutes, "router.post('/send-media'", 'outgoingOperationService.runOperation(', 'outgoingOperationService.runOperationX('), /R1.*send-media|send-media.*R1/],
  ['R2: panggilan langsung sendReply di jalur lama /send', mutate(realRoutes, 'const result = await doSend();', 'const result = await connectionManager.sendReply(chatId, text);'), /R2/],
  ['R2: panggilan langsung sendMediaReply di luar doSend', mutate(realRoutes, 'const decision = await outgoingOperationService.runOperation({\n      operationId,\n      payloadHash: outgoingOperationService.computePayloadHash({ kind: \'media\'', 'await connectionManager.sendMediaReply(chatId, mediaType, decoded.buffer, {});\n    const decision = await outgoingOperationService.runOperation({\n      operationId,\n      payloadHash: outgoingOperationService.computePayloadHash({ kind: \'media\''), /R2/],
  ['R3: validateOperationId dihapus', mutate(realRoutes, 'outgoingOperationService.validateOperationId(', 'outgoingOperationService.validateOperationIdX('), /R3/],
  ['R4: warnWithoutOperationIdOnce dihapus dari jalur lama', mutate(realRoutes, 'outgoingOperationService.warnWithoutOperationIdOnce();', ''), /R4/],
  ['handler /send-media hilang (pola rusak)', mutate(realRoutes, "'/send-media'", "'/kirim-media'"), /tidak ditemukan/],
];
for (const [name, source, pattern] of routeMutations) {
  const result = checkRoutes(source);
  assert.ok(result.violations.length > 0, `mutasi harus terdeteksi: ${name}`);
  if (pattern) assert.ok(result.violations.some((m) => pattern.test(m)), `${name} -> ${result.violations.join(' | ')}`);
  console.log(`OK: terdeteksi -- ${name}`);
}

console.log('\n--- 4. CLI: exit 0 untuk source asli, exit 1 untuk salinan yang dimutasi ---');
const guardCli = path.join(__dirname, 'check-outgoing-begin-before-send.js');
const okRun = spawnSync(process.execPath, [guardCli], { encoding: 'utf8' });
assert.strictEqual(okRun.status, 0, okRun.stderr);
assert.ok(/^OK:/.test(okRun.stdout));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-order-guard-'));
try {
  fs.mkdirSync(path.join(tmpRoot, 'src', 'delivery'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'src', 'api'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, SERVICE_REL), BAD_SERVICE);
  fs.writeFileSync(path.join(tmpRoot, ROUTES_REL), realRoutes);
  const badRun = spawnSync(process.execPath, [guardCli, tmpRoot], { encoding: 'utf8' });
  assert.strictEqual(badRun.status, 1);
  assert.ok(/GUARD GAGAL/.test(badRun.stderr));

  // folder tanpa berkas yang dicari -> bukan lolos diam-diam
  fs.writeFileSync(path.join(tmpRoot, SERVICE_REL), GOOD_SERVICE);
  fs.writeFileSync(path.join(tmpRoot, ROUTES_REL), 'const router = null;');
  const emptyRun = spawnSync(process.execPath, [guardCli, tmpRoot], { encoding: 'utf8' });
  assert.strictEqual(emptyRun.status, 1, 'router tanpa handler harus gagal');
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
console.log('OK');

console.log('\nSEMUA ASSERT LULUS (0 gagal).');
