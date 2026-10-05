'use strict';

const express = require('express');
const config = require('../config');
const logger = require('../logging');
const { requireCI4Token } = require('../api/authMiddleware');
const { isDecodableJid, jidToPhone } = require('./jid');
const evolutionClient = require('./client');
const evolutionState = require('./state');
const quotedStore = require('./quotedStore');
const mediaStore = require('./mediaStore');
const ownSent = require('./ownSentRegistry').instance;
const { isMediaRef } = require('./mediaStore');

// Modul murni (bebas Baileys) yang di-reuse apa adanya dari WA-Gateway.
const { VALID_MEDIA_TYPES, decodeBase64Media, isValidWebp } = require('../whatsapp/mediaPayload');
const { resolveForwardRequest, FORWARD_TEXT_PREFIX } = require('../whatsapp/forwardMarker');
const outgoingOperationService = require('../delivery/outgoingOperationService');

/**
 * Router kontrak CI4 -> adapter, SENGAJA MEMPERTAHANKAN bentuk yang sama persis
 * dengan WA-Gateway/Baileys supaya AuliaPos tidak perlu diubah: path root
 * /send, /send-media, /media/download, Bearer token yang sama, bentuk request
 * & respons yang sama.
 *
 * Bedanya hanya backend: panggilan diteruskan ke REST Evolution API
 * (evolution/client.js). Forward memakai prefix teks (Evolution tidak punya
 * penanda native); balas/quote memakai quotedStore (key+message pesan asal).
 */

function invalidOperationIdResponse(res) {
  return res.status(400).json({
    success: false,
    error_code: 'INVALID_OPERATION_ID',
    message: 'operation_id harus string 1-64 karakter dengan pola [A-Za-z0-9._:-].',
  });
}

function forwardWithQuotedResponse(res) {
  return res.status(400).json({
    success: false,
    error_code: 'FORWARD_WITH_QUOTED',
    message: 'Field "forward" dan "quoted" tidak boleh dikirim bersamaan pada satu request.',
  });
}

function readForwardRequest(req, label) {
  const parsed = resolveForwardRequest((req.body || {}).forward);
  if (parsed.malformed) {
    logger.warn(`[${label}] field "forward" bukan boolean -- diperlakukan false, pesan tetap dikirim`);
  }
  return parsed;
}

/**
 * Ubah objek "byte array" hasil JSON (mis. `{"0":145,"1":197,...}`) menjadi
 * base64 string, secara rekursif.
 *
 * Evolution mengirim field `bytes` protobuf (mediaKey/fileSha256/fileEncSha256,
 * messageSecret, dst.) sebagai objek ber-key numerik di webhook. Kalau objek itu
 * dikirim BALIK apa adanya sebagai `quoted.message`, protobuf salah mendekode
 * dan client WhatsApp di HP gagal merender quote (gejala: quote sticker muncul
 * di WhatsApp Web tapi tidak di HP). protobufjs menerima base64 untuk `bytes`,
 * jadi konversi ini memulihkan render yang benar. Objek non-byte (mis. Long
 * `{low,high,unsigned}`) dibiarkan apa adanya.
 */
function bytesToBase64(value) {
  if (Array.isArray(value)) return value.map(bytesToBase64);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      const n = keys.length;
      let contiguous = true;
      for (let i = 0; i < n; i += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, String(i))) {
          contiguous = false;
          break;
        }
      }
      if (contiguous) {
        return Buffer.from(Array.from({ length: n }, (_, i) => value[i])).toString('base64');
      }
    }
    const out = {};
    for (const k of keys) out[k] = bytesToBase64(value[k]);
    return out;
  }
  return value;
}

/**
 * Key pesan yang bersih untuk `quoted.key`: hanya field standar. Key mentah
 * dari webhook membawa `remoteJidAlt`/`addressingMode`/`participant: ""` yang
 * tidak dikenal klien; `participant` hanya dipertahukan bila benar-benar ada
 * (dipakai untuk quote pesan grup).
 */
function sanitizeQuotedKey(key) {
  if (!key || typeof key !== 'object') return null;
  const out = { id: key.id, remoteJid: key.remoteJid, fromMe: Boolean(key.fromMe) };
  if (key.participant) out.participant = key.participant;
  return out;
}

/**
 * Bentuk `quoted` Evolution dari objek `quoted` milik CI4.
 * CI4 mengirim `{ wa_message_id, sender_jid, message_type, fromMe, text|media_type }`
 * (lihat Inbox::quotedPayloadGateway). Evolution butuh
 * `{ key: { id, remoteJid, fromMe }, message: {...} }`; key+message disimpan
 * saat pesan masuk. Bila tidak ditemukan (mis. sudah lewat TTL, atau pesan
 * lama) -> null (balasan didegradasi jadi pesan biasa, quote_applied=false).
 */
