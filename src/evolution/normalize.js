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

function detectMessageType(messageObj) {
  if (!messageObj || typeof messageObj !== 'object') return 'text';
  if (messageObj.imageMessage) return 'image';
  if (messageObj.documentMessage) return 'document';
  if (messageObj.stickerMessage) return 'sticker';
  if (messageObj.audioMessage) return 'audio';
  if (messageObj.videoMessage) return 'video';
  return 'text';
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

  const messageObj = record.message || {};
  const messageType = detectMessageType(messageObj);
  const text = extractText(messageObj);
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
  toIsoTimestamp,
};
