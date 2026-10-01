'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const logger = require('../logging');
const incomingBuffer = require('../store/incomingBuffer');
const { enqueueWithRetry } = require('../store/enqueueRetry');
const { normalizeMessagesUpsert, normalizeConnectionUpdate } = require('./normalize');
const evolutionState = require('./state');
const quotedStore = require('./quotedStore');
const mediaStore = require('./mediaStore');
const groupInfo = require('./groupInfo');
const { jidToPhone } = require('./jid');
const ownSent = require('./ownSentRegistry').instance;

/**
 * Receiver webhook Evolution API -> buffer durable Gateway (SQLite) ->
 * diteruskan ke CI4 oleh worker src/delivery/incomingDelivery.js yang sudah ada.
 *
 * Dipasang di /evolution, jadi URL yang didaftarkan ke Evolution
 * (POST /webhook/set/{instance}) adalah:
 *   http://<ip-pc-gateway>:<port>/evolution/webhook
 *
 * Validasi opsional: bila EVOLUTION_WEBHOOK_SECRET diisi, Evolution harus
 * mengirim header yang sama (diatur lewat `headers` pada /webhook/set).
 *
 * Selalu balas 200 cepat setelah pesan AMAN di buffer lokal (itu jaminan
 * durabilitas kita). Hanya kalau enqueue sendiri gagal (mis. disk) kita
 * balas 500 supaya Evolution (bila retry) mengirim ulang.
 */
const router = express.Router();
const jsonBody = express.json({ limit: '16mb' }); // media base64 bisa besar (webhook_base64)

/** Nama event Evolution dinormalkan: case-insensitive, tanpa `_`/`.`/`-`. */
function normalizeEventName(raw) {
  return String(raw || '').toLowerCase().replace(/[._-]/g, '');
}

router.get('/webhook', (req, res) => {
  res.json({ ok: true, service: 'evolution-gateway-adapter', message: 'Evolution webhook endpoint aktif.' });
});

router.post('/webhook', jsonBody, async (req, res) => {
  // Validasi secret opsional (Evolution mendukung custom `headers`).
  if (config.evolution.webhookSecret) {
    const headerName = config.evolution.webhookSecretHeader.toLowerCase();
    const provided = req.get(headerName);
    if (provided !== config.evolution.webhookSecret) {
      logger.warn('[EVOLUTION-HOOK] webhook ditolak: secret tidak cocok/absen');
      return res.status(401).json({ success: false, error: 'unauthorized' });
    }
  }

  const payload = req.body || {};
  const eventName = normalizeEventName(payload.event || payload.type);
  logger.info('[EVOLUTION-HOOK] event diterima', {
    event: payload.event || payload.type || null,
    instance: payload.instance || null,
  });

  if (eventName === 'messagesupsert') {
    return handleMessagesUpsert(req, res, payload);
  }

  if (eventName === 'connectionupdate') {
    const { state, phone } = normalizeConnectionUpdate(payload);
    evolutionState.setConnectionState(state, { phone });
    return res.json({ success: true });
  }

  if (eventName === 'messagesupdate' || eventName === 'sendmessage') {
    // Status kirim (delivered/read) -- belum dikonsumsi CI4. Dicatat singkat
    // untuk diagnosis, tidak diproses lebih jauh.
    logger.debug('[EVOLUTION-HOOK] event status diabaikan (belum dipakai CI4)', { event: eventName });
    return res.json({ success: true, skipped: true, reason: 'event status belum dikonsumsi CI4' });
  }

  return res.json({ success: true, skipped: true, reason: `event "${eventName}" belum ditangani` });
});

