'use strict';
/**
 * Skrip simulasi M1 Wave 1 durable buffer. Dibuat di TASK-002 (bagian retry,
 * AC-007); TASK-003 menambah overflow buffer (AC-009, AC-016, dan bagian
 * buffer dari AC-008); TASK-005/006 melengkapi dengan integritas SQLite
 * (AC-011) dan AC-008 penuh lewat siklus worker.
 *
 * Bagian retry dan overflow memakai buffer palsu yang bisa diprogram untuk
 * gagal, jadi tidak membuka database dan tidak menyentuh berkas apa pun.
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

  // ---- TASK-003: overflow buffer (REQ-010/011/012, AC-008 bagian buffer, AC-009, AC-016) ----
  const logger = require('../src/logging');
  const { OverflowBuffer } = require('../src/store/overflowBuffer');

  /** Tangkap panggilan logger selama fn() berjalan, lalu pulihkan. */
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

  console.log('\n--- 7. overflow: push menambah, size() akurat, ukuran tercatat (AC-016) ---');
  let overflow = new OverflowBuffer(3);
  let logs = captureLogs(() => {
    assert.strictEqual(overflow.push({ messageId: 'A' }), false);
    assert.strictEqual(overflow.push({ messageId: 'B' }), false);
  });
  assert.strictEqual(overflow.size(), 2);
  assert.deepStrictEqual(logs.warn.map((l) => l.meta.size), [1, 2], 'tiap perubahan ukuran tercatat');
  console.log('OK: size 2, ukuran 1 lalu 2 tercatat.');

  console.log('\n--- 8. AC-009: penuh -> event TERBARU dibuang, log critical berisi jumlah dibuang ---');
  overflow = new OverflowBuffer(2);
  overflow.push({ messageId: 'OLD-1' });
  overflow.push({ messageId: 'OLD-2' });
  logs = captureLogs(() => {
    assert.strictEqual(overflow.push({ messageId: 'NEW-3' }), true, 'push penuh harus mengembalikan true (dibuang)');
    assert.strictEqual(overflow.push({ messageId: 'NEW-4' }), true);
  });
  assert.strictEqual(overflow.size(), 2, 'ukuran tidak melebihi batas');
  assert.deepStrictEqual(
    overflow.items.map((e) => e.messageId),
    ['OLD-1', 'OLD-2'],
    'yang lama dipertahankan, yang terbaru dibuang'
  );
  assert.strictEqual(logs.error.length, 2, 'tiap pembuangan dicatat error keras');
  assert.match(logs.error[0].message, /^\[CRITICAL\]/);
  assert.strictEqual(logs.error[0].meta.severity, 'critical');
  assert.strictEqual(logs.error[0].meta.dropped, 1);
  assert.strictEqual(logs.error[1].meta.totalDropped, 2, 'akumulasi jumlah dibuang tercatat');
  assert.strictEqual(logs.warn.length, 0, 'event yang dibuang tidak dicatat sebagai masuk');
  console.log('OK: 2 event terbaru dibuang, log critical mencatat dropped=1 dan totalDropped=2.');

  console.log('\n--- 9. AC-008 (bagian buffer): drain memasukkan yang berhasil, sisanya tetap ---');
  overflow = new OverflowBuffer(5);
  ['E1', 'E2', 'E3'].forEach((id) => overflow.push({ messageId: id }));
  const stored = [];
  let remaining;
  logs = captureLogs(() => {
    remaining = overflow.drain((event) => {
      if (event.messageId === 'E2') throw new Error('masih gagal');
      stored.push(event.messageId);
    });
  });
  assert.deepStrictEqual(stored, ['E1', 'E3']);
  assert.deepStrictEqual(remaining.map((e) => e.messageId), ['E2'], 'yang gagal tetap tertampung');
  assert.strictEqual(overflow.size(), 1);
  assert.strictEqual(logs.info.length, 1);
  assert.strictEqual(logs.info[0].meta.size, 1, 'ukuran terbaru tercatat setelah drain (AC-016)');
  assert.strictEqual(logs.info[0].meta.drained, 2);
  console.log('OK: E1/E3 tersimpan, E2 tetap, ukuran 1 tercatat.');

  console.log('\n--- 10. drain sekali coba per event; pulih pada siklus berikutnya -> kosong ---');
  let attempts = 0;
  overflow.drain(() => {
    attempts += 1;
    throw new Error('masih gagal');
  });
  assert.strictEqual(attempts, 1, 'satu percobaan per event per drain, tanpa jeda/ulang');
  assert.strictEqual(overflow.size(), 1);
  logs = captureLogs(() => overflow.drain(() => {}));
  assert.strictEqual(overflow.size(), 0, 'setelah database pulih penampung kosong');
  assert.strictEqual(logs.info[0].meta.size, 0);
  console.log('OK: sekali coba per event, kosong setelah pulih.');

  console.log('\n--- 11. drain gagal semua / kosong -> ukuran tidak berubah, tidak ada log ---');
  overflow = new OverflowBuffer(5);
  logs = captureLogs(() => {
    assert.deepStrictEqual(overflow.drain(() => {}), [], 'kosong -> []');
  });
  assert.strictEqual(logs.info.length, 0);
  overflow.push({ messageId: 'Z' });
  logs = captureLogs(() => overflow.drain(() => { throw new Error('x'); }));
  assert.strictEqual(logs.info.length, 0, 'ukuran tidak berubah -> tidak ada log baru');
  assert.strictEqual(overflow.size(), 1);
  console.log('OK: tanpa perubahan ukuran, tanpa log.');

  console.log('\nSemua assert simulate-durable-buffer (retry + overflow) lolos.');
})().catch((err) => {
  console.error('SIMULASI GAGAL:', err);
  process.exit(1);
});
