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

    // ---- TASK-010: filter `append` di _onMessagesUpsert ----
    const incomingBuffer = require('../src/store/incomingBuffer');
    const logger = require('../src/logging');

    const PN = '628111000201@s.whatsapp.net';
    const LID = '12345678901234@lid';
    const GROUP = '120363111111111111@g.us';
    const CHANNEL = '120363999999999999@newsletter'; // terklasifikasi 'unknown'

    const makeMsg = ({ id, jid = PN, fromMe = false, text = 'halo' }) => ({
      key: { id, remoteJid: jid, fromMe },
      message: { conversation: text },
      messageTimestamp: Math.floor(Date.now() / 1000),
      pushName: 'Pelanggan Tes',
    });
    const upsert = (type, messages) =>
      connectionManager._onMessagesUpsert({ messages, type }, connectionManager.generation);
    const rowsFor = (id) => incomingBuffer.db.prepare('SELECT * FROM incoming_queue WHERE wa_message_id = ?').all(id);

    /** Tangkap log selama fn() (async) berjalan. */
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

    // Pemrosesan pesan tidak boleh menyentuh jaringan: anggap Gateway tidak connected.
    connectionManager.status = 'disconnected';
    connectionManager.sock = null;

    console.log('\n--- 5. AC-002: `append` kiriman sendiri tiba SEBELUM sendMessage() kembali -> tidak ada baris ---');
    let sentId;
    connectionManager.status = 'connected';
    connectionManager.sock = {
      user: { id: '628111000999:1@s.whatsapp.net' },
      async sendMessage(jid, content, options) {
        sentId = options.messageId;
        // Persis perilaku Baileys: `append` kiriman sendiri dipancarkan SEBELUM sendMessage() kembali.
        await upsert('append', [makeMsg({ id: sentId, jid, fromMe: true, text: content.text })]);
        return { key: { id: sentId }, message: {} };
      },
    };
    await connectionManager.sendTextMessage(PN, 'balasan dari POS');
    assert.ok(sentId, 'sendMessage terpanggil');
    assert.strictEqual(rowsFor(sentId).length, 0, 'kiriman sendiri TIDAK boleh masuk buffer');
    connectionManager.status = 'disconnected';
    connectionManager.sock = null;
    console.log('OK: append yang mendahului sendMessage() tersaring lewat ownSentRegistry.');

    console.log('\n--- 6. AC-003: `append` fromMe (balasan dari HP saat Gateway mati) -> tersimpan sebagai outgoing ---');
    await upsert('append', [makeMsg({ id: 'SIM-APP-HP-1', fromMe: true, text: 'dibalas dari HP' })]);
    let rows = rowsFor('SIM-APP-HP-1');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].direction, 'outgoing');
    assert.strictEqual(rows[0].text, 'dibalas dari HP');
    assert.strictEqual(ownSentRegistry.wasSentByUs('SIM-APP-HP-1'), false, 'bukan kiriman sendiri');
    console.log('OK: tersimpan sebagai outgoing.');

    console.log('\n--- 7. AC-004: pesan sama lewat notify lalu append -> satu baris, tanpa log error ---');
    let logs = await captureLogs(async () => {
      await upsert('notify', [makeMsg({ id: 'SIM-APP-DUP-1' })]);
      await upsert('append', [makeMsg({ id: 'SIM-APP-DUP-1' })]);
    });
    assert.strictEqual(rowsFor('SIM-APP-DUP-1').length, 1, 'idempoten: satu baris');
    assert.strictEqual(logs.error.length, 0, 'tidak boleh ada log error');
    assert.strictEqual(logs.warn.length, 0, 'duplikat bukan peringatan');
    console.log('OK: duplikat notify+append menjadi satu baris tanpa error.');

    console.log('\n--- 8. AC-015: tipe selain notify/append -> tidak ada baris, hanya log debug ---');
    for (const type of ['prepend', 'replace', undefined]) {
      const id = `SIM-APP-TYPE-${type}`;
      logs = await captureLogs(() => upsert(type, [makeMsg({ id })]));
      assert.strictEqual(rowsFor(id).length, 0, `${type}: tidak boleh tersimpan`);
      assert.strictEqual(logs.debug.length, 1, `${type}: satu log debug`);
      assert.strictEqual(logs.info.length + logs.warn.length + logs.error.length, 0, `${type}: hanya debug`);
    }
    console.log('OK: prepend/replace/tanpa tipe diabaikan dengan log debug saja.');

    console.log('\n--- 9. AC-017: append alamat unknown dilewati (log info); pn/lid/group tersimpan; notify unknown tetap diproses ---');
    logs = await captureLogs(() => upsert('append', [makeMsg({ id: 'SIM-APP-CH-1', jid: CHANNEL })]));
    assert.strictEqual(rowsFor('SIM-APP-CH-1').length, 0, 'append unknown dilewati');
    assert.strictEqual(logs.info.length, 1);
    assert.strictEqual(logs.info[0].meta.remoteJid, CHANNEL, 'log info berisi JID');
    assert.strictEqual(logs.info[0].meta.messageId, 'SIM-APP-CH-1', 'log info berisi ID pesan');

    for (const [id, jid, expected] of [
      ['SIM-APP-PN-1', PN, 'pn'],
      ['SIM-APP-LID-1', LID, 'lid'],
      ['SIM-APP-GRP-1', GROUP, 'group'],
    ]) {
      await upsert('append', [makeMsg({ id, jid })]);
      rows = rowsFor(id);
      assert.strictEqual(rows.length, 1, `${expected}: tersimpan`);
      assert.strictEqual(rows[0].jid_type, expected);
    }

    await upsert('notify', [makeMsg({ id: 'SIM-APP-CH-NOTIFY', jid: CHANNEL })]);
    rows = rowsFor('SIM-APP-CH-NOTIFY');
    assert.strictEqual(rows.length, 1, 'notify unknown tetap diproses seperti sebelum perubahan');
    assert.strictEqual(rows[0].jid_type, 'unknown');
    console.log('OK: unknown dilewati hanya untuk append; pn/lid/group tersimpan; notify tidak berubah.');

    console.log('\n--- 10. Batch campuran append: yang tersaring tidak menghalangi yang lain ---');
    ownSentRegistry.register('SIM-APP-MIX-OWN');
    await upsert('append', [
      makeMsg({ id: 'SIM-APP-MIX-OWN', fromMe: true }),
      makeMsg({ id: 'SIM-APP-MIX-CH', jid: CHANNEL }),
      makeMsg({ id: 'SIM-APP-MIX-OK' }),
    ]);
    assert.strictEqual(rowsFor('SIM-APP-MIX-OWN').length, 0);
    assert.strictEqual(rowsFor('SIM-APP-MIX-CH').length, 0);
    assert.strictEqual(rowsFor('SIM-APP-MIX-OK').length, 1, 'pesan sah dalam batch yang sama tetap tersimpan');
    console.log('OK: satu batch, hanya yang sah tersimpan.');

    // Refactor TASK-204 (PRN-004, CR-16): lanjutan AC-003 (#6) sampai ke body POST ke CI4.
    // Kontrak deliverOne tidak punya field identitas staff (CI4 mengisi sent_by_user_id NULL
    // sendiri); satu-satunya identitas akun sendiri yang bisa bocor adalah pushName.
    console.log('\n--- 11. AC-003: body POST ke CI4 untuk baris outgoing #6 -> tanpa identitas staff ---');
    // Stub SEBELUM incomingDelivery di-require: modul itu men-destructure postToCI4 saat load.
    const ci4Client = require('../src/delivery/ci4Client');
    const config = require('../src/config');
    const realPostToCI4 = ci4Client.postToCI4;
    const realCi4 = { ...config.ci4 };
    const posted = [];
    ci4Client.postToCI4 = async (pathSuffix, body) => {
      posted.push({ pathSuffix, body });
      return { ok: true, status: 200, json: { status: 'success' }, error: null };
    };
    config.ci4.baseUrl = 'http://ci4.test.invalid';
    config.ci4.gatewayToken = 'token-uji';
    try {
      await require('../src/delivery/incomingDelivery').tick();
    } finally {
      ci4Client.postToCI4 = realPostToCI4;
      Object.assign(config.ci4, realCi4);
    }
    const bodyFor = (id) => posted.find((p) => p.body.wa_message_id === id)?.body;
    const outgoingBody = bodyFor('SIM-APP-HP-1');
    const incomingBody = bodyFor('SIM-APP-DUP-1');
    assert.ok(outgoingBody && incomingBody, 'baris outgoing (#6) dan incoming (#7) dikirim ke CI4');
    assert.strictEqual(outgoingBody.direction, 'outgoing');
    assert.strictEqual(incomingBody.direction, 'incoming');
    assert.deepStrictEqual(Object.keys(outgoingBody).sort(), Object.keys(incomingBody).sort(), 'key body outgoing sama dengan incoming');
    assert.deepStrictEqual(
      Object.keys(outgoingBody).filter((key) => /staff|user|sent_by|agent|operator/i.test(key)),
      [],
      'tidak ada field identitas staff'
    );
    assert.strictEqual(outgoingBody.contact_name, null, 'pushName akun sendiri (staff) tidak diteruskan');
    assert.strictEqual(incomingBody.contact_name, 'Pelanggan Tes', 'pembanding: incoming membawa nama pelanggan');
    console.log('OK: body outgoing berkontrak sama dengan incoming, tanpa identitas staff.');

    console.log('\nSemua assert simulate-append-handling (pencatatan ID + filter append) lolos.');
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
