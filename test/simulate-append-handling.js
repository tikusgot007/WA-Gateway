'use strict';
/**
 * Skrip simulasi M1 Wave 1 Fase 2 (penanganan `append`). Dibuat di TASK-009
 * (bagian pencatatan ID kiriman sendiri, REQ-003 / D-03 / RISK-001);
 * TASK-010/011 melengkapi dengan filter `append` di _onMessagesUpsert
 * (AC-002, AC-003, AC-004, AC-015, AC-017) dan guard statis urutan
 * register() vs sendMessage().
 *
 * Tidak menghubungi WhatsApp: `connectionManager.sock` diganti mock, dan
 * database singleton diarahkan ke folder temp (dihapus setelah tes).
 * Jalankan: node test/simulate-append-handling.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// HARUS sebelum modul src/ mana pun di-require: config dibaca sekali saat load.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-append-handling-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'gateway.sqlite');
process.env.CI4_BASE_URL = '';
process.env.CI4_GATEWAY_TOKEN = '';

const assert = require('assert');
const { ensureBaileysLoaded } = require('../src/whatsapp/baileysLoader');

function cleanup() {
  try {
    require('../src/store/incomingBuffer').close(); // lepas handle sebelum hapus folder (Windows)
  } catch (err) {
    // abaikan
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`Peringatan: folder temp tidak terhapus (${err.code}): ${tmpDir}`);
  }
}

(async () => {
  await ensureBaileysLoaded();
  const connectionManager = require('../src/whatsapp/connectionManager');
  const { ownSentRegistry } = require('../src/whatsapp/ownSentRegistry');

  const originalStatus = connectionManager.status;
  const originalSock = connectionManager.sock;

  /**
   * Mock sock: merekam argumen sendMessage dan apakah ID SUDAH tercatat di
   * ownSentRegistry pada saat sendMessage dipanggil (inti RISK-001).
   */
  function installMockSock({ reject = false } = {}) {
    const calls = [];
    connectionManager.status = 'connected';
    connectionManager.sock = {
      user: { id: '628111000999:1@s.whatsapp.net' },
      async sendMessage(jid, content, options) {
        calls.push({
          jid,
          content,
          options,
          registeredAtCallTime: ownSentRegistry.wasSentByUs(options?.messageId),
        });
        // Beri kesempatan event lain berjalan sebelum sendMessage kembali --
        // di Baileys asli, `append` kiriman sendiri tiba tepat di sini.
        await new Promise((resolve) => setImmediate(resolve));
        if (reject) throw new Error('simulasi kirim gagal');
        return { key: { id: options?.messageId }, message: {} };
      },
    };
    return calls;
  }

  try {
    console.log('--- 1. Teks: ID ditentukan & DICATAT SEBELUM sendMessage, diteruskan lewat opsi messageId ---');
    let calls = installMockSock();
    const textResult = await connectionManager.sendTextMessage('628111000101@s.whatsapp.net', 'halo');
    assert.strictEqual(calls.length, 1);
    const textId = calls[0].options.messageId;
    assert.match(textId, /^3EB0[0-9A-F]{18}$/, 'format ID pesan WhatsApp (3EB0 + 18 hex)');
    assert.strictEqual(calls[0].registeredAtCallTime, true, 'ID SUDAH tercatat saat sendMessage dipanggil (D-03)');
    assert.strictEqual(textResult.messageId, textId, 'ID yang dikembalikan = ID yang dicatat');
    assert.strictEqual(ownSentRegistry.wasSentByUs(textId), true);
    console.log('OK: teks -- ID dicatat sebelum kirim dan diteruskan ke Baileys.');

    console.log('\n--- 2. Media (image/document/sticker): perilaku yang sama ---');
    for (const mediaType of ['image', 'document', 'sticker']) {
      calls = installMockSock();
      const mediaResult = await connectionManager.sendMediaMessage(
        '628111000102@s.whatsapp.net',
        mediaType,
        Buffer.from('isi'),
        { fileName: 'f.bin' }
      );
      const mediaId = calls[0].options.messageId;
      assert.match(mediaId, /^3EB0[0-9A-F]{18}$/, `${mediaType}: format ID`);
      assert.strictEqual(calls[0].registeredAtCallTime, true, `${mediaType}: tercatat SEBELUM sendMessage`);
      assert.strictEqual(mediaResult.messageId, mediaId);
      assert.strictEqual(ownSentRegistry.wasSentByUs(mediaId), true);
    }
    console.log('OK: media -- ID dicatat sebelum kirim untuk image, document, dan sticker.');

    console.log('\n--- 3. Kirim GAGAL (reject) -> ID tetap tercatat (register sebelum await) ---');
    calls = installMockSock({ reject: true });
    await assert.rejects(
      () => connectionManager.sendTextMessage('628111000103@s.whatsapp.net', 'gagal'),
      (err) => err.code === 'SEND_FAILED'
    );
    assert.strictEqual(ownSentRegistry.wasSentByUs(calls[0].options.messageId), true, 'ID tercatat walau kirim gagal');
    calls = installMockSock({ reject: true });
    await assert.rejects(
      () => connectionManager.sendMediaMessage('628111000103@s.whatsapp.net', 'image', Buffer.from('x'), {}),
      (err) => err.code === 'SEND_FAILED'
    );
    assert.strictEqual(ownSentRegistry.wasSentByUs(calls[0].options.messageId), true, 'media: tercatat walau gagal');
    console.log('OK: ID tetap tercatat saat sendMessage menolak (teks dan media).');

    console.log('\n--- 4. Tiap kiriman mendapat ID unik ---');
    calls = installMockSock();
    await connectionManager.sendTextMessage('628111000104@s.whatsapp.net', 'satu');
    await connectionManager.sendTextMessage('628111000104@s.whatsapp.net', 'dua');
    assert.notStrictEqual(calls[0].options.messageId, calls[1].options.messageId);
    console.log('OK: dua kiriman, dua ID berbeda.');

    console.log('\nSemua assert simulate-append-handling (bagian pencatatan ID) lolos.');
  } finally {
    connectionManager.status = originalStatus;
    connectionManager.sock = originalSock;
  }
})()
  .then(cleanup)
  .catch((err) => {
    console.error('SIMULASI GAGAL:', err);
    cleanup();
    process.exit(1);
  });
