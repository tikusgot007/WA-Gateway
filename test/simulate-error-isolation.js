'use strict';
/**
 * Skrip simulasi M1 Wave 1 TASK-014 (REQ-015, AC-013, GUD-002): exception pada
 * SATU pesan tidak boleh menghentikan pesan lain dalam batch yang sama, dan
 * harus tercatat lengkap (ID pesan, JID, tipe konten).
 *
 * Tidak menghubungi WhatsApp; database singleton diarahkan ke folder temp
 * (dihapus setelah tes). Jalankan: node test/simulate-error-isolation.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// HARUS sebelum modul src/ mana pun di-require: config dibaca sekali saat load.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-error-isolation-'));
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
  const incomingBuffer = require('../src/store/incomingBuffer');
  const logger = require('../src/logging');

  const PN = '628111000501@s.whatsapp.net';
  const makeMsg = (id, text = 'halo', jid = PN) => ({
    key: { id, remoteJid: jid, fromMe: false },
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Pelanggan Tes',
  });
  /** Pesan yang MELEMPAR saat konten dibaca (mis. struktur proto tak terduga). */
  const makeThrowingMsg = (id, jid = PN) => ({
    key: { id, remoteJid: jid, fromMe: false },
    message: {
      get conversation() {
        throw new Error('simulasi ekstraksi konten gagal');
      },
    },
    messageTimestamp: Math.floor(Date.now() / 1000),
  });
  const upsert = (type, messages) =>
    connectionManager._onMessagesUpsert({ messages, type }, connectionManager.generation);
  const rowsFor = (id) => incomingBuffer.db.prepare('SELECT * FROM incoming_queue WHERE wa_message_id = ?').all(id);

  async function captureLogs(fn) {
    const captured = { debug: [], info: [], warn: [], error: [] };
    const original = {};
    for (const level of Object.keys(captured)) {
      original[level] = logger[level];
      logger[level] = (message, meta) => captured[level].push({ message, meta });
    }
    try {
      await fn();
    } finally {
      for (const level of Object.keys(captured)) logger[level] = original[level];
    }
    return captured;
  }

  // Pemrosesan pesan tidak boleh menyentuh jaringan.
  connectionManager.status = 'disconnected';
  connectionManager.sock = null;

  for (const type of ['notify', 'append']) {
    console.log(`\n--- AC-013 (${type}): satu pesan melempar di tengah batch -> pesan lain tetap tersimpan, error tercatat lengkap ---`);
    const ids = [`SIM-ISO-${type}-1`, `SIM-ISO-${type}-BAD`, `SIM-ISO-${type}-3`];
    const logs = await captureLogs(() =>
      upsert(type, [makeMsg(ids[0]), makeThrowingMsg(ids[1]), makeMsg(ids[2])])
    );
    assert.strictEqual(rowsFor(ids[0]).length, 1, 'pesan SEBELUM yang gagal tersimpan');
    assert.strictEqual(rowsFor(ids[1]).length, 0, 'pesan yang gagal tidak tersimpan (ALT-004: tanpa pesan minimal)');
    assert.strictEqual(rowsFor(ids[2]).length, 1, 'pesan SESUDAH yang gagal tetap diproses dan tersimpan');
    assert.strictEqual(logs.error.length, 1, 'tepat satu error keras');
    const meta = logs.error[0].meta;
    assert.strictEqual(meta.messageId, ids[1], 'log memuat ID pesan');
    assert.strictEqual(meta.jid, PN, 'log memuat JID');
    assert.strictEqual(meta.contentType, 'conversation', 'log memuat tipe konten');
    assert.strictEqual(meta.upsertType, type);
    assert.match(meta.error, /simulasi ekstraksi konten gagal/, 'log memuat pesan error asli');
    console.log('OK: pesan 1 dan 3 tersimpan, pesan 2 tercatat (ID, JID, tipe konten, error).');
  }

  console.log('\n--- Beberapa pesan gagal dalam satu batch -> semuanya tercatat, sisanya tetap diproses ---');
  let logs = await captureLogs(() =>
    upsert('notify', [
      makeThrowingMsg('SIM-ISO-MULTI-BAD1'),
      makeMsg('SIM-ISO-MULTI-OK'),
      makeThrowingMsg('SIM-ISO-MULTI-BAD2'),
    ])
  );
  assert.strictEqual(logs.error.length, 2);
  assert.deepStrictEqual(logs.error.map((l) => l.meta.messageId), ['SIM-ISO-MULTI-BAD1', 'SIM-ISO-MULTI-BAD2']);
  assert.strictEqual(rowsFor('SIM-ISO-MULTI-OK').length, 1);
  console.log('OK: dua gagal tercatat terpisah, satu sah tersimpan.');

  console.log('\n--- Struktur rusak: key tidak ada, elemen null, dan objek yang error saat kuncinya dibaca ---');
  const explosive = new Proxy(
    {},
    {
      get() {
        throw new Error('simulasi get gagal');
      },
      ownKeys() {
        throw new Error('simulasi ownKeys gagal');
      },
    }
  );
  logs = await captureLogs(() =>
    upsert('notify', [
      null,
      { message: { conversation: 'tanpa key' } },
      { key: { id: 'SIM-ISO-PROXY', remoteJid: PN, fromMe: false }, message: explosive },
      makeMsg('SIM-ISO-AFTER-BROKEN'),
    ])
  );
  assert.strictEqual(logs.error.length, 3, 'ketiga struktur rusak tercatat, tidak ada yang menjatuhkan batch');
  assert.strictEqual(logs.error[0].meta.messageId, null, 'elemen null: ID null, tidak melempar saat mencatat');
  assert.strictEqual(logs.error[0].meta.contentType, null);
  assert.strictEqual(logs.error[2].meta.messageId, 'SIM-ISO-PROXY');
  assert.strictEqual(logs.error[2].meta.contentType, null, 'tipe konten tidak terbaca -> null, bukan melempar');
  assert.strictEqual(rowsFor('SIM-ISO-AFTER-BROKEN').length, 1, 'pesan sah sesudah struktur rusak tetap tersimpan');
  console.log('OK: pencatatan error sendiri tidak pernah melempar; batch berlanjut.');

  console.log('\n--- Pesan protokol tanpa isi (message kosong) -> dilewati diam-diam, BUKAN error ---');
  logs = await captureLogs(() =>
    upsert('notify', [{ key: { id: 'SIM-ISO-STUB', remoteJid: PN, fromMe: false } }, makeMsg('SIM-ISO-AFTER-STUB')])
  );
  assert.strictEqual(logs.error.length, 0, 'stub tanpa isi bukan kegagalan');
  assert.strictEqual(rowsFor('SIM-ISO-STUB').length, 0);
  assert.strictEqual(rowsFor('SIM-ISO-AFTER-STUB').length, 1);
  console.log('OK: stub dilewati tanpa error dan tidak mengganggu pesan berikutnya.');

  console.log('\nSemua assert simulate-error-isolation lolos.');
})()
  .then(cleanup)
  .catch((err) => {
    console.error('SIMULASI GAGAL:', err);
    cleanup();
    process.exit(1);
  });
