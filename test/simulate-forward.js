'use strict';
/**
 * Skrip simulasi Teruskan (Tahap 4, WA-Gateway):
 *   - kontrak outbound `forward` di POST /send DAN POST /send-media (penanda
 *     native lewat `contextInfo`, prefix teks sebagai fallback),
 *   - penolakan kombinasi `forward` + `quoted` dengan 400 (CON-001),
 *   - degradasi `forward` non-boolean (F-C: tetap terkirim + di-log),
 *   - request TANPA `forward` byte-identic dengan sebelumnya (daftar key
 *     respons persis seperti dulu),
 *   - `forward_marker_applied` pada respons, termasuk replay idempotensi, dan
 *     `forward` yang SENGAJA tidak ikut `computePayloadHash` (ALT-002).
 *
 * `sock.sendMessage()` di-stub: TIDAK menghubungi server WhatsApp. Yang
 * diverifikasi di sini adalah isi payload Baileys yang dibentuk Gateway.
 * Bukti bahwa penanda itu benar-benar tampil di WhatsApp (`AC-002`) WAJIB
 * manual dari HP uji -- lihat catatan di akhir file (TASK-005 plan).
 *
 * Jalankan: node test/simulate-forward.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// HARUS sebelum modul src/ mana pun di-require: config dibaca sekali saat load,
// dan singleton store langsung membuka SQLITE_PATH saat modulnya dimuat.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-forward-'));
process.env.SQLITE_PATH = path.join(tmpRoot, 'gateway.sqlite');
process.env.CI4_BASE_URL = '';
process.env.CI4_GATEWAY_TOKEN = 'token-uji';

const assert = require('assert');
const express = require('express');
const logger = require('../src/logging');
const { ensureBaileysLoaded, getBaileys, supportsContentContextInfo } = require('../src/whatsapp/baileysLoader');
const connectionManager = require('../src/whatsapp/connectionManager');
const incomingBuffer = require('../src/store/incomingBuffer');
const outgoingOperations = require('../src/store/outgoingOperations');
const {
  FORWARD_MARKER_NATIVE,
  FORWARD_MARKER_TEXT_FALLBACK,
  FORWARD_TEXT_PREFIX,
  resolveForwardRequest,
  applyForwardMarker,
} = require('../src/whatsapp/forwardMarker');

// Tangkap log (tidak dicetak) supaya degradasi `forward` non-boolean bisa
// dipastikan "berbunyi" (gagal dengan suara, bukan senyap).
const logs = [];
for (const level of ['info', 'warn', 'error', 'debug']) {
  logger[level] = (message, meta = null) => {
    logs.push({ level, message, meta });
  };
}
const warnCount = (needle) => logs.filter((l) => l.level === 'warn' && l.message.includes(needle)).length;

const OWN_JID = '628111000111@s.whatsapp.net'; // JID akun-bot (sock.user.id)
const CHAT = '6281234567890@s.whatsapp.net';
const SENDER = '628999888777@s.whatsapp.net';

const IMG = Buffer.from('ISI-GAMBAR-UJI-FORWARD');
// WebP valid (RIFF....WEBP) supaya boleh lewat validasi stiker di /send-media.
const STICKER = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP'),
  Buffer.from('isi-stiker-uji'),
]);

let sentCalls = [];
const originalStatus = connectionManager.status;
const originalSock = connectionManager.sock;

function installSock() {
  sentCalls = [];
  connectionManager.status = 'connected';
  connectionManager.sock = {
    user: { id: OWN_JID },
    sendMessage: async (jid, content, options) => {
      sentCalls.push({ jid, content, options });
      return { key: { id: `WA-${sentCalls.length}` }, message: content };
    },
  };
}

let server;
let baseUrl;

async function startGateway() {
  const ci4Routes = require('../src/api/ci4Routes');
  const app = express();
  app.use(ci4Routes);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stopGateway() {
  if (server) await new Promise((resolve) => server.close(resolve));
}

async function post(route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token-uji' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const lastCall = () => sentCalls[sentCalls.length - 1];
const section = (title) => console.log(`\n--- ${title} ---`);

const NATIVE_CTX = { forwardingScore: 1, isForwarded: true };

(async () => {
  await ensureBaileysLoaded();
  installSock();
  await startGateway();

  // ============ A. Penanda native pada kedua endpoint ============

  section('A1. /send forward:true -> forward_marker_applied "native" + contextInfo di konten');
  let res = await post('/send', { chat_id: CHAT, text: 'Pesan yang diteruskan', forward: true });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.forward_marker_applied, FORWARD_MARKER_NATIVE, 'native diutamakan (REQ-002)');
  assert.deepStrictEqual(
    Object.keys(res.body).sort(),
    ['forward_marker_applied', 'replayed', 'state', 'success', 'timestamp', 'wa_message_id']
  );
  assert.deepStrictEqual(lastCall().content, {
    text: 'Pesan yang diteruskan',
    contextInfo: NATIVE_CTX,
  }, 'isi pesan TIDAK diubah, hanya contextInfo yang ditambahkan (REQ-002)');
  assert.ok(!lastCall().content.text.startsWith(FORWARD_TEXT_PREFIX), 'prefix teks tidak ikut saat native berhasil');
  assert.strictEqual(lastCall().options.quoted, undefined, 'forward TIDAK pernah memaksa quoted ikut (CON-001)');
  assert.ok(!('contextInfo' in lastCall().options), 'contextInfo menempel di konten, bukan di opsi');
  assert.ok(!('forward' in lastCall().options), 'opsi forward tidak pernah diteruskan ke Baileys');
  console.log('OK: /send memakai penanda native.');

  section('A2. /send-media forward:true -> native, caption TIDAK diberi prefix');
  res = await post('/send-media', {
    chat_id: CHAT,
    media_type: 'image',
    media_base64: IMG.toString('base64'),
    mimetype: 'image/jpeg',
    caption: 'Foto yang diteruskan',
    forward: true,
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.forward_marker_applied, FORWARD_MARKER_NATIVE, 'REQ-001a: aturan identik /send');
  assert.deepStrictEqual(lastCall().content.contextInfo, NATIVE_CTX);
  assert.strictEqual(lastCall().content.caption, 'Foto yang diteruskan', 'caption tetap apa adanya');
  assert.strictEqual(lastCall().options.quoted, undefined);
  console.log('OK: /send-media memakai penanda native.');

  section('A3. /send-media forward:true tanpa caption -> tetap sah, caption tidak diarang');
  res = await post('/send-media', {
    chat_id: CHAT,
    media_type: 'image',
    media_base64: IMG.toString('base64'),
    mimetype: 'image/jpeg',
    forward: true,
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.forward_marker_applied, FORWARD_MARKER_NATIVE);
  assert.strictEqual(lastCall().content.caption, undefined, 'caption kosong tetap kosong (tidak diarang)');
  console.log('OK.');

  section('A4. Stiker forward:true -> contextInfo menempel, tanpa field caption baru');
  res = await post('/send-media', {
    chat_id: CHAT,
    media_type: 'sticker',
    media_base64: STICKER.toString('base64'),
    forward: true,
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.forward_marker_applied, FORWARD_MARKER_NATIVE);
  assert.ok(!('caption' in lastCall().content), 'stiker tidak pernah menerima caption');
  assert.deepStrictEqual(lastCall().content.contextInfo, NATIVE_CTX);
  console.log('OK.');

  // ============ B. Prefix teks sebagai fallback (REQ-002) ============

  section('B0. Probe versi Baileys: 6.7.24 terpasang -> penanda native tersedia');
  assert.strictEqual(
    supportsContentContextInfo(),
    true,
    'versi Baileys terpasang harus dianggap mendukung contextInfo (lihat ambang di baileysLoader)'
  );
  console.log('OK.');

  section('B1. applyForwardMarker(): native tidak tersedia -> prefix disisipkan di "text"');
  {
    const out = applyForwardMarker({
      content: { text: 'Isi asli' },
      requested: true,
      nativeSupported: false,
      textField: 'text',
      text: 'Isi asli',
    });
    assert.strictEqual(out.marker, FORWARD_MARKER_TEXT_FALLBACK);
    assert.strictEqual(out.content.text, `${FORWARD_TEXT_PREFIX}Isi asli`, 'prefix disisipkan di depan teks');
    assert.ok(!('contextInfo' in out.content), 'fallback TIDAK mencampur contextInfo');
    assert.ok(out.reason, 'alasan degradasi dilaporkan (gagal dengan suara)');
  }
  console.log('OK.');

  section('B2. applyForwardMarker(): fallback media menyisipkan prefix di "caption", bukan "text"');
  {
    const out = applyForwardMarker({
      content: { image: IMG },
      requested: true,
      nativeSupported: false,
      textField: 'caption',
      text: 'Caption asli',
    });
    assert.strictEqual(out.marker, FORWARD_MARKER_TEXT_FALLBACK);
    assert.strictEqual(out.content.caption, `${FORWARD_TEXT_PREFIX}Caption asli`);
    assert.ok(!('text' in out.content), 'prefix tidak pernah masuk ke field "text"');
  }
  {
    const out = applyForwardMarker({
      content: { image: IMG },
      requested: true,
      nativeSupported: false,
      textField: 'caption',
      text: '',
    });
    assert.strictEqual(out.content.caption, FORWARD_TEXT_PREFIX, 'caption kosong tetap sah, hanya jadi prefix');
  }
  {
    // Stiker tidak punya caption sama sekali: tidak ada teks fallback yang bisa
    // dipasang, jadi kontennya dibiarkan apa adanya dan alasannya dicatat.
    const out = applyForwardMarker({
      content: { sticker: STICKER },
      requested: true,
      nativeSupported: false,
    });
    assert.strictEqual(out.marker, FORWARD_MARKER_TEXT_FALLBACK);
    assert.deepStrictEqual(out.content, { sticker: STICKER }, 'stiker tidak bisa diberi teks: konten apa adanya');
    assert.ok(out.reason, 'keterbatasan stiker dicatat, bukan disembunyikan');
  }
  console.log('OK.');

  section('B3. applyForwardMarker(): requested=false -> konten TIDAK berubah, tanpa marker');
  {
    const content = { text: 'apa adanya' };
    const out = applyForwardMarker({ content, requested: false, nativeSupported: true, textField: 'text', text: 'apa adanya' });
    assert.strictEqual(out.content, content, 'objek konten yang sama, bukan salinan');
    assert.strictEqual(out.marker, null);
    assert.strictEqual(out.reason, null);
  }
  console.log('OK.');

  // ============ C. resolveForwardRequest() ============

  section('C1. resolveForwardRequest(): hanya boolean true yang berarti diminta');
  assert.deepStrictEqual(resolveForwardRequest(undefined), { requested: false, malformed: false });
  assert.deepStrictEqual(resolveForwardRequest(null), { requested: false, malformed: false });
  assert.deepStrictEqual(resolveForwardRequest(true), { requested: true, malformed: false });
  assert.deepStrictEqual(resolveForwardRequest(false), { requested: false, malformed: false }, 'boolean false = sengaja tidak meminta, bukan malformed');
  assert.deepStrictEqual(resolveForwardRequest('true'), { requested: false, malformed: true });
  assert.deepStrictEqual(resolveForwardRequest(1), { requested: false, malformed: true });
  assert.deepStrictEqual(resolveForwardRequest({}), { requested: false, malformed: true });
  assert.deepStrictEqual(resolveForwardRequest(0), { requested: false, malformed: true });
  console.log('OK.');

  // ============ D. forward + quoted ditolak 400 (CON-001) ============

  section('D1. /send forward + quoted -> 400 FORWARD_WITH_QUOTED, tidak ada yang dikirim');
  {
    const before = sentCalls.length;
    res = await post('/send', {
      chat_id: CHAT,
      text: 'harus ditolak',
      forward: true,
      quoted: { wa_message_id: '3EB0X1', message_type: 'text', fromMe: false, text: 'sumber' },
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error_code, 'FORWARD_WITH_QUOTED');
    assert.strictEqual(sentCalls.length, before, 'tidak menyentuh Baileys');
  }
  console.log('OK.');

  section('D2. /send-media forward + quoted -> 400 dengan kode yang sama');
  {
    const before = sentCalls.length;
    res = await post('/send-media', {
      chat_id: CHAT,
      media_type: 'image',
      media_base64: IMG.toString('base64'),
      mimetype: 'image/jpeg',
      forward: true,
      quoted: { wa_message_id: '3EB0X2', message_type: 'image', fromMe: false },
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error_code, 'FORWARD_WITH_QUOTED');
    assert.strictEqual(sentCalls.length, before);
  }
  console.log('OK.');

  section('D3. Hanya quoted (tanpa forward) tetap jalan seperti sebelumnya');
  {
    // Penolakan kombinasi tidak boleh menjatuhkan jalur Balas Pesan (Tahap 3).
    res = await post('/send', {
      chat_id: CHAT,
      text: 'balasan biasa',
      quoted: { wa_message_id: '3EB0X3', message_type: 'text', fromMe: false, text: 'sumber' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.quote_applied, true);
    assert.ok(!('forward_marker_applied' in res.body));
  }
  console.log('OK.');

  // ============ E. forward non-boolean (F-C) ============

  section('E1. forward non-boolean -> diperlakukan false, pesan tetap terkirim, di-log');
  for (const nilai of ['true', 1, {}, 'false', 0]) {
    const beforeWarn = warnCount('field "forward" bukan boolean');
    const before = sentCalls.length;
    res = await post('/send', { chat_id: CHAT, text: `nilai=${JSON.stringify(nilai)}`, forward: nilai });
    assert.strictEqual(res.status, 200, `forward=${JSON.stringify(nilai)} tetap terkirim`);
    assert.strictEqual(res.body.success, true);
    assert.ok(!('forward_marker_applied' in res.body), 'tanpa penanda yang diminta -> field tidak ada');
    assert.deepStrictEqual(lastCall().content, { text: `nilai=${JSON.stringify(nilai)}` }, 'tanpa contextInfo');
    assert.strictEqual(sentCalls.length, before + 1);
    assert.ok(warnCount('field "forward" bukan boolean') > beforeWarn, 'penyimpangan bentuk di-log');
  }
  res = await post('/send-media', {
    chat_id: CHAT,
    media_type: 'image',
    media_base64: IMG.toString('base64'),
    mimetype: 'image/jpeg',
    forward: 'YA',
  });
  assert.strictEqual(res.status, 200, 'jalur media: forward non-boolean tetap terkirim');
  assert.ok(!('forward_marker_applied' in res.body));
  assert.ok(!('contextInfo' in lastCall().content));
  console.log('OK: degradasi berbunyi, konten utuh.');

  // ============ F. Request tanpa forward: byte-identic (RISK-002) ============

  section('F1. /send tanpa forward -> daftar key respons PERSIS seperti sebelumnya');
  res = await post('/send', { chat_id: CHAT, text: 'tanpa forward' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['replayed', 'state', 'success', 'timestamp', 'wa_message_id']);
  assert.deepStrictEqual(lastCall().content, { text: 'tanpa forward' }, 'tanpa contextInfo di konten');
  assert.deepStrictEqual(lastCall().options, { messageId: lastCall().options.messageId }, 'opsi tidak bertambah');

  res = await post('/send', { chat_id: CHAT, text: 'tanpa forward', operation_id: 'OP-F-PLAIN' });
  assert.deepStrictEqual(
    Object.keys(res.body).sort(),
    ['operation_id', 'replayed', 'state', 'success', 'timestamp', 'wa_message_id']
  );
  assert.strictEqual(outgoingOperations.get('OP-F-PLAIN').forward_marker_applied, null);
  console.log('OK.');

  section('F2. /send-media tanpa forward -> daftar key respons PERSIS seperti sebelumnya');
  res = await post('/send-media', {
    chat_id: CHAT,
    media_type: 'image',
    media_base64: IMG.toString('base64'),
    mimetype: 'image/jpeg',
    operation_id: 'OP-F-MEDIA',
  });
  assert.deepStrictEqual(
    Object.keys(res.body).sort(),
    ['media_ref', 'operation_id', 'replayed', 'state', 'success', 'timestamp', 'wa_message_id']
  );
  assert.ok(!('contextInfo' in lastCall().content), 'tanpa forward -> konten media apa adanya');
  console.log('OK.');

  // ============ G. Idempotensi: marker sama pada replay (REQ-003) ============

  section('G1. Replay /send melaporkan marker yang sama tanpa kirim ulang');
  res = await post('/send', { chat_id: CHAT, text: 'teruskan idempoten', operation_id: 'OP-FW-1', forward: true });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.replayed, false);
  assert.strictEqual(res.body.forward_marker_applied, FORWARD_MARKER_NATIVE);
  assert.strictEqual(outgoingOperations.get('OP-FW-1').forward_marker_applied, FORWARD_MARKER_NATIVE, 'marker tersimpan di baris operasi');
  const afterFirst = sentCalls.length;
  const replay = await post('/send', { chat_id: CHAT, text: 'teruskan idempoten', operation_id: 'OP-FW-1', forward: true });
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.body.replayed, true);
  assert.strictEqual(replay.body.forward_marker_applied, FORWARD_MARKER_NATIVE, 'replay melaporkan marker tersimpan');
  assert.strictEqual(replay.body.wa_message_id, res.body.wa_message_id);
  assert.strictEqual(sentCalls.length, afterFirst, 'replay tidak mengirim ulang');
  console.log('OK.');

  section('G2. Replay /send-media melaporkan marker yang sama tanpa kirim ulang');
  res = await post('/send-media', {
    chat_id: CHAT,
    media_type: 'image',
    media_base64: IMG.toString('base64'),
    mimetype: 'image/jpeg',
    caption: 'lampiran diteruskan',
    operation_id: 'OP-FW-M1',
    forward: true,
  });
  assert.strictEqual(res.body.forward_marker_applied, FORWARD_MARKER_NATIVE);
  const mAfter = sentCalls.length;
  const mReplay = await post('/send-media', {
    chat_id: CHAT,
    media_type: 'image',
    media_base64: IMG.toString('base64'),
    mimetype: 'image/jpeg',
    caption: 'lampiran diteruskan',
    operation_id: 'OP-FW-M1',
    forward: true,
  });
  assert.strictEqual(mReplay.status, 200);
  assert.strictEqual(mReplay.body.replayed, true);
  assert.strictEqual(mReplay.body.forward_marker_applied, FORWARD_MARKER_NATIVE);
  assert.strictEqual(sentCalls.length, mAfter);
  console.log('OK.');

  section('G3. ALT-002: `forward` tidak ikut payload_hash -> retry dengan/ tanpa forward = operasi yang sama');
  {
    // Operation_id sama + payload identik + `forward` berubah TIDAK boleh jadi
    // 409 OPERATION_ID_REUSED; kalau hash ikut memuat `forward`, retry dari
    // AuliaPos yang-versi-berbeda akan meng-abort operasi in_flight milik POS.
    res = await post('/send', { chat_id: CHAT, text: 'hash tidak memuat forward', operation_id: 'OP-FW-HASH' });
    assert.strictEqual(res.status, 200);
    assert.ok(!('forward_marker_applied' in res.body));
    const after = sentCalls.length;
    const again = await post('/send', { chat_id: CHAT, text: 'hash tidak memuat forward', operation_id: 'OP-FW-HASH', forward: true });
    assert.strictEqual(again.status, 200, 'bukan 409 OPERATION_ID_REUSED');
    assert.strictEqual(again.body.replayed, true);
    assert.strictEqual(sentCalls.length, after, 'tidak mengirim ulang');
  }
  console.log('OK: hash request lama tidak berubah karena field `forward` (ALT-002).');

  // ============ H. Verifikasi mekanisme native di sisi Baileys ============

  section('H1. Baileys 6.7.24 benar-benar meneruskan contextInfo ke pesan (tanpa quoted)');
  {
    const { generateWAMessageContent } = getBaileys();
    const marked = applyForwardMarker({
      content: { text: 'cek mekanismenya' },
      requested: true,
      nativeSupported: supportsContentContextInfo(),
      textField: 'text',
      text: 'cek mekanismenya',
    });
    assert.strictEqual(marked.marker, FORWARD_MARKER_NATIVE);
    const built = await generateWAMessageContent(marked.content, { getUrlInfo: async () => null, logger });
    const contextInfo = built.extendedTextMessage.contextInfo;
    assert.strictEqual(contextInfo.isForwarded, true, 'isForwarded harus true (Utils/messages.js)');
    assert.strictEqual(Number(contextInfo.forwardingScore), 1, 'forwardingScore harus >= 1');
    assert.ok(!contextInfo.quotedMessage, 'TIDAK ada pesan yang dikutip -- forward ≠ balas (CON-001)');
    assert.ok(!contextInfo.stanzaId, 'tanpa stanzaId berarti bukan balasan native');

    // Jalur `forward:` bawaan Baileys (ALT-001, DITOLAK) MEMBUTUHKAN pesan asli
    // lengkap -- buktinya di sini, supaya tidak ada yang menghidupkan kembali
    // jalur itu (Gateway tidak boleh memegang isi pesan asli, docs/CHAT.md §18).
    const { generateForwardMessageContent } = getBaileys();
    assert.throws(
      () => generateForwardMessageContent({ key: { id: 'X', fromMe: false } }),
      /no content in message/,
      'jalur forward: Baileys menolak tanpa konten pesan asli'
    );
  }
  console.log('OK: contextInfo.isForwarded terbentuk tanpa `quoted`, dan jalur `forward:` tetap ditolak (ALT-001).');

  console.log('\nSEMUA ASSERT LULUS (0 gagal).');
  console.log('CATATAN: ini simulasi in-process, BUKAN pengiriman nyata ke WhatsApp.');
  console.log('Yang BELUM terbukti dan WAJIB diuji manual (TASK-005 plan):');
  console.log('  - pesan uji benar-benar tampil BERTANDA DITERUSKAN di WhatsApp HP uji (AC-002);');
  console.log('  - nilai forward_marker_applied yang dilaporkan Gateway pada pengiriman nyata;');
  console.log('  - apakah penanda native ikut tampil pada media & stiker (WhatsApp bisa mengabaikan');
  console.log('    contextInfo di stickerMessage) -- prefix teks TIDAK bisa rescuing kasus itu karena');
  console.log('    stiker tidak menerima caption.');
})()
  .catch((err) => {
    console.error('GAGAL:', err);
    console.error('Log terakhir:', logs.slice(-8));
    process.exitCode = 1;
  })
  .finally(async () => {
    connectionManager.status = originalStatus;
    connectionManager.sock = originalSock;
    try {
      await stopGateway();
    } catch (err) {
      // sudah berhenti
    }
    try {
      outgoingOperations.close();
    } catch (err) {
      // sudah tertutup
    }
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
