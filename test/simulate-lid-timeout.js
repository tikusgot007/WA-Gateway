'use strict';
/**
 * Skrip simulasi M1 Wave 1 TASK-013 (REQ-014, REQ-019, AC-010, AC-018):
 * query LID (`sock.onWhatsApp()`) punya batas waktu 2 detik, kegagalannya
 * di-cache negatif 60 detik per JID, dan keberhasilannya di-cache permanen.
 *
 * Tidak menghubungi WhatsApp: `sock` adalah mock. Waktu TTL 60 detik
 * disimulasikan dengan menyuntik Date.now (tidak menunggu sungguhan); batas
 * waktu 2 detik memakai waktu nyata. Database singleton diarahkan ke folder
 * temp (dihapus setelah tes).
 * Jalankan: node test/simulate-lid-timeout.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// HARUS sebelum modul src/ mana pun di-require: config dibaca sekali saat load.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lid-timeout-'));
process.env.SQLITE_PATH = path.join(tmpDir, 'gateway.sqlite');
process.env.CI4_BASE_URL = '';
process.env.CI4_GATEWAY_TOKEN = '';
delete process.env.LID_LOOKUP_TIMEOUT_MS;
delete process.env.LID_LOOKUP_NEGATIVE_TTL_MS;

const assert = require('assert');
const { execFileSync } = require('child_process');
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
  const config = require('../src/config');
  const connectionManager = require('../src/whatsapp/connectionManager');
  const incomingBuffer = require('../src/store/incomingBuffer');
  const logger = require('../src/logging');

  assert.strictEqual(config.lidLookupTimeoutMs, 2000, 'bawaan timeout 2 detik (REQ-014)');
  assert.strictEqual(config.lidLookupNegativeTtlMs, 60000, 'bawaan cache negatif 60 detik (REQ-019)');

  const PN_X = '628111000601@s.whatsapp.net';
  const PN_Y = '628111000602@s.whatsapp.net';
  const makeMsg = (id, jid) => ({
    key: { id, remoteJid: jid, fromMe: false },
    message: { conversation: 'halo' },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Pelanggan Tes',
  });
  const upsert = (messages) =>
    connectionManager._onMessagesUpsert({ messages, type: 'notify' }, connectionManager.generation);
  const rowFor = (id) => incomingBuffer.db.prepare('SELECT * FROM incoming_queue WHERE wa_message_id = ?').get(id);

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

  // Mock sock: perilaku onWhatsApp per JID bisa diubah; semua panggilan dihitung.
  const behavior = { [PN_X]: 'hang', [PN_Y]: 'ok' };
  const calls = [];
  connectionManager.status = 'connected';
  connectionManager.sock = {
    user: { id: '628111000999:1@s.whatsapp.net' },
    onWhatsApp(jid) {
      calls.push(jid);
      if (behavior[jid] === 'hang') return new Promise(() => {}); // tidak pernah selesai
      return Promise.resolve([{ exists: true, jid, lid: '99999999@lid' }]);
    },
  };

  // Jam palsu untuk TTL (hanya Date.now; setTimeout tetap nyata).
  const realNow = Date.now;
  let offsetMs = 0;
  Date.now = () => realNow() + offsetMs;

  try {
    console.log('--- AC-010: onWhatsApp() tidak pernah selesai -> pesan tersimpan TANPA identity_hint dalam ~2 detik, peringatan tercatat ---');
    let started = realNow();
    let logs = await captureLogs(() => upsert([makeMsg('SIM-LID-X1', PN_X)]));
    let elapsed = realNow() - started;
    assert.ok(elapsed >= 1900, `harus menunggu ~2 detik, terukur ${elapsed}ms`);
    assert.ok(elapsed < 3500, `tidak boleh memakai batas lama 5 detik, terukur ${elapsed}ms`);
    let row = rowFor('SIM-LID-X1');
    assert.ok(row, 'pesan tersimpan walau query LID gagal');
    assert.strictEqual(row.identity_hint_json, null, 'tanpa identity_hint');
    assert.strictEqual(logs.warn.length, 1, 'peringatan tercatat');
    assert.strictEqual(logs.warn[0].meta.phoneJid, PN_X);
    assert.match(logs.warn[0].meta.error, /timeout/);
    assert.strictEqual(calls.length, 1);
    console.log(`OK: tersimpan tanpa identity_hint setelah ${elapsed}ms, peringatan tercatat.`);

    console.log('\n--- AC-018: pesan kedua dari JID yang sama dalam 60 detik -> query dilewati, tanpa menunggu ---');
    started = realNow();
    logs = await captureLogs(() => upsert([makeMsg('SIM-LID-X2', PN_X)]));
    elapsed = realNow() - started;
    assert.ok(elapsed < 500, `tidak boleh menunggu timeout lagi, terukur ${elapsed}ms`);
    assert.strictEqual(calls.length, 1, 'onWhatsApp() TIDAK dipanggil lagi');
    assert.ok(rowFor('SIM-LID-X2'), 'pesan tetap tersimpan');
    assert.strictEqual(rowFor('SIM-LID-X2').identity_hint_json, null);
    assert.strictEqual(logs.warn.length, 0, 'melewati query bukan kegagalan baru');
    console.log(`OK: dilewati dalam ${elapsed}ms, tanpa query baru.`);

    console.log('\n--- Cache negatif per JID: JID lain tetap di-query ---');
    await upsert([makeMsg('SIM-LID-Y1', PN_Y)]);
    assert.strictEqual(calls.length, 2, 'JID Y di-query');
    assert.strictEqual(calls[1], PN_Y);
    assert.match(rowFor('SIM-LID-Y1').identity_hint_json, /99999999@lid/, 'hasil sukses tersimpan sebagai identity_hint');
    console.log('OK: kegagalan X tidak memengaruhi Y.');

    console.log('\n--- Batas TTL: tepat sebelum 60 detik masih dilewati, sesudahnya dicoba lagi ---');
    offsetMs = 59_000;
    await upsert([makeMsg('SIM-LID-X3', PN_X)]);
    assert.strictEqual(calls.length, 2, 'pada 59 detik masih dilewati');
    offsetMs = 61_000;
    behavior[PN_X] = 'ok'; // sekarang query berhasil
    await upsert([makeMsg('SIM-LID-X4', PN_X)]);
    assert.strictEqual(calls.length, 3, 'setelah 60 detik query dicoba lagi');
    assert.match(rowFor('SIM-LID-X4').identity_hint_json, /99999999@lid/, 'kali ini identity_hint didapat');
    console.log('OK: kedaluwarsa tepat setelah 60 detik dan bisa pulih.');

    console.log('\n--- Hasil SUKSES di-cache permanen (bukan 60 detik) ---');
    offsetMs = 24 * 3600_000; // sehari kemudian
    await upsert([makeMsg('SIM-LID-X5', PN_X)]);
    assert.strictEqual(calls.length, 3, 'tidak di-query ulang');
    assert.match(rowFor('SIM-LID-X5').identity_hint_json, /99999999@lid/);
    console.log('OK: hasil sukses tidak kedaluwarsa.');
    offsetMs = 0;

    console.log('\n--- Timer batas waktu selalu dibersihkan (tidak menahan proses) ---');
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    const created = new Set();
    const cleared = new Set();
    global.setTimeout = (fn, ms, ...rest) => {
      const t = realSetTimeout(fn, ms, ...rest);
      if (ms === config.lidLookupTimeoutMs) created.add(t);
      return t;
    };
    global.clearTimeout = (t) => {
      cleared.add(t);
      return realClearTimeout(t);
    };
    try {
      connectionManager._lidResolutionCache.clear();
      connectionManager._lidFailureCache.clear();
      behavior['628111000603@s.whatsapp.net'] = 'ok';
      await connectionManager._resolveLidForPhoneJid('628111000603@s.whatsapp.net'); // sukses cepat
    } finally {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    }
    assert.ok(created.size >= 1, 'timer batas waktu dibuat');
    for (const t of created) assert.ok(cleared.has(t), 'setiap timer batas waktu dibersihkan setelah query selesai');
    console.log('OK: timer dibersihkan pada jalur sukses.');

    console.log('\n--- Belum connected -> tidak ada query, tidak dianggap kegagalan ---');
    connectionManager.status = 'disconnected';
    const before = calls.length;
    const PN_OFFLINE = '628111000604@s.whatsapp.net';
    behavior[PN_OFFLINE] = 'ok';
    logs = await captureLogs(() => connectionManager._resolveLidForPhoneJid(PN_OFFLINE));
    assert.strictEqual(calls.length, before, 'tidak memanggil onWhatsApp()');
    assert.strictEqual(logs.warn.length, 0);
    // Refactor TASK-203 (REQ-002, CR-13): null saat belum connected TIDAK boleh di-cache permanen.
    assert.strictEqual(connectionManager._lidResolutionCache.has(PN_OFFLINE), false, 'null tidak masuk cache permanen');
    assert.strictEqual(connectionManager._lidFailureCache.has(PN_OFFLINE), false, 'bukan kegagalan query, tidak masuk cache negatif');
    connectionManager.status = 'connected';
    assert.strictEqual(await connectionManager._resolveLidForPhoneJid(PN_OFFLINE), '99999999@lid', 'setelah connected hasil LID didapat');
    assert.strictEqual(calls.length, before + 1, 'setelah connected onWhatsApp() dipanggil tepat sekali');
    console.log('OK: tanpa koneksi, tanpa query/peringatan/cache; setelah connected query dijalankan.');

    console.log('\n--- Konfigurasi LID_LOOKUP_TIMEOUT_MS / LID_LOOKUP_NEGATIVE_TTL_MS (GUD-001) ---');
    const repoRoot = path.resolve(__dirname, '..');
    const readConfig = (envOverrides) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          ['-e', "const c = require('./src/config'); console.log(JSON.stringify([c.lidLookupTimeoutMs, c.lidLookupNegativeTtlMs]))"],
          { cwd: repoRoot, env: { ...process.env, LID_LOOKUP_TIMEOUT_MS: '', LID_LOOKUP_NEGATIVE_TTL_MS: '', ...envOverrides }, encoding: 'utf8' }
        )
      );
    assert.deepStrictEqual(readConfig({}), [2000, 60000], 'bawaan');
    assert.deepStrictEqual(readConfig({ LID_LOOKUP_TIMEOUT_MS: '500', LID_LOOKUP_NEGATIVE_TTL_MS: '10000' }), [500, 10000], 'kustom');
    assert.deepStrictEqual(readConfig({ LID_LOOKUP_TIMEOUT_MS: 'x', LID_LOOKUP_NEGATIVE_TTL_MS: 'x' }), [2000, 60000], 'tidak valid -> bawaan');
    assert.strictEqual(readConfig({ LID_LOOKUP_TIMEOUT_MS: '0' })[0], 1, 'timeout 0 dijaga minimal 1');
    assert.strictEqual(readConfig({ LID_LOOKUP_NEGATIVE_TTL_MS: '0' })[1], 0, 'TTL 0 = tanpa cache negatif (sah)');
    console.log('OK: bawaan, kustom, tidak valid, dan batas bawah.');

    console.log('\nSemua assert simulate-lid-timeout lolos.');
  } finally {
    Date.now = realNow;
    connectionManager.sock = null;
    connectionManager.status = 'disconnected';
  }
})()
  .then(cleanup)
  .catch((err) => {
    console.error('SIMULASI GAGAL:', err);
    cleanup();
    process.exit(1);
  });
