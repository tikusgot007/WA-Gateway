'use strict';
/**
 * Skrip simulasi (BUKAN pengganti test nyata) untuk memvalidasi perbaikan
 * E-03 dan E-04 (docs/decisions/2026-09-21-m1-ticket02-audit-enqueue.md,
 * M1 Ticket 02):
 *
 * - E-03: pelanggaran field wajib (mis. wa_message_id kosong) sekarang
 *   melempar Error yang terlihat, bukan diabaikan diam-diam oleh
 *   `INSERT OR IGNORE`.
 * - E-04: kegagalan sesaat saat enqueue (mis. lock/disk sibuk) sekarang
 *   dicoba ulang beberapa kali di dalam proses sebelum benar-benar
 *   dianggap gagal, lalu ditampung di overflow buffer (M1 Wave 1
 *   TASK-004, lewat _persistIncoming()).
 *
 * Duplikat wa_message_id (idempotensi normal, E-10) HARUS tetap diabaikan
 * seperti sebelumnya -- itu bukan kegagalan.
 */
const assert = require('assert');
const { ensureBaileysLoaded } = require('../src/whatsapp/baileysLoader');
const incomingBuffer = require('../src/store/incomingBuffer');

(async () => {
  await ensureBaileysLoaded();
  const connectionManager = require('../src/whatsapp/connectionManager');

  console.log('--- 1. enqueue() dengan wa_message_id kosong -> throw, bukan silently ignored ---');
  assert.throws(
    () =>
      incomingBuffer.enqueue({
        messageId: null,
        chatId: '628111000201@s.whatsapp.net',
        jidType: 'pn',
        messageType: 'text',
        text: 'tanpa id',
        timestamp: new Date().toISOString(),
      }),
    /field wajib kosong/,
    'enqueue tanpa messageId harus throw Error, bukan diam-diam sukses'
  );
  console.log('OK: field wajib kosong ditolak dengan Error.');

  console.log('\n--- 2. enqueue() dengan chatId kosong -> throw ---');
  assert.throws(
    () =>
      incomingBuffer.enqueue({
        messageId: 'SIM-ENQ-2',
        chatId: null,
        jidType: 'pn',
        messageType: 'text',
        text: 'tanpa chatId',
        timestamp: new Date().toISOString(),
      }),
    /field wajib kosong/,
    'enqueue tanpa chatId harus throw Error'
  );
  console.log('OK: chatId kosong ditolak dengan Error.');

  console.log('\n--- 3. enqueue() dengan field lengkap -> tetap sukses seperti sebelumnya ---');
  const before = incomingBuffer.countPending();
  incomingBuffer.enqueue({
    messageId: 'SIM-ENQ-3',
    chatId: '628111000203@s.whatsapp.net',
    jidType: 'pn',
    messageType: 'text',
    text: 'lengkap',
    timestamp: new Date().toISOString(),
  });
  assert.strictEqual(incomingBuffer.countPending(), before + 1, 'enqueue valid harus tetap menambah antrean (tidak ada regresi)');
  console.log('OK: enqueue valid tidak ada regresi.');

  console.log('\n--- 4. enqueue() duplikat wa_message_id -> tetap diabaikan diam-diam (bukan Error) ---');
  assert.doesNotThrow(() =>
    incomingBuffer.enqueue({
      messageId: 'SIM-ENQ-3', // sama seperti langkah 3
      chatId: '628111000203@s.whatsapp.net',
      jidType: 'pn',
      messageType: 'text',
      text: 'duplikat',
      timestamp: new Date().toISOString(),
    })
  );
  assert.strictEqual(incomingBuffer.countPending(), before + 1, 'duplikat tidak boleh menambah baris baru');
  console.log('OK: duplikat tetap diabaikan tanpa error (idempotensi terjaga).');

  // Skenario 5-6 dipindahkan dari _enqueueWithRetry() ad-hoc (dihapus di M1
  // Wave 1 TASK-004) ke _persistIncoming(): kontrak retry-nya sekarang
  // mengikuti spec (REQ-009: 1 + 3 ulangan berjeda 50/200/800 ms) dan
  // kegagalan akhir ditampung di overflow buffer (D-02), bukan dilempar.
  const { overflowBuffer } = require('../src/store/overflowBuffer');

  console.log('\n--- 5. _persistIncoming() mencoba ulang saat enqueue gagal sesaat, lalu berhasil ---');
  const originalEnqueue = incomingBuffer.enqueue;
  let callCount = 0;
  incomingBuffer.enqueue = function mockEnqueue(event) {
    callCount += 1;
    if (callCount < 3) {
      throw new Error('simulasi database terkunci sesaat');
    }
    return originalEnqueue.call(incomingBuffer, event);
  };
  try {
    await connectionManager._persistIncoming({
      messageId: 'SIM-ENQ-5',
      chatId: '628111000205@s.whatsapp.net',
      jidType: 'pn',
      messageType: 'text',
      text: 'retry',
      timestamp: new Date().toISOString(),
    });
    assert.strictEqual(callCount, 3, 'harus mencoba 3 kali sebelum berhasil');
    assert.strictEqual(overflowBuffer.size(), 0, 'pulih lewat retry -> overflow tetap kosong');
  } finally {
    incomingBuffer.enqueue = originalEnqueue;
  }
  console.log('OK: retry mencoba ulang lalu berhasil, tidak langsung dianggap gagal.');

  console.log('\n--- 6. _persistIncoming() menampung ke overflow setelah semua percobaan habis, tanpa melempar ---');
  let failCalls = 0;
  incomingBuffer.enqueue = function alwaysFail() {
    failCalls += 1;
    throw new Error('simulasi database rusak permanen');
  };
  try {
    await assert.doesNotReject(() =>
      connectionManager._persistIncoming({
        messageId: 'SIM-ENQ-6',
        chatId: '628111000206@s.whatsapp.net',
        jidType: 'pn',
        messageType: 'text',
        text: 'gagal terus',
        timestamp: new Date().toISOString(),
      })
    );
    assert.strictEqual(failCalls, 4, '1 percobaan awal + 3 ulangan');
    assert.strictEqual(overflowBuffer.size(), 1, 'event tertampung di overflow, tidak hilang');
    assert.strictEqual(overflowBuffer.items[0].messageId, 'SIM-ENQ-6');
  } finally {
    incomingBuffer.enqueue = originalEnqueue;
    overflowBuffer.items = []; // bersihkan singleton untuk skrip berikutnya
  }
  console.log('OK: setelah semua percobaan habis, event ditampung di overflow dan tidak melempar.');

  console.log('\nSemua simulasi enqueue failure lolos.');
  process.exit(0);
})().catch((err) => {
  console.error('SIMULASI GAGAL:', err);
  process.exit(1);
});
