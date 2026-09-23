'use strict';
/**
 * Skrip simulasi M1 Wave 1 durable buffer. Dibuat di TASK-002 (bagian retry,
 * AC-007); TASK-003 menambah overflow buffer (AC-009, AC-016, dan bagian
 * buffer dari AC-008); TASK-005/006 melengkapi dengan integritas SQLite
 * (AC-011) dan AC-008 penuh lewat siklus worker.
 *
 * Bagian retry dan overflow memakai buffer palsu yang bisa diprogram untuk
 * gagal. Bagian integrasi worker (TASK-004) memakai singleton nyata yang
 * diarahkan ke folder temp (dihapus setelah tes) dan CI4 dikosongkan supaya
 * tidak pernah ada pengiriman HTTP sungguhan.
 * Jalankan: node test/simulate-durable-buffer.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// HARUS sebelum modul src/ mana pun di-require: config dibaca sekali saat load.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-durable-buffer-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'gateway.sqlite');
process.env.CI4_BASE_URL = '';
process.env.CI4_GATEWAY_TOKEN = '';

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

  // ---- TASK-004: wiring -- jalur terima pesan + siklus worker (AC-008 penuh) ----
  console.log('\n--- 12. AC-008: enqueue gagal terus -> overflow; pulih saat siklus worker berjalan ---');
  const { ensureBaileysLoaded } = require('../src/whatsapp/baileysLoader');
  await ensureBaileysLoaded();
  const connectionManager = require('../src/whatsapp/connectionManager');
  const incomingBuffer = require('../src/store/incomingBuffer');
  const { overflowBuffer } = require('../src/store/overflowBuffer');
  const incomingDelivery = require('../src/delivery/incomingDelivery');

  overflowBuffer.items = [];
  const realEnqueue = incomingBuffer.enqueue;
  incomingBuffer.enqueue = () => {
    throw new Error('simulasi database terkunci terus');
  };
  const wiredEvent = {
    messageId: 'SIM-DUR-WIRED-1',
    chatId: '628111000401@s.whatsapp.net',
    jidType: 'pn',
    messageType: 'text',
    text: 'via overflow',
    timestamp: new Date().toISOString(),
    direction: 'incoming',
  };
  try {
    await connectionManager._persistIncoming(wiredEvent);
    assert.strictEqual(overflowBuffer.size(), 1, 'gagal terus -> masuk overflow');
    assert.strictEqual(incomingBuffer.countPending(), 0, 'belum ada di buffer utama');

    await incomingDelivery.tick(); // siklus worker, database MASIH gagal
    assert.strictEqual(overflowBuffer.size(), 1, 'drain gagal -> tetap tertampung');

    incomingBuffer.enqueue = realEnqueue; // database pulih
    await incomingDelivery.tick(); // siklus worker berikutnya
    assert.strictEqual(overflowBuffer.size(), 0, 'setelah pulih overflow kosong');
    assert.strictEqual(incomingBuffer.countPending(), 1, 'event tersimpan di buffer utama');
    assert.strictEqual(incomingBuffer.getDueEvents(5)[0].wa_message_id, 'SIM-DUR-WIRED-1');
  } finally {
    incomingBuffer.enqueue = realEnqueue;
  }
  console.log('OK: event tertahan di overflow, lalu tersimpan setelah siklus worker berikutnya.');

  console.log('\n--- 13. Event tidak lengkap -> error keras, TIDAK masuk overflow ---');
  const errorLogs = [];
  const realError = logger.error;
  logger.error = (message, meta) => errorLogs.push({ message, meta });
  try {
    await connectionManager._persistIncoming({ ...wiredEvent, messageId: null });
  } finally {
    logger.error = realError;
  }
  assert.strictEqual(overflowBuffer.size(), 0, 'validasi tidak boleh masuk overflow');
  assert.strictEqual(errorLogs.length, 1);
  assert.deepStrictEqual(errorLogs[0].meta.missing, ['messageId']);
  console.log('OK: event tidak lengkap dicatat error keras dan tidak ditampung.');

  console.log('\n--- 13b. AC-005: pesan lain setelah event tidak lengkap tetap diproses dan tersimpan ---');
  const pendingBefore = incomingBuffer.countPending();
  logger.error = () => {}; // bungkam log error yang memang diharapkan
  try {
    await connectionManager._persistIncoming({ ...wiredEvent, messageId: null }); // tidak lengkap
    await connectionManager._persistIncoming({ ...wiredEvent, messageId: 'SIM-DUR-AFTER-INVALID' }); // valid
  } finally {
    logger.error = realError;
  }
  assert.strictEqual(incomingBuffer.countPending(), pendingBefore + 1, 'hanya pesan valid yang tersimpan');
  console.log('OK: event tidak lengkap tidak menghalangi pesan berikutnya.');

  console.log('\n--- 13c. AC-006: insert tak menghasilkan baris (ID belum ada) lewat jalur terima -> error tak terduga tercatat ---');
  const realRun = incomingBuffer.insertStmt.run.bind(incomingBuffer.insertStmt);
  incomingBuffer.insertStmt.run = () => ({ changes: 0 }); // simulasi baris hilang senyap
  const unexpectedLogs = [];
  logger.error = (message, meta) => unexpectedLogs.push({ message, meta });
  try {
    await connectionManager._persistIncoming({ ...wiredEvent, messageId: 'SIM-DUR-GHOST' });
  } finally {
    logger.error = realError;
    incomingBuffer.insertStmt.run = realRun;
  }
  assert.ok(
    unexpectedLogs.some((l) => /kondisi tak terduga/.test(l.meta?.error || '')),
    'error tak terduga harus tercatat lengkap dengan alasannya'
  );
  assert.strictEqual(overflowBuffer.size(), 1, 'karena bukan validasi, event ditampung (tidak hilang senyap)');
  overflowBuffer.items = []; // bersihkan singleton
  console.log('OK: baris hilang senyap tercatat sebagai error tak terduga dan event tidak hilang.');

  // ---- TASK-005: integritas SQLite saat start (REQ-013, AC-011) + konfigurasi (GUD-001) ----
  const Database = require('better-sqlite3');
  const { IncomingBufferSqlite } = incomingBuffer;
  const integrityDir = path.join(tmpDir, 'integrity');
  fs.mkdirSync(integrityDir);
  const corruptFilesOf = (dbPath) =>
    fs.readdirSync(path.dirname(dbPath)).filter((name) => name.startsWith(path.basename(dbPath)) && name.includes('.corrupt-'));

  console.log('\n--- 14. Database sehat: tidak dipindah, synchronous=FULL, data lama utuh ---');
  const healthyPath = path.join(integrityDir, 'healthy.sqlite');
  let sqliteBuf = new IncomingBufferSqlite(Database, healthyPath);
  sqliteBuf.enqueue({ ...wiredEvent, messageId: 'SIM-DUR-H1' });
  sqliteBuf.close();
  logs = captureLogs(() => {
    sqliteBuf = new IncomingBufferSqlite(Database, healthyPath);
  });
  assert.strictEqual(logs.error.length, 0, 'database sehat tidak boleh memicu error');
  assert.deepStrictEqual(corruptFilesOf(healthyPath), [], 'tidak ada berkas .corrupt-');
  assert.strictEqual(sqliteBuf.countPending(), 1, 'data lama tetap ada');
  assert.strictEqual(sqliteBuf.db.pragma('synchronous', { simple: true }), 2, 'synchronous = FULL (2)');
  sqliteBuf.close();
  console.log('OK: database sehat dibuka apa adanya, synchronous FULL.');

  console.log('\n--- 15. AC-011: berkas bukan-database (+ -wal/-shm) -> dipindah, database baru, error keras ---');
  const garbagePath = path.join(integrityDir, 'garbage.sqlite');
  for (const suffix of ['', '-wal', '-shm']) {
    fs.writeFileSync(garbagePath + suffix, Buffer.alloc(4096, 0xab));
  }
  logs = captureLogs(() => {
    sqliteBuf = new IncomingBufferSqlite(Database, garbagePath);
  });
  assert.strictEqual(corruptFilesOf(garbagePath).length, 3, 'utama + -wal + -shm dipindah, bukan dihapus');
  assert.strictEqual(logs.error.length, 1);
  assert.strictEqual(logs.error[0].meta.severity, 'critical');
  assert.strictEqual(logs.error[0].meta.moved.length, 3);
  assert.deepStrictEqual(sqliteBuf.enqueue({ ...wiredEvent, messageId: 'SIM-DUR-G1' }), { status: 'inserted' }, 'database baru berfungsi');
  assert.strictEqual(sqliteBuf.db.pragma('synchronous', { simple: true }), 2, 'database baru juga FULL');
  sqliteBuf.close();
  console.log('OK: 3 berkas dipindah ke .corrupt-<waktu>, database baru dibuat, error keras tercatat.');

  console.log('\n--- 16. AC-011: database valid tapi halaman rusak -> dipindah, database baru ---');
  const damagedPath = path.join(integrityDir, 'damaged.sqlite');
  sqliteBuf = new IncomingBufferSqlite(Database, damagedPath);
  for (let i = 1; i <= 5; i += 1) sqliteBuf.enqueue({ ...wiredEvent, messageId: `SIM-DUR-D${i}` });
  sqliteBuf.close();
  const fd = fs.openSync(damagedPath, 'r+');
  fs.writeSync(fd, Buffer.alloc(4096, 0xff), 0, 4096, 4096); // rusak halaman ke-2 (b-tree tabel)
  fs.closeSync(fd);
  logs = captureLogs(() => {
    sqliteBuf = new IncomingBufferSqlite(Database, damagedPath);
  });
  assert.ok(corruptFilesOf(damagedPath).length >= 1, 'berkas rusak dipindah');
  assert.strictEqual(logs.error.length, 1, 'error keras tercatat');
  assert.strictEqual(sqliteBuf.countPending(), 0, 'database baru kosong (pesan lama dianggap hilang dari antrean aktif)');
  sqliteBuf.close();
  console.log('OK: kerusakan tingkat halaman terdeteksi dan ditangani sama.');

  console.log('\n--- 17. Konfigurasi ENQUEUE_RETRY_DELAYS_MS / ENQUEUE_OVERFLOW_MAX (GUD-001) ---');
  const { execFileSync } = require('child_process');
  const repoRoot = path.resolve(__dirname, '..');
  const readConfig = (envOverrides) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ['-e', "const c = require('./src/config'); console.log(JSON.stringify([c.enqueueRetryDelaysMs, c.enqueueOverflowMax]))"],
        { cwd: repoRoot, env: { ...process.env, ENQUEUE_RETRY_DELAYS_MS: '', ENQUEUE_OVERFLOW_MAX: '', ...envOverrides }, encoding: 'utf8' }
      )
    );
  assert.deepStrictEqual(readConfig({}), [[50, 200, 800], 500], 'bawaan');
  assert.deepStrictEqual(readConfig({ ENQUEUE_RETRY_DELAYS_MS: '10, 20' }), [[10, 20], 500], 'daftar kustom (spasi ditoleransi)');
  assert.deepStrictEqual(readConfig({ ENQUEUE_RETRY_DELAYS_MS: 'abc' }), [[50, 200, 800], 500], 'tidak valid -> bawaan utuh');
  assert.deepStrictEqual(readConfig({ ENQUEUE_RETRY_DELAYS_MS: '50,-1' }), [[50, 200, 800], 500], 'negatif -> bawaan utuh');
  assert.deepStrictEqual(readConfig({ ENQUEUE_OVERFLOW_MAX: '25' })[1], 25);
  assert.strictEqual(readConfig({ ENQUEUE_OVERFLOW_MAX: '0' })[1], 1, '0 dijaga minimal 1 (0 = buang semua event)');
  assert.strictEqual(readConfig({ ENQUEUE_OVERFLOW_MAX: 'x' })[1], 500, 'tidak valid -> bawaan');
  console.log('OK: bawaan, kustom, dan nilai tidak valid ditangani.');

  // ---- Refactor Fase 1 (SEC-001, SEC-002, CR-01): database sehat TERKUNCI saat start ----
  // Kunci eksklusif dari koneksi lain meniru CR-01 (instance Gateway kedua, DB browser, antivirus).
  const lockDatabase = (dbPath) => {
    const locker = new Database(dbPath);
    locker.pragma('locking_mode = EXCLUSIVE');
    locker.exec('BEGIN EXCLUSIVE');
    return () => {
      locker.exec('COMMIT');
      locker.close();
    };
  };
  // Timeout kecil HANYA di sisi uji (bawaan better-sqlite3 5 s); source tidak diubah (CR-05 di luar scope).
  const FastDatabase = function FastDatabase(file, options) {
    return new Database(file, { timeout: 100, ...options });
  };

  console.log('\n--- 18. SEC-001: database sehat TERKUNCI saat start -> melempar SQLITE_BUSY, TIDAK dikarantina ---');
  const lockedPath = path.join(integrityDir, 'locked.sqlite');
  sqliteBuf = new IncomingBufferSqlite(Database, lockedPath);
  sqliteBuf.enqueue({ ...wiredEvent, messageId: 'SIM-DUR-L1' });
  sqliteBuf.close();
  let unlock = lockDatabase(lockedPath);
  try {
    logs = captureLogs(() => {
      assert.throws(
        () => new IncomingBufferSqlite(FastDatabase, lockedPath),
        (err) => {
          // Bukan EBUSY dari renameSync karantina: berkas tidak boleh disentuh sama sekali.
          assert.strictEqual(err.code, 'SQLITE_BUSY', `error asli SQLite yang dilempar ulang (didapat ${err.code})`);
          return true;
        }
      );
    });
  } finally {
    unlock();
  }
  assert.deepStrictEqual(corruptFilesOf(lockedPath), [], 'database sehat tidak boleh dipindah ke .corrupt-');
  assert.strictEqual(logs.error.length, 0, 'tidak ada log "korup"');
  sqliteBuf = new IncomingBufferSqlite(Database, lockedPath);
  assert.strictEqual(sqliteBuf.countPending(), 1, 'baris pending tetap di antrean aktif setelah kunci dilepas');
  sqliteBuf.close();
  console.log('OK: database terkunci dilempar ulang apa adanya, tidak dipindah, data utuh setelah kunci lepas.');

  console.log('\n--- 19. SEC-001 regresi: berkas bukan database (SQLITE_NOTADB) -> TETAP dikarantina ---');
  const notDbPath = path.join(integrityDir, 'notadb.sqlite');
  fs.writeFileSync(notDbPath, 'ini bukan database SQLite');
  logs = captureLogs(() => {
    sqliteBuf = new IncomingBufferSqlite(Database, notDbPath);
  });
  assert.strictEqual(corruptFilesOf(notDbPath).length, 1, 'berkas dipindah ke .corrupt-, bukan dihapus');
  assert.strictEqual(logs.error.length, 1, 'error keras tercatat');
  assert.match(logs.error[0].meta.detail, /not a database/, 'jalur kode SQLITE_NOTADB');
  assert.deepStrictEqual(sqliteBuf.enqueue({ ...wiredEvent, messageId: 'SIM-DUR-N1' }), { status: 'inserted' }, 'database baru berfungsi');
  sqliteBuf.close();
  console.log('OK: berkas bukan database tetap dikarantina dan database baru dibuat.');

  console.log('\n--- 20. SEC-002: singleton pada database terkunci -> proses berhenti, log [CRITICAL], TANPA buffer JSON ---');
  const childDir = path.join(tmpDir, 'singleton-locked');
  fs.mkdirSync(childDir);
  const childDbPath = path.join(childDir, 'gateway.sqlite');
  sqliteBuf = new IncomingBufferSqlite(Database, childDbPath);
  sqliteBuf.close();
  // Anak MENYIMPAN satu pesan: bila singleton diam-diam pindah ke JSON, gateway.json pasti tertulis.
  const childScript = `const b = require('./src/store/incomingBuffer');
    b.enqueue(${JSON.stringify({ ...wiredEvent, messageId: 'SIM-DUR-CHILD-1' })});`;
  let child;
  unlock = lockDatabase(childDbPath);
  try {
    execFileSync(process.execPath, ['-e', childScript], {
      cwd: repoRoot,
      // LOG_FOLDER kosong: log ke stdout (yang ditangkap PM2) supaya asersi deterministik.
      env: { ...process.env, SQLITE_PATH: childDbPath, CI4_BASE_URL: '', CI4_GATEWAY_TOKEN: '', LOG_FOLDER: '' },
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 60000,
    });
    child = { status: 0, output: '' };
  } catch (err) {
    child = { status: err.status, output: `${err.stdout}${err.stderr}` };
  } finally {
    unlock();
  }
  assert.ok(child.status !== 0 && child.status !== null, `proses anak harus exit non-zero (status=${child.status})`);
  assert.match(child.output, /\[CRITICAL\] gagal membuka database SQLite incoming buffer/, 'log [CRITICAL] tercatat');
  assert.deepStrictEqual(fs.readdirSync(childDir).filter((name) => name.includes('.json')), [], 'tidak ada berkas .json (tidak pindah ke JSON)');
  assert.deepStrictEqual(corruptFilesOf(childDbPath), [], 'database terkunci tidak dikarantina');
  console.log(`OK: proses anak exit ${child.status}, [CRITICAL] tercatat, tidak ada berkas .json.`);

  // ---- Refactor Fase 2 (PRN-001, CR-02): drain overflow tidak tertahan siklus kirim CI4 ----
  console.log('\n--- 21. PRN-001: siklus kirim ke CI4 masih berjalan (isRunning) -> overflow TETAP terkuras ---');
  const config = require('../src/config');
  const realCi4 = { ...config.ci4 };
  const realFetch = global.fetch;
  const fetchCalls = [];
  let releaseFetch;
  // Kirim pertama ke CI4 menggantung sampai dilepas; kiriman sesudahnya langsung sukses.
  global.fetch = () => {
    fetchCalls.push(Date.now());
    const reply = () => new Response(JSON.stringify({ status: 'success' }), { status: 200 });
    if (fetchCalls.length > 1) return Promise.resolve(reply());
    return new Promise((resolve) => {
      releaseFetch = () => resolve(reply());
    });
  };
  config.ci4.baseUrl = 'http://ci4.test.invalid';
  config.ci4.gatewayToken = 'token-uji';
  let firstTick;
  try {
    assert.ok(incomingBuffer.countPending() >= 1, 'prasyarat: ada event jatuh tempo untuk dikirim');
    firstTick = incomingDelivery.tick(); // TIDAK di-await: berhenti di dalam fetch yang menggantung
    assert.strictEqual(fetchCalls.length, 1, 'siklus pertama sedang menunggu CI4 (isRunning)');

    overflowBuffer.push({ ...wiredEvent, messageId: 'SIM-DUR-DRAIN-BUSY' });
    await incomingDelivery.tick(); // siklus kedua saat siklus pertama belum selesai
    assert.strictEqual(overflowBuffer.size(), 0, 'overflow terkuras walau siklus kirim masih berjalan');
    assert.ok(
      incomingBuffer.db.prepare('SELECT 1 FROM incoming_queue WHERE wa_message_id = ?').get('SIM-DUR-DRAIN-BUSY'),
      'event tersimpan di buffer utama'
    );
    assert.strictEqual(fetchCalls.length, 1, 'siklus kedua tidak ikut mengirim (cek isRunning tetap berlaku)');
  } finally {
    if (releaseFetch) releaseFetch();
    await firstTick;
    global.fetch = realFetch;
    Object.assign(config.ci4, realCi4);
    overflowBuffer.items = [];
  }
  console.log('OK: overflow terkuras ke buffer utama saat siklus kirim ke CI4 masih menggantung.');

  console.log('\nSemua assert simulate-durable-buffer (retry + overflow + wiring + integritas) lolos.');
  cleanup(incomingBuffer);
})().catch((err) => {
  console.error('SIMULASI GAGAL:', err);
  cleanup();
  process.exit(1);
});

/** Lepas handle singleton lalu hapus folder temp (Windows menolak hapus file terbuka). */
function cleanup(incomingBuffer) {
  try {
    (incomingBuffer || require('../src/store/incomingBuffer')).close();
  } catch (err) {
    // abaikan
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    // Jangan menutupi kegagalan tes yang sebenarnya dengan error pembersihan (mis. EBUSY di Windows).
    console.error(`Peringatan: folder temp tidak terhapus (${err.code}): ${tmpDir}`);
  }
}
