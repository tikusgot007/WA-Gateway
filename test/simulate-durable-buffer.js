'use strict';
/**
 * Skrip simulasi M1 Wave 1 durable buffer. Dibuat di TASK-002 (bagian retry,
 * AC-007); TASK-003/005/006 melengkapi dengan overflow (AC-008, AC-009,
 * AC-016) dan integritas SQLite (AC-011).
 *
 * Bagian retry memakai buffer palsu yang bisa diprogram untuk gagal, jadi
 * tidak membuka database dan tidak menyentuh berkas apa pun.
 * Jalankan: node test/simulate-durable-buffer.js
 */
const assert = require('assert');
const { enqueueWithRetry, DEFAULT_RETRY_DELAYS_MS } = require('../src/store/enqueueRetry');
const { EnqueueValidationError } = require('../src/store/enqueueValidationError');

/** Buffer palsu: gagal `failTimes` kali dengan `errorFactory`, lalu sukses. */
function makeFakeBuffer(failTimes, errorFactory = () => new Error('SQLITE_BUSY: database is locked')) {
  return {
    calls: 0,
    enqueue(event) {
      this.calls += 1;
      if (this.calls <= failTimes) throw errorFactory();
      return { status: 'inserted', messageId: event.messageId };
    },
  };
}

const event = { messageId: 'SIM-DUR-1' };
const FAST = [1, 2, 3]; // jeda kecil supaya tes cepat

(async () => {
  console.log('--- 0. Jeda bawaan sesuai REQ-009 ---');
  assert.deepStrictEqual([...DEFAULT_RETRY_DELAYS_MS], [50, 200, 800]);
  console.log('OK: bawaan 50, 200, 800 ms.');

  console.log('\n--- 1. Sukses langsung -> satu pemanggilan, hasil diteruskan ---');
  let buf = makeFakeBuffer(0);
  assert.deepStrictEqual(await enqueueWithRetry(buf, event, FAST), { status: 'inserted', messageId: 'SIM-DUR-1' });
  assert.strictEqual(buf.calls, 1);
  console.log('OK: tidak ada retry saat sukses.');

  console.log('\n--- 2. AC-007: gagal 2x lalu berhasil -> tersimpan setelah retry ---');
  buf = makeFakeBuffer(2);
  assert.strictEqual((await enqueueWithRetry(buf, event, FAST)).status, 'inserted');
  assert.strictEqual(buf.calls, 3, '2 gagal + 1 sukses');
  console.log('OK: pulih setelah 2 kegagalan.');

  console.log('\n--- 3. Gagal 3x lalu berhasil pada percobaan ulang ke-3 (batas terakhir) ---');
  buf = makeFakeBuffer(3);
  assert.strictEqual((await enqueueWithRetry(buf, event, FAST)).status, 'inserted');
  assert.strictEqual(buf.calls, 4, '1 awal + 3 ulangan');
  console.log('OK: percobaan ulang ke-3 masih diterima.');

  console.log('\n--- 4. Gagal terus -> 4 pemanggilan, error TERAKHIR dilempar ulang ---');
  let n = 0;
  buf = makeFakeBuffer(99, () => new Error(`gagal ke-${(n += 1)}`));
  await assert.rejects(
    () => enqueueWithRetry(buf, event, FAST),
    (err) => {
      assert.strictEqual(err.message, 'gagal ke-4', 'harus error terakhir');
      return true;
    }
  );
  assert.strictEqual(buf.calls, 4, '1 awal + 3 ulangan, tidak lebih');
  console.log('OK: berhenti setelah 3 ulangan, error terakhir dilempar.');

  console.log('\n--- 5. EnqueueValidationError -> dilempar langsung, TANPA retry ---');
  buf = makeFakeBuffer(99, () => new EnqueueValidationError(['messageId']));
  await assert.rejects(
    () => enqueueWithRetry(buf, event, FAST),
    (err) => err instanceof EnqueueValidationError
  );
  assert.strictEqual(buf.calls, 1, 'validasi tidak boleh dicoba ulang');
  console.log('OK: error validasi tidak di-retry.');

  console.log('\n--- 6. Jeda nyata (bawaan) benar-benar ditunggu ---');
  buf = makeFakeBuffer(2);
  const started = Date.now();
  await enqueueWithRetry(buf, event); // 50 + 200 ms
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 240, `harus menunggu >= 250ms, terukur ${elapsed}ms`);
  assert.ok(elapsed < 800, `tidak boleh memakai jeda ke-3 (800ms), terukur ${elapsed}ms`);
  console.log(`OK: menunggu ${elapsed}ms untuk 2 retry (50 + 200 ms).`);

  console.log('\nSemua assert simulate-durable-buffer (bagian retry) lolos.');
})().catch((err) => {
  console.error('SIMULASI GAGAL:', err);
  process.exit(1);
});
