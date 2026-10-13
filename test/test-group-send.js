'use strict';
/**
 * Fix kirim ke grup: JID gaya lama (`628563324637-1623478602@g.us`) sebelumnya
 * ditolak `isDecodableJid()` karena tanda `-`, dan titik kirim memakai
 * `jidToPhone()` yang membuang non-digit sehingga Evolution mengarang grup yang
 * tidak ada. Test ini mengunci:
 *
 *  (1) `isDecodableJid()` menerima dua bentuk id grup (modern + lama) dan tetap
 *      menolak input sampah.
 *  (2) `evolutionNumberFor()` mengirim JID grup utuh, nomor polos untuk pribadi.
 *  (3) `POST /send` (router `ci4Routes.js` via Express asli, `evolutionClient`
 *      di-stub) benar-benar meneruskan JID grup utuh sebagai `number`, sementara
 *      chat pribadi tetap nomor polos (tanpa regresi).
 *
 * Jalankan: node test/test-group-send.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-group-'));
process.env.SQLITE_PATH = path.join(tmpRoot, 'gateway.sqlite');
process.env.MEDIA_STORE_DIR = path.join(tmpRoot, 'media');
process.env.CI4_BASE_URL = '';
process.env.CI4_GATEWAY_TOKEN = 'token-uji-grup';
process.env.EVOLUTION_API_KEY = 'apikey-uji';
process.env.EVOLUTION_INSTANCE = 'inst-uji';
process.env.EVOLUTION_BASE_URL = 'http://127.0.0.1:8080';
process.env.EVOLUTION_WEBHOOK_SECRET = '';

const assert = require('assert');
const express = require('express');
const { isDecodableJid, jidToPhone, evolutionNumberFor } = require('../src/evolution/jid');
const evolutionClient = require('../src/evolution/client');
const evolutionState = require('../src/evolution/state');
const ci4Routes = require('../src/evolution/ci4Routes');
const incomingBuffer = require('../src/store/incomingBuffer');

const GROUP_OLD = '628563324637-1623478602@g.us';
const GROUP_MODERN = '120363275037744005@g.us';
const PRIVATE = '628123456789@s.whatsapp.net';

const section = (title) => console.log(`\n--- ${title} ---`);

(async () => {
  // -------------------------------------------------------------------
  // (1) Validasi JID
  // -------------------------------------------------------------------
  section('(1) isDecodableJid -- grup gaya lama diterima');
  assert.strictEqual(isDecodableJid(GROUP_OLD), true, 'grup gaya lama memuat tanda "-" dan harus lolos');
  console.log('OK');

  section('(2) isDecodableJid -- grup modern tetap diterima');
  assert.strictEqual(isDecodableJid(GROUP_MODERN), true, 'grup modern (digit murni) harus tetap lolos');
  console.log('OK');

  section('(3) isDecodableJid -- input sampah tetap ditolak');
  assert.strictEqual(isDecodableJid('bukan-jid'), false, 'tanpa "@" harus ditolak');
  assert.strictEqual(isDecodableJid('abc@g.us'), false, 'user grup non-digit/- harus ditolak');
  assert.strictEqual(isDecodableJid('@g.us'), false, 'user kosong harus ditolak');
  assert.strictEqual(isDecodableJid('628123456789@whatsapp.net'), true, 'chat pribadi valid harus tetap lolos');
  console.log('OK');

  section('(4) evolutionNumberFor -- grup dikirim sebagai JID utuh');
  assert.strictEqual(evolutionNumberFor(GROUP_OLD), GROUP_OLD, 'tanda "-" TIDAK boleh dibuang untuk grup');
  assert.strictEqual(evolutionNumberFor(GROUP_MODERN), GROUP_MODERN, 'JID grup modern dikirim utuh');
  console.log('OK');

  section('(5) evolutionNumberFor -- pribadi tetap nomor polos (tanpa regresi)');
  assert.strictEqual(evolutionNumberFor(PRIVATE), '628123456789', 'chat pribadi harus tetap jadi nomor polos');
  assert.strictEqual(jidToPhone(PRIVATE), '628123456789', 'jidToPhone tidak berubah perilaku');
  console.log('OK');

  // -------------------------------------------------------------------
  // (6-7) Routing /send memakai evolutionNumberFor (via Express nyata)
  // -------------------------------------------------------------------
  let capturedNumber = null;
  evolutionClient.sendText = async (args) => {
    capturedNumber = args.number;
    return {
      messageId: 'EV-GROUP-TEST',
      timestamp: '2026-10-13T08:00:00.000Z',
      quoteApplied: false,
      key: { id: 'EV-GROUP-TEST', remoteJid: String(args.number), fromMe: true },
    };
  };

  const app = express();
  app.use(ci4Routes);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  evolutionState.setConnectionState('open', { phone: '628123456789' });

  const post = async (route, body) => {
    const res = await fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-uji-grup' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (err) { /* non-JSON */ }
    return { status: res.status, body: json };
  };

  section('(6) POST /send -- grup: number = JID utuh');
  let res = await post('/send', { chat_id: GROUP_OLD, text: 'Halo grup' });
  assert.strictEqual(res.status, 200, `/send grup harus 200, dapat ${res.status}: ${JSON.stringify(res.body)}`);
  assert.strictEqual(capturedNumber, GROUP_OLD, `number harus JID grup utuh, dapat: ${capturedNumber}`);
  console.log('OK');

  section('(7) POST /send -- pribadi: number = nomor polos (tanpa regresi)');
  res = await post('/send', { chat_id: PRIVATE, text: 'Halo pribadi' });
  assert.strictEqual(res.status, 200, `/send pribadi harus 200, dapat ${res.status}`);
  assert.strictEqual(capturedNumber, '628123456789', `number harus nomor polos, dapat: ${capturedNumber}`);
  console.log('OK');

  console.log('\nSEMUA LULUS: kirim ke grup memakai JID utuh, chat pribadi tidak berubah.');

  await new Promise((resolve) => server.close(resolve));
  try { incomingBuffer.close(); } catch (err) { /* */ }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { /* */ }
})().catch((err) => {
  console.error('GAGAL:', err);
  process.exitCode = 1;
});