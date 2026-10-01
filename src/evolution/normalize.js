'use strict';

const crypto = require('crypto');
const logger = require('../logging');
const { isGroupJid, jidToPhone } = require('./jid');

/**
 * Normalisasi payload webhook Evolution API -> event buffer incoming gateway
 * (bentuk yang dimengerti store/incomingBuffer.enqueue()).
 *
 * BENTUK WEBHOOK EVOLUTION (terverifikasi dari docs resmi
 * `docs.evolutionfoundation.com.br/evolution-api/configuration/webhooks`):
 * body POST berisi `{ event, instance, data, destination, date_time, ... }`.
 * `event` salah satu dari MESSAGES_UPSERT/MESSAGES_UPDATE/CONNECTION_UPDATE/dst
 * (lihat tabel resmi). Bentuk detail `data` untuk MESSAGES_UPSERT TIDAK
 * didokumentasikan field-per-field di docs publik -- Evolution meneruskan
 * struktur ala-Baileys (`key`, `message`, `messageTimestamp`, `pushName`)
 * karena mode WHATSAPP-BAILEYS membungkus library Baileys.
 *
 * *** BELUM DIVERIFIKASI DENGAN PAYLOAD NYATA (lihat plan §7 item 2) ***
 * Normalizer ini ditulis DEFENSIF: menerima beberapa kemungkinan bentuk
 * (`data` langsung sebuah pesan, `data.message`/`data.messages[0]`, key di
 * `data.key` atau `data.messages[0].key`), dan MEMBUANG (bukan crash) event
 * yang tidak bisa dipetakan, dengan log yang jelas untuk debugging Tahap 2.
 * WAJIB direvisi memakai payload MESSAGES_UPSERT nyata sebelum produksi.
 */

function pickMessageRecord(data) {
  if (!data || typeof data !== 'object') return null;
  // Bentuk paling umum Baileys/Evolution: { key, message, messageTimestamp, pushName }
  if (data.key && typeof data.key === 'object') return data;
  // Beberapa versi membungkus di data.messages[] (mirip messages.upsert Baileys mentah)
  if (Array.isArray(data.messages) && data.messages.length > 0) return data.messages[0];
  if (data.message && data.message.key) return data.message;
  return null;
}

function extractText(messageObj) {
  if (!messageObj || typeof messageObj !== 'object') return null;
  if (typeof messageObj.conversation === 'string') return messageObj.conversation;
  if (messageObj.extendedTextMessage && typeof messageObj.extendedTextMessage.text === 'string') {
    return messageObj.extendedTextMessage.text;
  }
  if (messageObj.imageMessage && typeof messageObj.imageMessage.caption === 'string') {
    return messageObj.imageMessage.caption;
  }
  if (messageObj.documentMessage && typeof messageObj.documentMessage.caption === 'string') {
    return messageObj.documentMessage.caption;
  }
  return null;
}

/**
 * Pembungkus (wrapper) Baileys: isi pesan sebenarnya ada di `.message`.
 *
 * Sebelum ini view-once / ephemeral / dokumen-berjudul / pesan-diedit jatuh ke
 * default 'text' dengan isi kosong, lalu ditolak CI4 (400) dan ditandai dead
 * PERMANEN (tanpa retry) -- padahal isinya pesan pelanggan yang sah. Dibuka di
 * sini supaya isinya diklasifikasikan seperti pesan biasa.
 */
const MESSAGE_WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
];

function unwrapMessage(recordMessage) {
  let inner = recordMessage;
  let outerBase64 = inner && typeof inner.base64 === 'string' ? inner.base64 : null;
  for (let i = 0; i < 10; i += 1) {
    if (!inner || typeof inner !== 'object') break;
    const wrapper = MESSAGE_WRAPPERS.find(
      (k) => inner[k] && typeof inner[k] === 'object' && inner[k].message,
    );
    if (!wrapper) break;
    outerBase64 = outerBase64 || (typeof inner.base64 === 'string' ? inner.base64 : null);
    inner = inner[wrapper].message;
  }
  // `base64` (webhook_base64=true) kadang menempel di lapisan LUAR, bukan di node
  // media dalam. Kalau lapisan dalam tidak punya, turunkan supaya extractMedia
  // tetap menemukan blob-nya.
  if (inner && typeof inner === 'object' && !inner.base64 && outerBase64) {
    inner = { ...inner, base64: outerBase64 };
  }
  return inner || {};
}