function resolveQuoted(rawQuoted) {
  if (!rawQuoted || typeof rawQuoted !== 'object') return null;
  const waMessageId = rawQuoted.wa_message_id;
  if (typeof waMessageId !== 'string' || !waMessageId) return null;
  const stored = quotedStore.get(waMessageId);
  if (!stored || !stored.key || !stored.key.id) return null;
  return {
    key: sanitizeQuotedKey(stored.key),
    message: bytesToBase64(stored.message || {}),
  };
}

/**
 * Simpan `{key, message}` pesan KELUAR yang baru terkirim supaya balasan
 * berikutnya ke pesan itu (kasir membalas pesannya sendiri) tetap bisa
 * berkutip. Tanpa ini `resolveQuoted()` tidak menemukan pesan keluar dan
 * kutipan didegradasi (`quote_applied:false`), padahal pesan MASUK selalu
 * disimpan lewat webhookRoutes.
 *
 * `base64` dibuang dari salinan yang disimpan (sama seperti pesan masuk)
 * supaya tabel kutipan tidak membengkak oleh blob media.
 */
function storeOutgoingForQuote(result) {
  if (!result || !result.messageId || !result.key) return;
  let message = result.message;
  if (message && typeof message === 'object' && message.base64) {
    message = { ...message };
    delete message.base64;
  }
  quotedStore.save(result.messageId, result.key, message || {});
}

const router = express.Router();
const jsonSmall = express.json({ limit: '256kb' });
const jsonMedia = express.json({ limit: config.mediaJsonBodyLimitBytes });

const isReady = () => evolutionState.isReady();

// --- POST /send --------------------------------------------------------
router.post('/send', jsonSmall, requireCI4Token, async (req, res) => {
  const { chat_id: chatId, text } = req.body || {};

  const rawQuoted = (req.body || {}).quoted;
  const quoteRequested = rawQuoted !== undefined && rawQuoted !== null;

  const forward = readForwardRequest(req, 'SEND-EVOLUTION');
  if (forward.requested && quoteRequested) return forwardWithQuotedResponse(res);

  const operation = outgoingOperationService.validateOperationId((req.body || {}).operation_id);
  if (!operation.ok) return invalidOperationIdResponse(res);
  const { operationId } = operation;

  if (typeof chatId !== 'string' || !isDecodableJid(chatId)) {
    return res.status(400).json({
      success: false,
      error_code: 'INVALID_CHAT_ID',
      message: `chat_id tidak valid/tidak dapat didecode sebagai JID: ${chatId}`,
    });
  }

  if (typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({
      success: false,
      error_code: 'INVALID_TEXT',
      message: 'Field "text" wajib diisi (string).',
    });
  }

  if (text.length > 4096) {
    return res.status(400).json({
      success: false,
      error_code: 'TEXT_TOO_LONG',
      message: 'Teks pesan terlalu panjang (maks 4096 karakter).',
    });
  }

  const quoted = quoteRequested ? resolveQuoted(rawQuoted) : null;
  const outgoingText = forward.requested ? `${FORWARD_TEXT_PREFIX}${text}` : text;

  const doSend = async () => {
    const result = await evolutionClient.sendText({
      number: jidToPhone(chatId),
      text: outgoingText,
      quoted,
    });
    if (result.messageId) ownSent.record(result.messageId);
    storeOutgoingForQuote(result);
    return { ...result, forwardMarkerApplied: forward.requested ? 'text_fallback' : null };
  };

  if (operationId) {
    const decision = await outgoingOperationService.runOperation({
      operationId,
      payloadHash: outgoingOperationService.computePayloadHash({ kind: 'text', chatId, text }),
      kind: 'text',
      chatId,
      isReady,
      send: doSend,
    });
    const { status, body } = outgoingOperationService.toHttpResponse(decision, {
      operationId,
      withQuoteApplied: quoteRequested,
      withForwardMarker: forward.requested,
    });
    return res.status(status).json(body);
  }

  outgoingOperationService.warnWithoutOperationIdOnce();

  if (!isReady()) {
    return res.status(409).json({
      success: false,
      error_code: 'NOT_CONNECTED',
      message: 'WhatsApp belum connected.',
    });
  }

  try {
    const result = await doSend();
    logger.info('[SEND-EVOLUTION] pesan keluar dari POS berhasil dikirim', {
      chatId,
      waMessageId: result.messageId,
      quoteApplied: Boolean(result.quoteApplied),
      forwardMarkerApplied: forward.requested ? 'text_fallback' : null,
    });

    return res.json({
      success: true,
      state: 'sent',
      replayed: false,
      wa_message_id: result.messageId,
      timestamp: result.timestamp,
      ...(quoteRequested ? { quote_applied: Boolean(result.quoteApplied) } : {}),
      ...(forward.requested ? { forward_marker_applied: 'text_fallback' } : {}),
    });
  } catch (err) {
    logger.error('[SEND-EVOLUTION] gagal mengirim pesan dari POS', { chatId, error: err.message });
    return res.status(500).json({
      success: false,
      error_code: err.code || 'SEND_FAILED',
      message: err.message,
    });
  }
});

