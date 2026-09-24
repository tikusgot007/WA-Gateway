'use strict';
/**
 * Pemeriksa isolasi database uji M1 Wave 2 TASK-005 (d), TEST-010, pelajaran CR
 * gelombang 1: skrip uji MUST hanya memakai SQLite di folder temp dan MUST NOT
 * menulis ke data/gateway.sqlite (database yang dipakai Gateway sungguhan).
 *
 * Dua pemeriksaan:
 *   1. STATIS, per skrip test/*.js: skrip yang memuat modul yang MEMBUKA database
 *      saat di-require (connectionManager -> incomingBuffer, outgoingOperations,
 *      ci4Routes, dst.) MUST menyetel `process.env.SQLITE_PATH` ke folder temp
 *      SEBELUM require pertama ke ../src/, dan tidak boleh menyebut
 *      "data/gateway.sqlite" secara harfiah. Tanpa itu, config.sqlitePath jatuh ke
 *      ./data/gateway.sqlite relatif terhadap folder tempat skrip dijalankan.
 *   2. RUNTIME: setelah skrip dijalankan, berkas <repo>/data/gateway.sqlite MUST
 *      tidak ada (opsi --expect-no-data-dir).
 *
 * Skrip Fase 1 M1 Wave 2 (`*outgoing*`) yang gagal = exit 1. Skrip gelombang 1 yang
 * gagal hanya dilaporkan sebagai TEMUAN (bukan bagian scope fase ini; tidak diubah).
 *
 * Jalankan: node test/check-test-sqlite-isolation.js [--expect-no-data-dir]
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

// Modul src/ yang membuka database SQLite (langsung atau lewat require berantai) saat dimuat.
const DB_OPENING_MODULES = [
  'whatsapp/connectionManager', // -> store/incomingBuffer
  'store/incomingBuffer',
  'store/outgoingOperations',
  'delivery/incomingDelivery', // -> store/incomingBuffer
  'delivery/outgoingOperationService', // -> store/outgoingOperations
  'api/ci4Routes',
  'api/routes',
  'api/server',
  'app/index',
];

function stripComments(source) {
  return source
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
}

/** @returns {{status: 'ok'|'tidak-relevan'|'bermasalah', reason?: string}} */
function classify(source) {
  const code = stripComments(source);
  if (/data[\\/]+gateway\.sqlite/.test(code)) {
    return { status: 'bermasalah', reason: 'menyebut data/gateway.sqlite secara harfiah' };
  }

  const dbRequire = [...code.matchAll(/require\(\s*'\.\.\/src\/([^']+)'\s*\)/g)]
    .filter((m) => DB_OPENING_MODULES.includes(m[1]))
    .map((m) => m.index)[0];
  if (dbRequire === undefined) return { status: 'tidak-relevan' };

  const setter = code.match(/process\.env\.SQLITE_PATH\s*=\s*path\.join\(\s*(tmp\w*)\b/);
  if (!setter) return { status: 'bermasalah', reason: 'memuat modul pembuka DB tanpa process.env.SQLITE_PATH ke folder temp' };
  if (setter.index > dbRequire) return { status: 'bermasalah', reason: 'SQLITE_PATH disetel SETELAH modul pembuka DB di-require' };
  return { status: 'ok' };
}

function checkAll() {
  const dir = path.join(root, 'test');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js') && f !== path.basename(__filename))
    .sort()
    .map((file) => ({ file, ...classify(fs.readFileSync(path.join(dir, file), 'utf8')) }));
}

module.exports = { classify, checkAll };

if (require.main === module) {
  const results = checkAll();
  const isFase1 = (r) => /outgoing/.test(r.file);
  let failed = false;

  for (const r of results) {
    const label = r.status === 'ok' ? 'OK          ' : r.status === 'tidak-relevan' ? 'tidak-relevan' : 'BERMASALAH   ';
    console.log(`${label} ${r.file}${r.reason ? `  <- ${r.reason}` : ''}`);
  }

  const badFase1 = results.filter((r) => isFase1(r) && r.status === 'bermasalah');
  const badLegacy = results.filter((r) => !isFase1(r) && r.status === 'bermasalah');
  if (badFase1.length > 0) {
    console.error(`\nGAGAL: ${badFase1.length} skrip Fase 1 M1 Wave 2 tidak terisolasi dari data/gateway.sqlite.`);
    failed = true;
  }
  if (badLegacy.length > 0) {
    console.log(`\nTEMUAN (di luar scope Fase 1, TIDAK diubah): ${badLegacy.length} skrip gelombang 1 memuat modul pembuka DB tanpa SQLITE_PATH temp:`);
    badLegacy.forEach((r) => console.log(`  - test/${r.file}`));
    console.log('  Bila dijalankan dari folder Gateway LIVE, skrip ini akan membuka/menulis data/gateway.sqlite produksi.');
  }

  const dataFile = path.join(root, 'data', 'gateway.sqlite');
  if (process.argv.includes('--expect-no-data-dir')) {
    if (fs.existsSync(dataFile)) {
      console.error(`\nGAGAL: ${dataFile} terbentuk -- ada skrip yang menulis ke database default.`);
      failed = true;
    } else {
      console.log(`\nOK runtime: ${dataFile} tidak ada.`);
    }
  }

  if (failed) process.exit(1);
  console.log(`\nOK: ${results.filter(isFase1).length} skrip Fase 1 terisolasi (SQLite temp saja).`);
}