/**
 * Tipe konten yang DIDUKUNG CI4, atau `null` kalau bukan konten yang dikenal.
 *
 * Mengembalikan `null` (bukan default `'text'`) adalah inti perbaikan: default
 * `'text'` membuat tipe tak dikenal terkirim sebagai teks kosong -> ditolak CI4.
 */
function detectMessageType(messageObj) {
  if (!messageObj || typeof messageObj !== 'object') return null;
  if (messageObj.imageMessage) return 'image';
  if (messageObj.documentMessage) return 'document';
  if (messageObj.stickerMessage) return 'sticker';
  if (messageObj.audioMessage) return 'audio';
  if (messageObj.videoMessage) return 'video';
  if (typeof messageObj.conversation === 'string') return 'text';
  if (messageObj.extendedTextMessage) return 'text';
  return null;
}

/**
 * Node yang BUKAN konten pelanggan (metadata/status sistem) -> dilewati tanpa
 * masuk antrean dan tanpa dead-letter. Sebelumnya ini pun jadi 'text' kosong.
 */
const NOISE_NODES = [
  'reactionMessage',
  'protocolMessage',
  'senderKeyDistributionMessage',
  'pollUpdateMessage',
];

/**
 * Wadah yang ISINYA dikirim Evolution sebagai pesan TERPISAH.
 *
 * `albumMessage` hanya membawa `expectedImageCount`/`expectedVideoCount` -- tidak
 * ada blob di dalamnya. Fotonya tiba sendiri-sendiri sebagai `imageMessage`.
 * Terverifikasi dari DB Evolution + log adapter (2026-10-01): album
 * A5F78764... disertai 4 `imageMessage` pada detik yang sama, dan ketiganya
 * tersimpan sebagai media lokal. Karena itu wadahnya dilewati; kalau tidak, ia
 * menambah baris penanda mubazir (dulu: dead-letter) di samping foto aslinya.
 */
const CONTAINER_ONLY_NODES = ['albumMessage'];

function noiseReason(record, messageObj) {
  if (record && record.messageStubType) return 'stub sistem (messageStubType)';
  if (!messageObj || typeof messageObj !== 'object') return null;
  for (const node of NOISE_NODES) {
    if (messageObj[node]) return node;
  }
  for (const node of CONTAINER_ONLY_NODES) {
    if (messageObj[node]) return node + ' (isinya dikirim sebagai pesan terpisah)';
  }
  const keys = Object.keys(messageObj);
  if (keys.length > 0 && keys.every((k) => k === 'messageContextInfo' || k === 'base64')) {
    return 'messageContextInfo saja (tanpa konten)';
  }
  return null;
}

/**
 * Node berisi konten NYATA yang belum didukung. Dipetakan ke penanda teks
 * berbahasa Indonesia supaya pesan tetap muncul di Inbox (kasir tahu dan bisa
 * membukanya di WhatsApp) -- bukan hilang tanpa jejak.
 */
function unsupportedLabel(messageObj) {
  if (!messageObj || typeof messageObj !== 'object') return '[Pesan tidak dikenal — buka WhatsApp untuk melihat]';
  const count = Number(messageObj.albumMessage && messageObj.albumMessage.expectedImageCount) || null;
  if (messageObj.albumMessage) {
    return count
      ? `[Pelanggan mengirim album ${count} foto — buka WhatsApp untuk melihat]`
      : '[Pelanggan mengirim album foto — buka WhatsApp untuk melihat]';
  }
  if (messageObj.locationMessage || messageObj.liveLocationMessage) {
    return '[Pelanggan mengirim lokasi — buka WhatsApp untuk melihat]';
  }
  if (messageObj.contactMessage || messageObj.contactsArrayMessage) {
    return '[Pelanggan mengirim kontak — buka WhatsApp untuk melihat]';
  }
  if (messageObj.pollCreationMessage || messageObj.pollCreationMessageV2 || messageObj.pollCreationMessageV3) {
    return '[Pelanggan mengirim polling — buka WhatsApp untuk melihat]';
  }
  if (messageObj.eventMessage) return '[Pelanggan mengirim undangan acara — buka WhatsApp untuk melihat]';
  if (messageObj.productMessage) return '[Pelanggan mengirim katalog produk — buka WhatsApp untuk melihat]';
  if (messageObj.ptvMessage) return '[Pelanggan mengirim video singkat — buka WhatsApp untuk melihat]';
  if (
    messageObj.buttonsResponseMessage
    || messageObj.listResponseMessage
    || messageObj.templateButtonReplyMessage
    || messageObj.interactiveResponseMessage
    || messageObj.interactiveMessage
  ) {
    return '[Balasan tombol/daftar dari pelanggan — buka WhatsApp untuk melihat]';
  }
  const node = Object.keys(messageObj).find((k) => k !== 'base64' && k !== 'messageContextInfo');
  return node
    ? `[Pesan bertipe "${node}" belum didukung — buka WhatsApp untuk melihat]`
    : '[Pesan belum didukung — buka WhatsApp untuk melihat]';
}