// --- POST /send-media ----------------------------------------------------
router.post('/send-media', jsonMedia, requireCI4Token, async (req, res) => {
  const {
    chat_id: chatId,
    media_type: mediaType,
    media_base64: mediaBase64,
    mimetype,
    file_name: fileName,
    caption,
  } = req.body || {};

  const rawQuoted = (req.body || {}).quoted;
  const quoteRequested = rawQuoted !== undefined && rawQuoted !== null;

  const operation = outgoingOperationService.validateOperationId((req.body || {}).operation_id);
  if (!operation.ok) return invalidOperationIdResponse(res);
  const { operationId } = operation;

  if (typeof chatId !== 'string' || !isDecodableJid(chatId)) {
    return res.status(400).json({
      success: false,
      error_code: 'INVALID_CHAT_ID',
      message: `chat_id tidak valid/tidak dapat didecode sebagai JID: ${chatId}`,
    });
  }

  if (!VALID_MEDIA_TYPES.includes(mediaType)) {
    return res.status(400).json({
      success: false,
      error_code: 'INVALID_MEDIA_TYPE',
      message: `media_type harus salah satu dari: ${VALID_MEDIA_TYPES.join(', ')}, diterima: ${mediaType}`,
    });
  }

  if (mediaType === 'document' && (typeof fileName !== 'string' || fileName.trim().length === 0)) {
    return res.status(400).json({
      success: false,
      error_code: 'MISSING_FILE_NAME',
      message: 'file_name wajib diisi untuk media_type "document".',
    });
  }

  if (typeof caption !== 'undefined' && typeof caption !== 'string') {
    return res.status(400).json({
      success: false,
      error_code: 'INVALID_CAPTION',
      message: 'caption harus berupa string jika diisi.',
    });
  }

  const decoded = decodeBase64Media(mediaBase64);
  if (!decoded.ok) {
    return res.status(400).json({
      success: false,
      error_code: 'INVALID_MEDIA_BASE64',
      message: decoded.reason,
    });
  }

  if (mediaType === 'sticker' && !isValidWebp(decoded.buffer)) {
    return res.status(400).json({
      success: false,
      error_code: 'INVALID_STICKER_FORMAT',
      message: 'File sticker harus berupa WebP valid (adapter tidak melakukan konversi otomatis).',
    });
  }

  const forward = readForwardRequest(req, 'SEND-MEDIA-EVOLUTION');
  const quoted = quoteRequested ? resolveQuoted(rawQuoted) : null;
  const outgoingCaption = forward.requested && caption ? `${FORWARD_TEXT_PREFIX}${caption}` : caption;

  const doSend = async () => {
    const number = jidToPhone(chatId);
    let result;
    if (mediaType === 'sticker') {
      // Evolution punya endpoint sticker tersendiri; sticker tidak punya caption.
      result = await evolutionClient.sendSticker({ number, buffer: decoded.buffer, quoted });
    } else {
      result = await evolutionClient.sendMedia({
        number,
        mediatype: mediaType, // 'image' | 'document' (enum Evolution termasuk image|video|audio|document)
        buffer: decoded.buffer,
        fileName: fileName || undefined,
        mimetype: mimetype || undefined,
        caption: outgoingCaption || undefined,
        quoted,
      });
    }
    if (result.messageId) ownSent.record(result.messageId);
    storeOutgoingForQuote(result);

    // Evolution TIDAK memberi referensi Baileys (directPath/mediaKey) untuk
    // pesan terkirim, sehingga CI4 tidak punya cara memuat ulang media keluar
    // dan Inbox menampilkannya sebagai "Gambar tidak tersedia". Adapter sudah
    // memegang byte-nya di sini, jadi simpan ke mediaStore dan kembalikan ref
    // opaque yang SAMA seperti media MASUK; CI4 menyimpan ref ini di
    // media_metadata dan memuat ulang lewat POST /media/download.
    //
    // ponytail: blob media keluar ikut retensi MEDIA_RETENTION_DAYS yang sama
    // dengan media masuk -- setelah retensi lewat, gambar lama tidak bisa
    // dimuat ulang lagi; upgrade path: retensi lebih panjang / storage eksternal.
    let mediaRef = null;
    try {
      const ref = mediaStore.save(decoded.buffer, {
        mimetype: mimetype || null,
        fileName: fileName || null,
        mediaType,
      });
      mediaRef = { direct_path: ref, media_key_base64: 'evolution' };
    } catch (err) {
      // Gagal menyimpan ref TIDAK BOLEH menggagalkan kirim (media sudah/akan
      // terkirim ke pelanggan); dampaknya hanya POS tidak bisa menampilkan
      // ulang gambarnya.
      logger.error('[SEND-MEDIA-EVOLUTION] gagal menyimpan ref media keluar', {
        chatId,
        mediaType,
        error: err.message,
      });
    }

    return { ...result, mediaRef, forwardMarkerApplied: forward.requested ? 'text_fallback' : null };
  };

  if (operationId) {
    const mediaMeta = outgoingOperationService.buildMediaMeta({
      mediaType, buffer: decoded.buffer, mimetype, fileName, caption,
    });
    const decision = await outgoingOperationService.runOperation({
      operationId,
      payloadHash: outgoingOperationService.computePayloadHash({ kind: 'media', chatId, mediaMeta }),
      kind: 'media',
      chatId,
      isReady,
      send: doSend,
    });
    const { status, body } = outgoingOperationService.toHttpResponse(decision, {
      operationId,
      withMediaRef: true,
      withQuoteApplied: quoteRequested,
      withForwardMarker: forward.requested,
    });
    return res.status(status).json(body);
  }

  outgoingOperationService.warnWithoutOperationIdOnce();

  if (!isReady()) {
    return res.status(409).json({
      success: false,
      error_code: 'NOT_CONNECTED',
      message: 'WhatsApp belum connected.',
    });
  }

  try {
    const result = await doSend();
    return res.json({
      success: true,
      state: 'sent',
      replayed: false,
      wa_message_id: result.messageId,
      timestamp: result.timestamp,
      media_ref: result.mediaRef,
      ...(forward.requested ? { forward_marker_applied: 'text_fallback' } : {}),
    });
  } catch (err) {
    logger.error('[SEND-MEDIA-EVOLUTION] gagal mengirim media dari POS', { chatId, mediaType, error: err.message });
    return res.status(500).json({
      success: false,
      error_code: err.code || 'SEND_FAILED',
      message: err.message,
    });
  }
});

