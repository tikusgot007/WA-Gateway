'use strict';
/**
 * Skrip simulasi bug-fix plan-bugfix-wa-gateway-pairing-code-logged-out-v1.0
 * (Fase 1, TASK-001/TASK-002): membuktikan dua celah pada
 * src/whatsapp/connectionManager.js seputar transisi `logged_out`:
 *
 * 1. REQ-001 -- setelah `connection.update` melaporkan `lastDisconnect`
 *    dengan statusCode `DisconnectReason.loggedOut`, `this.sock` HARUS
 *    di-null-kan (socket zombie tidak boleh tetap tersimpan), sama seperti
 *    pola cleanup yang sudah ada di logout() (lines 356-370).
 * 2. REQ-002 -- requestPairingCode() yang dipanggil SETELAH status menjadi
 *    `logged_out` HARUS langsung ditolak (reject) dengan pesan yang
 *    menyebut logout/reset, bukan diam-diam lolos ke socket mati.
 *
 * Baileys TIDAK dipakai secara nyata: `this.sock` di-stub manual (objek
 * polos dengan ev.removeAllListeners/end/authState), sesuai pola stubbing
 * yang sudah dipakai test/simulate-outgoing-idempotency.js dkk -- DisconnectReason
 * sendiri tetap diambil dari modul baileys asli (via ensureBaileysLoaded())
 * supaya nilai statusCode yang dipakai persis sama dengan yang dipakai kode
 * produksi.
 *
 * Jalankan: node test/simulate-logged-out-cleanup.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// HARUS sebelum modul src/ mana pun di-require: config dibaca sekali saat load,
// dan singleton store langsung membuka SQLITE_PATH saat modulnya dimuat --
// samakan pola dengan test/simulate-outgoing-idempotency.js dkk supaya skrip
// ini TIDAK PERNAH menyentuh data/gateway.sqlite produksi.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-logged-out-cleanup-'));
process.env.SQLITE_PATH = path.join(tmpRoot, 'gateway.sqlite');
process.env.CI4_BASE_URL = '';
process.env.CI4_GATEWAY_TOKEN = 'token-uji';

const assert = require('assert');
const { ensureBaileysLoaded, getBaileys } = require('../src/whatsapp/baileysLoader');
const connectionManager = require('../src/whatsapp/connectionManager');
const incomingBuffer = require('../src/store/incomingBuffer'); // ikut terbuka lewat connectionManager; ditutup saat cleanup

(async () => {
  // Sama seperti src/app/index.js -- baileys@6.7.24 ESM-only, harus di-load
  // SEKALI di awal sebelum connectionManager.js dipakai (lihat baileysLoader.js).
  await ensureBaileysLoaded();
  const { DisconnectReason } = getBaileys();

  const originalStatus = connectionManager.status;
  const originalSock = connectionManager.sock;
  const originalGeneration = connectionManager.generation;

  try {
    console.log('--- 1. connection.update(close, loggedOut) harus membersihkan this.sock (REQ-001) ---');
    let listenersRemoved = false;
    let sockEnded = false;
    const fakeSock = {
      ev: {
        removeAllListeners: () => {
          listenersRemoved = true;
        },
      },
      end: () => {
        sockEnded = true;
      },
      authState: { creds: { registered: false } },
    };
    connectionManager.status = 'connecting';
    connectionManager.sock = fakeSock;
    connectionManager.generation = originalGeneration; // pastikan myGeneration di bawah cocok

    await connectionManager._onConnectionUpdate(
      {
        connection: 'close',
        lastDisconnect: {
          error: {
            message: 'Connection Failure',
            output: { statusCode: DisconnectReason.loggedOut },
          },
        },
      },
      connectionManager.generation
    );

    assert.strictEqual(connectionManager.status, 'logged_out', 'status harus jadi logged_out');
    assert.strictEqual(connectionManager.sock, null, 'this.sock HARUS di-null-kan setelah logged_out (zombie socket)');
    assert.ok(listenersRemoved, 'listener socket lama harus dilepas sebelum di-null-kan');
    assert.ok(sockEnded, 'socket lama harus di-end() sebelum di-null-kan');
    console.log('OK: this.sock dibersihkan setelah logged_out.');

    console.log('\n--- 2. requestPairingCode() setelah logged_out harus reject (REQ-002) ---');
    let rejected = false;
    let rejectMessage = '';
    try {
      await connectionManager.requestPairingCode('6281900000000');
    } catch (err) {
      rejected = true;
      rejectMessage = err.message;
    }
    assert.ok(rejected, 'requestPairingCode() HARUS reject saat status logged_out, bukan diam-diam sukses/null');
    assert.ok(
      /logout|reset/i.test(rejectMessage),
      `pesan error harus menyebut logout/reset, dapat: "${rejectMessage}"`
    );
    console.log(`OK: requestPairingCode() reject dengan pesan yang jelas: "${rejectMessage}"`);

    console.log('\nSEMUA ASSERT LULUS (0 gagal).');
  } finally {
    connectionManager.status = originalStatus;
    connectionManager.sock = originalSock;
    connectionManager.generation = originalGeneration;
  }
})()
  .catch((err) => {
    console.error('GAGAL:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      incomingBuffer.close();
    } catch (err) {
      // sudah tertutup
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (err) {
      console.warn(`Peringatan: folder temp tidak terhapus (${tmpRoot}): ${err.message}`);
    }
  });