/**
 * Ekstrak info media dari objek `message` Evolution.
 *
 * `messageType` yang dikenali CI4: image/document/sticker/audio/video.
 * Untuk image/document/sticker, CI4 MEMBUTUHKAN referensi file (direct_path +
 * media_key_base64); karena Evolution tidak memberi directPath/mediaKey
 * Baileys, adapter menyimpan blob-nya lokal (mediaStore) dan mengirim ref
 * opaque. Sumber blob: `message.base64` yang disertakan Evolution ketika
 * `webhook_base64=true` (lihat whatsapp.baileys.service.ts ~1444).
 *
 * audio/video: CI4 hanya butuh metadata ringan (mimetype/ukuran), TIDAK
 * pernah dibuka ulang lewat Inbox -> tanpa ref file.
 *
 * @returns {{ type:string, mimetype:string|null, fileName:string|null, caption:string|null, base64:string|null }|null}
 */
function extractMedia(messageObj) {
  if (!messageObj || typeof messageObj !== 'object') return null;
  const candidates = [
    ['image', messageObj.imageMessage],
    ['document', messageObj.documentMessage],
    ['sticker', messageObj.stickerMessage],
    ['video', messageObj.videoMessage],
    ['audio', messageObj.audioMessage],
  ];
  for (const [type, node] of candidates) {
    if (!node || typeof node !== 'object') continue;
    return {
      type,
      mimetype: typeof node.mimetype === 'string' ? node.mimetype : null,
      fileName: typeof node.fileName === 'string' ? node.fileName : null,
      caption: typeof node.caption === 'string' ? node.caption : null,
      base64: typeof messageObj.base64 === 'string' && messageObj.base64 ? messageObj.base64 : null,
    };
  }
  return null;
}

function extractQuotedContext(messageObj) {
  // contextInfo ada di dalam sub-objek tipe pesan (extendedTextMessage.contextInfo, dst),
  // bukan langsung di messageObj -- dicek beberapa kandidat paling umum.
  const candidates = [
    messageObj && messageObj.extendedTextMessage,
    messageObj && messageObj.imageMessage,
    messageObj && messageObj.documentMessage,
    messageObj && messageObj.stickerMessage,
  ].filter(Boolean);
  for (const c of candidates) {
    if (c.contextInfo && c.contextInfo.stanzaId) return c.contextInfo;
  }
  return null;
}

