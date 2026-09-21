'use strict';
/**
 * Skrip simulasi (BUKAN pengganti test nyata) untuk memvalidasi perbaikan
 * E-05 (docs/decisions/2026-09-21-m1-ticket02-audit-enqueue.md, M1 Ticket
 * 02): query onWhatsApp() di _resolveLidForPhoneJid() sekarang punya
 * timeout -- query yang tersangkut tidak lagi menahan pemrosesan pesan
 * selamanya.
 *
 * CATATAN: E-06 (fallback pesan minimal saat _handleIncomingMessage()
 * gagal) yang tadinya diuji bersama di file ini SUDAH DIREVERT -- plan
 * resmi (plan/plan-process-m1-wave1-incoming-reliability-v1.0.md, ALT-004)
 * menolak eksplisit pendekatan itu (kontrak AuliaPos menolak event tidak
 * lengkap, jadi pesan minimal jadi poison message). Skenario 2 di bawah
 * membuktikan perilaku lama (hanya log, tidak menyimpan apa pun) tetap
 * berlaku.
 *
 * TIDAK ada koneksi WhatsApp sungguhan -- `sock` di-mock.
 */
const assert = require('assert');
const { ensureBaileysLoaded } = require('../src/whatsapp/baileysLoader');

(async () => {
  await ensureBaileysLoaded();
  const connectionManager = require('../src/whatsapp/connectionManager');
  const incomingBuffer = require('../src/store/incomingBuffer');

  console.log("--- 1. E-05: onWhatsApp() tersangkut selamanya -> tetap resolve (timeout), tidak menggantung ---");
  connectionManager.status = 'connected';
  connectionManager.sock = {
    onWhatsApp: () => new Promise(() => {}), // sengaja tidak pernah resolve/reject
  };
  connectionManager._lidResolutionCache.delete('628111000301@s.whatsapp.net');
  const startedAt = Date.now();
  const lid = await connectionManager._resolveLidForPhoneJid('628111000301@s.whatsapp.net');
  const elapsedMs = Date.now() - startedAt;
  assert.strictEqual(lid, null, 'query yang tersangkut harus resolve ke null (best-effort), bukan menggantung');
  assert.ok(elapsedMs < 6000, `harus timeout dalam waktu wajar, butuh ${elapsedMs}ms`);
  console.log(`OK: query tersangkut tetap resolve dalam ${elapsedMs}ms (timeout bekerja).`);
  connectionManager.sock = null;
  connectionManager.status = 'disconnected';

  console.log('\n--- 2. _handleIncomingMessage() gagal -> hanya dilog, TIDAK ada fallback (E-06 direvert) ---');
  const originalHandle = connectionManager._handleIncomingMessage;
  connectionManager._handleIncomingMessage = async function alwaysThrow() {
    throw new Error('simulasi gagal ekstraksi pesan (mis. format media tidak dikenal)');
  };
  try {
    const before = incomingBuffer.countPending();
    await assert.doesNotReject(() =>
      connectionManager._onMessagesUpsert(
        {
          type: 'notify',
          messages: [
            {
              key: { remoteJid: '628111000302@s.whatsapp.net', fromMe: false, id: 'SIM-E05-2' },
              message: { conversation: 'ini akan gagal diproses' },
              messageTimestamp: Math.floor(Date.now() / 1000),
            },
          ],
        },
        connectionManager.generation
      )
    );
    assert.strictEqual(incomingBuffer.countPending(), before, 'TIDAK boleh ada baris baru -- fallback minimal sudah direvert');
  } finally {
    connectionManager._handleIncomingMessage = originalHandle;
  }
  console.log('OK: kegagalan pemrosesan hanya dilog, tidak ada fallback minimal, tidak crash (sesuai revert E-06).');

  console.log('\nSemua simulasi E-05 lolos.');
  process.exit(0);
})().catch((err) => {
  console.error('SIMULASI GAGAL:', err);
  process.exit(1);
});