async function handleMessagesUpsert(req, res, payload) {
  const normalized = normalizeMessagesUpsert(payload);

  if (!normalized.ok) {
    // `skip` = sengaja dilewati (reaction/protocol/stub/metadata) -> debug, bukan
    // warn. WARN hanya untuk payload yang benar-benar tidak bisa dipetakan.
    const logAt = normalized.skip ? logger.debug : logger.warn;
    logAt('[EVOLUTION-IN] payload webhook dilewati', { reason: normalized.reason });
    return res.json({ success: true, skipped: true, reason: normalized.reason });
  }

  const { event } = normalized;
  const evolutionKey = event._evolutionKey;
  const evolutionMessage = event._evolutionMessage;
  const media = event._evolutionMedia;
  delete event._evolutionKey;
  delete event._evolutionMessage;
  delete event._evolutionMedia;

  // Saring pesan yang DIKIRIM adapter sendiri (echo webhook) supaya tidak
  // masuk kembali ke Inbox sebagai pesan ganda.
  if (event.direction === 'outgoing' && ownSent.has(event.messageId)) {
    logger.debug('[EVOLUTION-IN] echo pesan kiriman sendiri diabaikan', { waMessageId: event.messageId });
    return res.json({ success: true, skipped: true, reason: 'echo pesan kiriman sendiri' });
  }

  // --- Grup (Uji 7): isi group_name + petakan pengirim LID -> nomor ------
  // Info grup diambil sekali per grup lalu di-cache; kegagalan NON-FATAL
  // (pesan tetap diteruskan, group_name null / sender tetap LID).
  if (event.jidType === 'group') {
    const info = await groupInfo.resolve(event.chatId);
    if (info.subject) event.group_name = info.subject;

    const mappedPhone = event.sender_jid ? info.phoneByLid[event.sender_jid] : null;
    if (mappedPhone) {
      event.sender_jid = mappedPhone;
      event.sender = { ...event.sender, jid: mappedPhone, phone: jidToPhone(mappedPhone) };
    }
  }

  // --- Media MASUK (Tahap 4) --------------------------------------------
  // image/document/sticker WAJIB membawa referensi file bagi CI4. Adapter
  // menyimpan blob (base64 dari webhook, karena webhook_base64=true) ke
  // penyimpanan lokal dan menyerahkan ref opaque `evolution-media:<id>`.
  if (['image', 'document', 'sticker'].includes(event.messageType)) {
    if (!media || !media.base64) {
      logger.warn('[EVOLUTION-IN] media masuk tanpa base64 -- dilewati (pastikan webhook_base64 aktif)', {
        waMessageId: event.messageId,
        messageType: event.messageType,
      });
      return res.json({ success: true, skipped: true, reason: 'media tanpa base64' });
    }

    let buffer = null;
    try {
      buffer = Buffer.from(media.base64, 'base64');
    } catch (err) {
      buffer = null;
    }
    if (!buffer || buffer.length === 0) {
      logger.warn('[EVOLUTION-IN] base64 media tidak valid -- dilewati', { waMessageId: event.messageId });
      return res.json({ success: true, skipped: true, reason: 'base64 media tidak valid' });
    }

    const ref = mediaStore.save(buffer, {
      mimetype: media.mimetype,
      fileName: media.fileName,
      mediaType: event.messageType,
    });

    event.media = {
      // Ref opaque adapter, BUKAN URL. `media_key_base64` sengaja placeholder
      // (non-kosong, wajib oleh CI4) karena Evolution tidak memberi mediaKey
      // Baileys -- /media/download mengabaikannya.
      direct_path: ref,
      media_key_base64: 'evolution',
      mimetype: media.mimetype || undefined,
      file_name: media.fileName || undefined,
      file_length: buffer.length,
      file_sha256_base64: crypto.createHash('sha256').update(buffer).digest('base64'),
    };
    logger.info('[EVOLUTION-IN] media masuk disimpan lokal', {
      waMessageId: event.messageId,
      messageType: event.messageType,
      bytes: buffer.length,
    });
  } else if (event.messageType === 'audio' || event.messageType === 'video') {
    // CI4 menerima audio/video sebagai placeholder (referensi media opsional).
    if (media && media.mimetype) event.media = { mimetype: media.mimetype };
  }

  // Simpan key+message lengkap untuk membangun `quoted` saat kasir membalas.
  // `base64` dibuang dari salinan yang disimpan supaya tidak membengkakkan
  // SQLite kutipan (balas pesan media tetap memakai key + struktur pesan).
  let storedMessage = evolutionMessage;
  if (storedMessage && typeof storedMessage === 'object' && storedMessage.base64) {
    storedMessage = { ...storedMessage };
    delete storedMessage.base64;
  }
  quotedStore.save(event.messageId, evolutionKey, storedMessage);

  try {
    const result = await enqueueWithRetry(incomingBuffer, event);
    logger.info('[EVOLUTION-IN] pesan masuk tersimpan di buffer durable', {
      waMessageId: event.messageId,
      chatId: event.chatId,
      direction: event.direction,
      status: result.status,
    });
    return res.json({ success: true });
  } catch (err) {
    logger.error('[EVOLUTION-IN] GAGAL menyimpan pesan masuk ke buffer durable', {
      waMessageId: event.messageId,
      error: err.message,
    });
    return res.status(500).json({ success: false, error: 'enqueue_failed' });
  }
}

module.exports = router;
module.exports.normalizeEventName = normalizeEventName;