function toIsoTimestamp(messageTimestamp) {
  const n = Number(messageTimestamp);
  if (Number.isFinite(n) && n > 0) {
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function synthesizeMessageIdFallback(record) {
  const basis = JSON.stringify([record.key || null, record.messageTimestamp || null]);
  return `evolution:${crypto.createHash('sha1').update(basis).digest('hex').slice(0, 32)}`;
}

/**
 * @param {object} payload body webhook Evolution (`{ event, instance, data, ... }`)
 * @returns {{ok: true, event: object} | {ok: false, reason: string}}
 */
function normalizeMessagesUpsert(payload) {
  const record = pickMessageRecord(payload.data);
  if (!record) {
    return { ok: false, reason: 'payload MESSAGES_UPSERT tidak punya bentuk pesan yang dikenali (lihat normalize.js, belum diverifikasi ke payload nyata)' };
  }

  const key = record.key || {};
  const remoteJid = key.remoteJid;
  if (typeof remoteJid !== 'string' || !remoteJid) {
    return { ok: false, reason: 'payload tanpa key.remoteJid yang valid' };
  }

  const fromMe = Boolean(key.fromMe);
  const isGroup = isGroupJid(remoteJid);

  // Grup: butuh identitas pengirim (key.participant). Tanpa itu, pesan grup
  // masuk ditolak CI4 -- lebih baik dibuang di sini dengan log jelas.
  if (isGroup && !fromMe && !key.participant) {
    return { ok: false, reason: 'pesan grup masuk tanpa key.participant -- dibuang (kontrak CI4 mewajibkan sender_jid)' };
  }

  // Buka pembungkus (view-once, ephemeral, dokumen-berjudul, pesan diedit)
  // SEBELUM klasifikasi, supaya isinya dikenali sebagai tipe sebenarnya.
  const messageObj = unwrapMessage(record.message || {});

  // Metadata/sistem (reaction, protocol, stub) bukan konten pelanggan.
  const noise = noiseReason(record, messageObj);
  if (noise) {
    return { ok: false, skip: true, reason: 'pesan sistem/metadata dilewati: ' + noise };
  }

  let messageType = detectMessageType(messageObj);
  let text = extractText(messageObj);

  if (messageType === null) {
    // Konten NYATA yang belum didukung: kirim penanda teks, JANGAN 'text' kosong
    // (yang akan ditolak CI4 400 dan menjadi dead permanen).
    messageType = 'unsupported';
    text = unsupportedLabel(messageObj);
  } else if (messageType === 'text' && (text === null || text === '')) {
    // Jaring pengaman: teks kosong (mis. hanya contextInfo) tidak boleh lolos
    // sebagai message_type='text' -- itu persis kelas bug yang lalu jadi dead.
    messageType = 'unsupported';
    text = '[Pesan tanpa teks — buka WhatsApp untuk melihat]';
  }

  const media = extractMedia(messageObj);
  const quotedContext = extractQuotedContext(messageObj);

  const waMessageId = key.id || synthesizeMessageIdFallback(record);
  const senderJid = isGroup ? (key.participant || null) : (fromMe ? null : remoteJid);
  const senderPhone = jidToPhone(senderJid || remoteJid);

  const event = {
    messageId: waMessageId,
    chatId: remoteJid,
    jidType: isGroup ? 'group' : 'pn',
    sender: {
      name: record.pushName || null,
      phone: senderPhone,
      jid: senderJid,
    },
    sender_jid: senderJid,
    messageType,
    text: text || '',
    media: null, // Tahap 4: diisi oleh caller bila messageType butuh referensi media
    timestamp: toIsoTimestamp(record.messageTimestamp),
    direction: fromMe ? 'outgoing' : 'incoming',
    quoted: quotedContext ? {
      wa_message_id: quotedContext.stanzaId,
      sender_jid: quotedContext.participant || null,
    } : null,
    // Metadata mentah dipertahankan untuk dipakai quotedStore (key+message
    // lengkap Evolution) -- BUKAN dikirim ke CI4, hanya dipakai internal.
    _evolutionKey: key,
    _evolutionMessage: messageObj,
    // Info media (base64 dari webhook + mimetype/nama file) -- diproses
    // oleh caller (webhookRoutes): blob disimpan ke mediaStore, lalu
    // event.media diisi dengan ref opaque sebelum masuk buffer.
    _evolutionMedia: media,
  };

  return { ok: true, event };
}

/**
 * @param {object} payload body webhook CONNECTION_UPDATE
 * @returns {{state: string|null, phone: string|null}}
 */
function normalizeConnectionUpdate(payload) {
  const data = payload.data || {};
  const state = data.state || data.status || null;
  const phone = data.wuid ? jidToPhone(data.wuid) : (data.number || null);
  return { state, phone };
}

module.exports = {
  normalizeMessagesUpsert,
  normalizeConnectionUpdate,
  detectMessageType,
  extractText,
  unwrapMessage,
  unsupportedLabel,
  noiseReason,
  toIsoTimestamp,
};
