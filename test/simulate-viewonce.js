'use strict';
/**
 * Skrip simulasi (BUKAN pengganti test nyata) untuk memvalidasi LOGIKA
 * penanganan pesan masuk "lihat sekali" (view once) -- pola & gaya SAMA
 * dengan simulate-sticker.js / simulate-audio-video.js yang sudah ada.
 *
 * Ini TIDAK menghubungi server WhatsApp sungguhan. Test end-to-end nyata
 * (kirim foto "lihat sekali" sungguhan dari HP) WAJIB dijalankan di
 * Windows dengan koneksi asli sebelum dianggap "selesai" -- lihat
 * plan-bugfix-wa-gateway-viewonce-unsupported-v1.0.md, TASK-012.
 *
 * FIX BEHAVIOR (REQ-001/REQ-002/REQ-003):
 * - view-once MASUK (fromMe=false) -> SATU event teks placeholder (BUKAN mengambil media).
 * - view-once KELUAR (fromMe=true) -> nol event (CON-002).
 * - tipe sungguhan tak didukung (mis. location) -> nol event + log level warn (REQ-003).
 */
const assert = require('assert');
const { ensureBaileysLoaded } = require('../src/whatsapp/baileysLoader');
const connectionManager = require('../src/whatsapp/connectionManager');
const messageStore = require('../src/whatsapp/messageStore');
const logger = require('../src/logging');

// Placeholder FIXED, harus PERSIS sama dengan yang dihasilkan
// connectionManager.js nanti (plan §2).
const PLACEHOLDER = '[Pesan lihat-sekali dari pelanggan — isinya tidak dapat ditampilkan di Inbox]';

// _handleIncomingMessage() async -- HARUS di-await (sama seperti
// simulate-audio-video.js/simulate-sticker.js).
async function simulateIncomingRaw(remoteJid, waMessageId, messageContent, extra = {}) {
  await connectionManager._handleIncomingMessage({
    key: { remoteJid, fromMe: false, id: waMessageId },
    pushName: 'Simulasi Customer',
    message: messageContent,
    messageTimestamp: Math.floor(Date.now() / 1000),
    ...extra,
  });
}

// Tangkap panggilan logger.warn untuk REQ-003. connectionManager memakai
// modul logging yang SAMA (require cache), jadi patch di sini terlihat.
const warnCalls = [];
const _origWarn = logger.warn;
function installWarnCapture() {
  warnCalls.length = 0;
  logger.warn = function capturedWarn(message, meta) {
    warnCalls.push({ message, meta });
    return _origWarn.call(this, message, meta);
  };
}
function restoreWarn() {
  logger.warn = _origWarn;
}

