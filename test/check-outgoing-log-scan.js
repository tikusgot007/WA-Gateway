'use strict';
/**
 * Pemindaian BERKAS LOG M1 Wave 2 TASK-005 (AC-039, SEC-001): menjalankan
 * test/simulate-outgoing-idempotency.js sebagai proses anak dengan log diteruskan
 * ke pino -> berkas (LOG_FOLDER di folder temp), memakai isi pesan dan
 * `media_base64` RAHASIA yang dibuat acak di sini, lalu memastikan berkas log
 * `gateway.log` tidak memuat satu pun dari rahasia itu -- baik pada jalur sukses,
 * gagal, replay, OPERATION_ID_REUSED, maupun tanpa operation_id (/send DAN /send-media).
 *
 * Pemindai ini juga membuktikan dirinya bekerja: berkas log HARUS tidak kosong dan
 * memuat baris log operasi (`[SEND-OPERATION]`, operation_id) termasuk baris level
 * error dari kegagalan kirim -- log kosong akan lolos "tanpa rahasia" secara palsu.
 * Pola pendeteksian rahasia diuji dengan kontrol positif (kebocoran yang disuntikkan).
 *
 * Jalankan: node test/check-outgoing-log-scan.js
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const nonce = crypto.randomBytes(6).toString('hex');
const secretText = `SCAN-TEKS-RAHASIA-${nonce}`;
const mediaMarker = `SCAN-MEDIA-RAHASIA-${nonce}-`;
const mediaBase64 = Buffer.from(mediaMarker.repeat(4)).toString('base64');

/** Daftar alasan kebocoran yang ditemukan di `log` (kosong = bersih). */
function findLeaks(log) {
  const leaks = [];
  if (log.includes(secretText)) leaks.push('isi pesan/caption');
  if (log.includes(mediaMarker)) leaks.push('isi media hasil decode');
  if (log.includes(mediaBase64)) leaks.push('string media_base64 penuh');
  if (log.includes(mediaBase64.slice(0, 20))) leaks.push('potongan media_base64');
  if (/"media_base64"/.test(log)) leaks.push('field media_base64');
  return leaks;
}

// Kontrol positif: pemindai harus mendeteksi kebocoran yang disuntikkan.
assert.deepStrictEqual(findLeaks('{"msg":"aman"}'), []);
assert.ok(findLeaks(`{"msg":"${secretText}"}`).includes('isi pesan/caption'));
assert.ok(findLeaks(`{"x":"${mediaBase64}"}`).includes('string media_base64 penuh'));
assert.ok(findLeaks('{"media_base64":"abc"}').includes('field media_base64'));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-outgoing-logscan-'));
try {
  const logDir = path.join(tmpRoot, 'logs');
  const child = spawnSync(process.execPath, [path.join(__dirname, 'simulate-outgoing-idempotency.js')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LOG_FOLDER: logDir,
      LOG_LEVEL: 'debug',
      OUTGOING_TEST_LOG_PASSTHROUGH: '1',
      OUTGOING_TEST_SECRET_TEXT: secretText,
      OUTGOING_TEST_SECRET_MEDIA: mediaMarker,
    },
  });
  assert.strictEqual(child.status, 0, `skrip idempotensi gagal:\n${child.stdout}\n${child.stderr}`);
  assert.ok(/SEMUA ASSERT LULUS/.test(child.stdout));

  const logFile = path.join(logDir, 'gateway.log');
  assert.ok(fs.existsSync(logFile), 'berkas log harus terbentuk (LOG_FOLDER)');
  const log = fs.readFileSync(logFile, 'utf8');
  const lines = log.split('\n').filter(Boolean);

  // Log harus nyata dan mencakup jalur yang diperiksa, bukan kosong.
  assert.ok(lines.length >= 30, `log terlalu sedikit (${lines.length} baris) -- pemindaian tidak berarti`);
  lines.forEach((line) => JSON.parse(line)); // setiap baris JSON pino utuh
  assert.ok(log.includes('[SEND-OPERATION]'), 'log operasi harus ada');
  assert.ok(log.includes('OP-SEC-OK') && log.includes('OP-SEC-M-OK'), 'operation_id skenario rahasia harus tercatat');
  assert.ok(log.includes('OP-SEC-FAIL') && log.includes('OP-SEC-M-FAIL'), 'jalur gagal harus tercatat');
  const errorLines = lines.map((l) => JSON.parse(l)).filter((l) => l.level >= 50);
  assert.ok(errorLines.length >= 2, 'baris level error dari kegagalan kirim harus ada di berkas log');
  assert.ok(log.includes('tanpa operation_id'), 'warn jalur lama harus tercatat');

  const leaks = findLeaks(log);
  assert.deepStrictEqual(leaks, [], `KEBOCORAN di berkas log: ${leaks.join(', ')}`);

  console.log(`OK: berkas log ${lines.length} baris (${errorLines.length} level error) dipindai -- tidak ada isi pesan, media_base64, maupun isi media.`);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
