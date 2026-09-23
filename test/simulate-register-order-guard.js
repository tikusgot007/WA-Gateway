'use strict';
/**
 * Skrip simulasi M1 Wave 1 TASK-011 (RISK-001): membuktikan guard statis
 * test/check-register-before-send.js BENAR-BENAR gagal untuk urutan yang salah
 * -- guard yang tidak pernah terbukti bisa gagal sama dengan tidak ada guard.
 * Juga memastikan source asli lolos dan exit code CLI benar.
 *
 * Berkas sementara ada di folder temp dan dihapus setelah tes.
 * Jalankan: node test/simulate-register-order-guard.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkSource, checkRepo } = require('./check-register-before-send');

const GOOD = `
class Manager {
  async sendTextMessage(jid, text) {
    try {
      const ownMessageId = this._registerOwnSentId();
      const result = await this.sock.sendMessage(jid, { text }, { messageId: ownMessageId });
      return result;
    } catch (err) {
      throw err;
    }
  }

  _registerOwnSentId() {
    const messageId = generate();
    ownSentRegistry.register(messageId);
    return messageId;
  }
}
`;

const cases = [
  {
    name: 'sumber benar -> tidak ada pelanggaran',
    source: GOOD,
    expectViolations: 0,
  },
  {
    name: 'register SETELAH await sendMessage (bug RISK-001)',
    source: GOOD.replace(
      /const ownMessageId = this\._registerOwnSentId\(\);\n(\s*)const result = await (this\.sock\.sendMessage\([^\n]*\));/,
      'const result = await $2;\n$1const ownMessageId = this._registerOwnSentId();'
    ),
    expectViolations: 1,
    expectText: /tanpa register\(\)/,
  },
  {
    name: 'sendMessage tanpa register sama sekali',
    source: GOOD.replace('const ownMessageId = this._registerOwnSentId();', 'const ownMessageId = null;'),
    expectViolations: 1,
    expectText: /tanpa register\(\)/,
  },
  {
    name: 'register hanya ada di method LAIN (bukan method titik kirim)',
    source: GOOD.replace('const ownMessageId = this._registerOwnSentId();', 'const ownMessageId = "x";'),
    expectViolations: 1,
    expectText: /tanpa register\(\)/,
  },
  {
    name: 'register hanya muncul di KOMENTAR sebelum sendMessage',
    source: GOOD.replace(
      'const ownMessageId = this._registerOwnSentId();',
      '// const ownMessageId = this._registerOwnSentId();\n      /* ownSentRegistry.register(x) */\n      const ownMessageId = "x";'
    ),
    expectViolations: 1,
    expectText: /tanpa register\(\)/,
  },
  {
    name: 'sendMessage tanpa opsi messageId',
    source: GOOD.replace('{ text }, { messageId: ownMessageId }', '{ text }'),
    expectViolations: 1,
    expectText: /opsi messageId/,
  },
  {
    name: 'register() ditunda dengan setImmediate di dalam helper',
    source: GOOD.replace('ownSentRegistry.register(messageId);', 'setImmediate(() => ownSentRegistry.register(messageId));'),
    expectViolations: 2, // bukan statement langsung + menunda
    expectText: /menunda register\(\)/,
  },
  {
    name: 'dua titik kirim, satu tanpa register -> hanya yang salah dilaporkan',
    source: GOOD.replace(
      '  _registerOwnSentId() {',
      '  async sendMedia(jid, content) {\n    return this.sock.sendMessage(jid, content, { messageId: "x" });\n  }\n\n  _registerOwnSentId() {'
    ),
    expectViolations: 1,
    expectText: /tanpa register\(\)/,
  },
];

let counted = 0;
for (const c of cases) {
  console.log(`--- ${c.name} ---`);
  if (c.expectViolations > 0) {
    assert.notStrictEqual(c.source, GOOD, 'mutasi fixture harus benar-benar mengubah sumber');
  }
  const { violations, sendPoints } = checkSource(c.source, 'fixture.js');
  assert.ok(sendPoints >= 1, 'titik kirim harus terdeteksi');
  assert.strictEqual(violations.length, c.expectViolations, `pelanggaran: ${JSON.stringify(violations)}`);
  if (c.expectText) assert.ok(violations.some((v) => c.expectText.test(v)), `pesan harus cocok ${c.expectText}`);
  counted += 1;
  console.log(`OK: ${c.expectViolations} pelanggaran seperti diharapkan.`);
}

console.log('\n--- source asli src/ lolos dan punya titik kirim yang dipindai ---');
const real = checkRepo();
assert.deepStrictEqual(real.violations, [], `src/ asli tidak boleh punya pelanggaran: ${JSON.stringify(real.violations)}`);
assert.ok(real.sendPoints >= 2, 'minimal dua titik kirim (teks dan media) terdeteksi');
console.log(`OK: ${real.sendPoints} titik kirim asli lolos.`);

console.log('\n--- CLI: exit 0 untuk src/ asli, exit 1 untuk folder berisi urutan terbalik ---');
const guardPath = path.resolve(__dirname, 'check-register-before-send.js');
assert.strictEqual(spawnSync(process.execPath, [guardPath], { encoding: 'utf8' }).status, 0);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-guard-'));
try {
  fs.writeFileSync(path.join(tmpDir, 'bad.js'), cases[1].source);
  const bad = spawnSync(process.execPath, [guardPath, tmpDir], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1, 'urutan terbalik MUST membuat CLI exit non-zero');
  assert.match(bad.stderr, /GUARD GAGAL/);

  const emptyDir = path.join(tmpDir, 'empty');
  fs.mkdirSync(emptyDir);
  fs.writeFileSync(path.join(emptyDir, 'noop.js'), 'module.exports = 1;\n');
  const empty = spawnSync(process.execPath, [guardPath, emptyDir], { encoding: 'utf8' });
  assert.strictEqual(empty.status, 1, 'tidak ada titik kirim terdeteksi -> guard curiga polanya rusak, exit non-zero');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
console.log('OK: exit code CLI sesuai (0 / 1 / 1).');

console.log(`\nSemua assert simulate-register-order-guard lolos (${counted} kasus fixture).`);