// --- POST /media/download -----------------------------------------------
// Adapter menyimpan media MASUK secara lokal dan menyerahkan ref opaque
// `evolution-media:<id>` sebagai `direct_path`. Endpoint ini menyajikan blob
// dari disk; referensi lain (mis. directPath Baileys lama) tidak didukung.
router.post('/media/download', jsonSmall, requireCI4Token, async (req, res) => {
  const { media_type: mediaType, direct_path: directPath, mimetype } = req.body || {};

  if (!VALID_MEDIA_TYPES.includes(mediaType)) {
    return res.status(400).json({
      success: false,
      error_code: 'INVALID_MEDIA_TYPE',
      message: `media_type harus salah satu dari: ${VALID_MEDIA_TYPES.join(', ')}, diterima: ${mediaType}`,
    });
  }

  if (typeof directPath !== 'string' || !directPath) {
    return res.status(400).json({
      success: false,
      error_code: 'INVALID_MEDIA_REF',
      message: 'direct_path (ref media adapter) wajib diisi.',
    });
  }

  if (!isMediaRef(directPath)) {
    return res.status(501).json({
      success: false,
      error_code: 'MEDIA_REF_NOT_SUPPORTED',
      message: 'Adapter Evolution hanya mengenal referensi media dengan prefiks "evolution-media:".',
    });
  }

  const media = mediaStore.read(directPath);
  if (!media) {
    return res.status(410).json({
      success: false,
      error_code: 'MEDIA_UNAVAILABLE',
      message: 'Media sudah tidak tersedia di penyimpanan adapter (mungkin lewat masa retensi).',
    });
  }

  logger.info('[MEDIA-EVOLUTION] menyajikan media lokal', { mediaType, ukuranByte: media.buffer.length });
  res.setHeader('Content-Type', mimetype || media.mimetype || 'application/octet-stream');
  res.setHeader('Content-Length', media.buffer.length);
  return res.send(media.buffer);
});

module.exports = router;
