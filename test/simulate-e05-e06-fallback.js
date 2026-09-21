'use strict';
/**
 * Skrip simulasi (BUKAN pengganti test nyata) untuk memvalidasi perbaikan
 * E-05 dan E-06 (docs/decisions/2026-09-21-m1-ticket02-audit-enqueue.md,
 * M1 Ticket 02):
 *
 * - E-05: query onWhatsApp() di _resolveLidForPhoneJid() sekarang punya
 *   timeout -- query yang tersangkut tidak lagi menahan pemrosesan pesan
 *   selamanya.
 * - E-06: kalau _handleIncomingMessage() gagal SEBELUM sempat enqueue
 *   (mis. error saat ekstraksi teks/media), _onMessagesUpsert() sekarang
 *   menyimpan record minimal (ID + chat + waktu, tanpa teks/media) lewat
 *   fallback, bukan membuang pesan itu tanpa jejak sama sekali.
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

  console.log('\n--- 2. E-06: _handleIncomingMessage() gagal sebelum enqueue -> fallback minimal tersimpan ---');
  const originalHandle = connectionManager._handleIncomingMessage;
  connectionManager._handleIncomingMessage = async function alwaysThrow() {
    throw new Error('simulasi gagal ekstraksi pesan (mis. format media tidak dikenal)');
  };
  try {
    const before = incomingBuffer.countPending();
    await connectionManager._onMessagesUpsert(
      {
        type: 'notify',
        messages: [
          {
            key: { remoteJid: '628111000302@s.whatsapp.net', fromMe: false, id: 'SIM-E06-1' },
            message: { conversation: 'ini akan gagal diproses' },
            messageTimestamp: Math.floor(Date.now() / 1000),
          },
        ],
      },
      connectionManager.generation
    );
    assert.strictEqual(incomingBuffer.countPending(), before + 1, 'fallback minimal harus tetap masuk antrean');
  } finally {
    connectionManager._handleIncomingMessage = originalHandle;
  }
  console.log('OK: fallback minimal tersimpan walau pemrosesan penuh gagal.');

  console.log('\n--- 3. E-06: pesan tanpa key.id -> tidak ada yang bisa disimpan, hanya dilog (tidak crash) ---');
  connectionManager._handleIncomingMessage = async function alwaysThrow() {
    throw new Error('simulasi gagal, dan pesan ini tidak punya ID sama sekali');
  };
  try {
    await assert.doesNotReject(() =>
      connectionManager._onMessagesUpsert(
        {
          type: 'notify',
          messages: [
            {
              key: { remoteJid: '628111000303@s.whatsapp.net', fromMe: false, id: undefined },
              message: { conversation: 'tanpa id' },
              messageTimestamp: Math.floor(Date.now() / 1000),
            },
          ],
        },
        connectionManager.generation
      )
    );
  } finally {
    connectionManager._handleIncomingMessage = originalHandle;
  }
  console.log('OK: pesan tanpa ID tidak membuat proses crash (hanya dilog sebagai benar-benar hilang).');

  console.log('\nSemua simulasi E-05/E-06 lolos.');
  process.exit(0);
})().catch((err) => {
  console.error('SIMULASI GAGAL:', err);
  process.exit(1);
});