(async () => {

// baileys@6.7.24 ESM-only, harus di-load SEKALI di awal (sama seperti
// src/app/index.js -- lihat baileysLoader.js).
await ensureBaileysLoaded();

// wa_message_id UNIK per-run (higiene test -- incomingBuffer persisten ke
// SQLite di disk, ID literal tetap akan collide di run berikutnya).
const run = Date.now();

console.log('--- 1. View-once MASUK (viewOnceMessageV2 berisi imageMessage, fromMe=false) -> SATU event placeholder ---');
const chat1 = '6281333000001@s.whatsapp.net';
await simulateIncomingRaw(chat1, `SIM-VIEWONCE-1-${run}`, {
  viewOnceMessageV2: {
    message: {
      imageMessage: {
        caption: 'draft asli tidak boleh bocor',
        directPath: '/v/viewonce-x',
        mediaKey: Buffer.from('fake-viewonce-key'),
        mimetype: 'image/jpeg',
        fileLength: '12345',
      },
    },
  },
});
let msgs = messageStore.getByChatId(chat1);
assert.strictEqual(msgs.length, 1, 'View-once masuk HARUS menghasilkan 1 event tersimpan (REQ-001)');
assert.strictEqual(msgs[0].messageType, 'text', 'Placeholder harus message_type="text" (REQ-002/CON-001)');
assert.strictEqual(msgs[0].text, PLACEHOLDER, 'text harus PERSIS string placeholder yang disepakati');
assert.strictEqual(msgs[0].media, null, 'Media view-once TIDAK boleh diambil/disimpan (REQ-002)');
assert.strictEqual(msgs[0].fromMe, false, 'Event tetap bertanda incoming');
console.log('OK: view-once masuk -> 1 event text placeholder, media null, tanpa mengambil isi pesan.');

console.log('\n--- 2. View-once KELUAR (fromMe=true) -> NOL event (CON-002) ---');
const chat2 = '6281333000002@s.whatsapp.net';
await simulateIncomingRaw(chat2, `SIM-VIEWONCE-2-${run}`, {
  viewOnceMessageV2: {
    message: {
      imageMessage: { directPath: '/v/viewonce-y', mediaKey: Buffer.from('k'), mimetype: 'image/jpeg', fileLength: '222' },
    },
  },
}, { key: { remoteJid: chat2, fromMe: true, id: `SIM-VIEWONCE-2-${run}` } });
msgs = messageStore.getByChatId(chat2);
assert.strictEqual(msgs.length, 0, 'View-once keluar (fromMe=true) TIDAK boleh menghasilkan placeholder apa pun (CON-002)');
console.log('OK: view-once keluar tetap di-drop tanpa placeholder (perilaku lama dipertahankan).');

console.log('\n--- 1b. JALUR NYATA: key.isViewOnce=true & message undefined (stanza <unavailable type="view_once">) -> SATU placeholder ---');
// Inilah bentuk yang BENAR-BENAR diterima perangkat tertaut dari WhatsApp:
// tidak ada isi sama sekali, hanya penanda di key (decode-wa-message.js).
const chat1b = '6281333000011@s.whatsapp.net';
await simulateIncomingRaw(chat1b, `SIM-VIEWONCE-UNAVAIL-${run}`, undefined, {
  key: { remoteJid: chat1b, fromMe: false, id: `SIM-VIEWONCE-UNAVAIL-${run}`, isViewOnce: true },
});
msgs = messageStore.getByChatId(chat1b);
assert.strictEqual(msgs.length, 1, 'View-once masuk (key.isViewOnce=true, message undefined) HARUS menghasilkan 1 event (REQ-001)');
assert.strictEqual(msgs[0].messageType, 'text', 'Placeholder harus message_type="text" (REQ-002)');
assert.strictEqual(msgs[0].text, PLACEHOLDER, 'text harus PERSIS string placeholder');
assert.strictEqual(msgs[0].media, null, 'Media TIDAK boleh diambil (REQ-002)');
console.log('OK: view-once masuk tanpa isi -> 1 event text placeholder, media null.');

console.log('\n--- 2b. key.isViewOnce=true & message undefined, fromMe=true -> NOL event (CON-002) ---');
const chat2b = '6281333000012@s.whatsapp.net';
await simulateIncomingRaw(chat2b, `SIM-VIEWONCE-UNAVAIL-OUT-${run}`, undefined, {
  key: { remoteJid: chat2b, fromMe: true, id: `SIM-VIEWONCE-UNAVAIL-OUT-${run}`, isViewOnce: true },
});
msgs = messageStore.getByChatId(chat2b);
assert.strictEqual(msgs.length, 0, 'View-once keluar tanpa isi TIDAK boleh jadi placeholder (CON-002)');
console.log('OK: view-once keluar tanpa isi tetap di-drop.');

console.log('\n--- 2c. message undefined TANPA isViewOnce -> tetap dibuang senyap (bukan view-once) ---');
const chat2c = '6281333000013@s.whatsapp.net';
await simulateIncomingRaw(chat2c, `SIM-EMPTY-NOVO-${run}`, undefined, {
  key: { remoteJid: chat2c, fromMe: false, id: `SIM-EMPTY-NOVO-${run}` },
});
msgs = messageStore.getByChatId(chat2c);
assert.strictEqual(msgs.length, 0, 'Pesan kosong non-view-once tetap dibuang (regresi perilaku lama)');
console.log('OK: pesan kosong non-view-once tetap dibuang.');

console.log('\n--- 3. Tipe sungguhan TAK didukung (locationMessage) -> NOL event + log warn (REQ-003) ---');
installWarnCapture();
const chat3 = '6281333000003@s.whatsapp.net';
try {
  await simulateIncomingRaw(chat3, `SIM-LOC-1-${run}`, {
    locationMessage: { degreesLatitude: -6.2, degreesLongitude: 106.8 },
  });
  msgs = messageStore.getByChatId(chat3);
  assert.strictEqual(msgs.length, 0, 'Location tetap TIDAK didukung: nol event tersimpan');
  const locWarns = warnCalls.filter((w) => w.meta?.messageId === `SIM-LOC-1-${run}`);
  assert.ok(locWarns.length >= 1, 'Penolakan tipe tak didukung HARUS tercatat di level warn (REQ-003), bukan debug');
  console.log('OK: location tetap di-drop, dan sekarang TERTULIS di log level warn (bukan debug yang tersembunyi).');
} finally {
  restoreWarn();
}

console.log('\n--- 4. View-once KOSONG (viewOnceMessageV2:{}) -> TIDAK melempar, jalur tak didukung, warn (TEST-001) ---');
const chat4 = '6281333000004@s.whatsapp.net';
installWarnCapture();
try {
  await simulateIncomingRaw(chat4, `SIM-EMPTY-VO-${run}`, { viewOnceMessageV2: {} });
  msgs = messageStore.getByChatId(chat4);
  assert.strictEqual(msgs.length, 0, 'View-once kosong harus mengambil jalur tak-didukung (nol event)');
  const emptyWarns = warnCalls.filter((w) => w.meta?.messageId === `SIM-EMPTY-VO-${run}`);
  assert.ok(emptyWarns.length >= 1, 'View-once kosong harus tercatat warn (jalur tak didukung, TEST-001)');
  console.log('OK: view-once kosong tidak melempar & tercatat warn.');
} finally {
  restoreWarn();
}

console.log('\n=== SEMUA SIMULASI LOGIKA VIEW-ONCE LULUS ===');
console.log('CATATAN: ini simulasi in-process, BUKAN pengiriman/penerimaan nyata dari WhatsApp.');

})().catch((err) => {
  console.error('\nGAGAL:', err.message);
  console.error('Detail:', err.stack);
  process.exitCode = 1;
});