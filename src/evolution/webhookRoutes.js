'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const logger = require('../logging');
const incomingBuffer = require('../store/incomingBuffer');
const { enqueueWithRetry } = require('../store/enqueueRetry');
const { normalizeMessagesUpsert, normalizeConnectionUpdate, pickMessageRecord, unwrapMessage } = require('./normalize');
const { captureMessageEditFixture } = require('./messageEditFixture');
const { isDecryptEnabled, resolveMessageEditText } = require('./messageEditResolver');
const evolutionState = require('./state');
const quotedStore = require('./quotedStore');
const mediaStore = require('./mediaStore');
const evolutionClient = require('./client');
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
const jsonBody = express.json({ limit: config.webhookJsonBodyLimit }); // lihat config: harus > base64 media masuk maksimum

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

  if (eventName === 'messagesdelete') {
    // TODO-F7: pelanggan menghapus pesan (untuk semua). Evolution hanya
    // mengirim event ini bila instance melanggan MESSAGES_DELETE.
    return handleMessagesDelete(res, payload);
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

  // Edit pelanggan (TODO-F7): BUKAN pesan baru -- enqueue penanda lifecycle.
  // Saat capture fixture TODO-F8 diaktifkan, gunakan pesan original dari
  // quotedStore untuk menyusun fixture offline. Capture ini one-shot dan
  // disabled by default; kegagalan capture TIDAK mengubah lifecycle path.
  if (normalized.lifecycle) {
    try {
      const record = pickMessageRecord(payload.data);
      const messageObj = record ? unwrapMessage(record.message || {}) : null;
      const capture = captureMessageEditFixture({
        record,
        messageObj,
        quotedStore,
        instance: payload.instance || null,
      });
      if (capture.captured) {
        logger.warn('[TODO-F8] fixture MESSAGE_EDIT berhasil dicapture', {
          target: capture.targetId,
          path: capture.path,
        });
      } else if (capture.reason !== 'disabled' && capture.reason !== 'target_mismatch') {
        logger.debug('[TODO-F8] fixture MESSAGE_EDIT tidak dicapture', { reason: capture.reason });
      }

      // TODO-F8: dekripsi produksi sengaja feature-flagged. Bila aktif dan
      // plaintext + protobuf valid, attach teks ke lifecycle event yang sama;
      // bila gagal, TODO-F7 tetap berjalan dengan marker saja.
      if (isDecryptEnabled()) {
        try {
          const decrypted = resolveMessageEditText({
            record,
            messageObj,
            quotedStore,
          });
          if (decrypted && typeof decrypted.text === 'string') {
            normalized.lifecycle.editedText = decrypted.text;
          } else {
            logger.debug('[TODO-F8] MESSAGE_EDIT belum dapat didekripsi/validasi protobuf');
          }
        } catch (err) {
          logger.debug('[TODO-F8] MESSAGE_EDIT decrypt gagal; lifecycle marker tetap dikirim', {
            reason: err.message,
          });
        }
      }
    } catch (err) {
      // Fixture capture is diagnostic-only. Never block TODO-F7 lifecycle.
      logger.warn('[TODO-F8] fixture capture gagal; lifecycle tetap diteruskan', { error: err.message });
    }
    return enqueueLifecycle(res, normalized.lifecycle);
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

  // --- Media MASUK -------------------------------------------------------
  // image/document/sticker WAJIB membawa referensi file bagi CI4: adapter
  // menyimpan blob ke penyimpanan lokal dan menyerahkan ref opaque
  // `evolution-media:<id>`.
  //
  // Dua sumber blob:
  //  - langsung dari `message.base64` (mediaMode 'base64', cara lama), atau
  //  - diunduh dari Evolution (mediaMode 'ondemand', badan webhook tanpa
  //    base64). Mode ondemand mencegah badan webhook ditolak 413 sehingga
  //    berkas besar TETAP terbaca dan bisa diberi baris penanda.
  //
  // Media di atas ambang TIDAK diunduh/disimpan -- dikirim sebagai baris
  // penanda supaya tidak hilang tanpa jejak dan kasir tetap tahu.
  const isMediaMessage = ['image', 'document', 'sticker', 'audio', 'video'].includes(event.messageType);
  const butuhBerkas = ['image', 'document', 'sticker'].includes(event.messageType);
  const batasMb = Math.floor(config.maxIncomingMediaBytes / (1024 * 1024));
  const jadikanPenanda = (teks) => {
    event.messageType = 'unsupported';
    event.media = null;
    event.text = teks;
  };

  const ukuranMetadata = media && Number(media.fileLength) > 0 ? Number(media.fileLength) : null;
  const ukuranDariBase64 = media && media.base64 ? Math.floor((media.base64.length * 3) / 4) : null;
  const ukuranDiketahui = ukuranMetadata || ukuranDariBase64;

  if (isMediaMessage && ukuranDiketahui && ukuranDiketahui > config.maxIncomingMediaBytes) {
    jadikanPenanda(`Customer mengirim file besar diatas ${batasMb}mb — cek WhatsApp Web.`);
    logger.warn('[EVOLUTION-IN] media melebihi batas -- dikirim sebagai penanda, bukan diunduh', {
      waMessageId: event.messageId,
      ukuranDiketahui,
      limitBytes: config.maxIncomingMediaBytes,
    });
  } else if (butuhBerkas) {
    const hasil = await siapkanMediaMasuk({ event, media, evolutionKey, batasMb });
    if (hasil.penanda) {
      jadikanPenanda(hasil.penanda);
    } else if (hasil.skip) {
      logger.warn('[EVOLUTION-IN] media masuk tidak bisa dipakai -- dilewati', {
        waMessageId: event.messageId,
        reason: hasil.skip,
      });
      return res.json({ success: true, skipped: true, reason: hasil.skip });
    } else {
      event.media = hasil.media;
    }
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

/**
 * Siapkan blob media masuk (dari webhook atau diunduh ke Evolution) lalu simpan
 * ke penyimpanan lokal.
 *
 * @returns {Promise<{media?:object, penanda?:string, skip?:string}>}
 *   - `media`   : objek media siap kirim ke CI4
 *   - `penanda` : pesan harus jadi baris penanda teks (mis. berkas terlalu besar)
 *   - `skip`    : pesan dilewati (mis. base64 rusak)
 */
async function siapkanMediaMasuk({ event, media, evolutionKey, batasMb }) {
  let base64 = media && media.base64 ? media.base64 : null;
  let mimetype = media ? media.mimetype : null;
  let fileName = media ? media.fileName : null;

  if (!base64) {
    // mediaMode 'ondemand' (atau webhook_base64 mati): unduh dari Evolution.
    try {
      const unduh = await evolutionClient.getMediaBase64(evolutionKey, {
        maxBytes: config.maxIncomingMediaBytes,
      });
      base64 = unduh.base64;
      mimetype = mimetype || unduh.mimetype;
      fileName = fileName || unduh.fileName;
    } catch (err) {
      if (err.code === 'MEDIA_TOO_LARGE') {
        return { penanda: `Customer mengirim file besar diatas ${batasMb}mb — cek WhatsApp Web.` };
      }
      logger.warn('[EVOLUTION-IN] gagal mengunduh media dari Evolution -- dikirim sebagai penanda', {
        waMessageId: event.messageId,
        code: err.code || null,
        error: err.message,
      });
      return { penanda: 'Customer mengirim berkas — gagal diambil, cek WhatsApp Web.' };
    }
  }

  let buffer = null;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch (err) {
    buffer = null;
  }
  if (!buffer || buffer.length === 0) {
    return { skip: 'base64 media tidak valid' };
  }

  // Pengaman terakhir: metadata bisa tidak akurat, jadi ukuran nyata dicek lagi.
  if (buffer.length > config.maxIncomingMediaBytes) {
    return { penanda: `Customer mengirim file besar diatas ${batasMb}mb — cek WhatsApp Web.` };
  }

  const ref = mediaStore.save(buffer, {
    mimetype,
    fileName,
    mediaType: event.messageType,
  });

  logger.info('[EVOLUTION-IN] media masuk disimpan lokal', {
    waMessageId: event.messageId,
    messageType: event.messageType,
    bytes: buffer.length,
  });

  return {
    media: {
      // Ref opaque adapter, BUKAN URL. `media_key_base64` sengaja placeholder
      // (non-kosong, wajib oleh CI4) karena Evolution tidak memberi mediaKey
      // Baileys -- /media/download mengabaikannya.
      direct_path: ref,
      media_key_base64: 'evolution',
      mimetype: mimetype || undefined,
      file_name: fileName || undefined,
      file_length: buffer.length,
      file_sha256_base64: crypto.createHash('sha256').update(buffer).digest('base64'),
    },
  };
}

/**
 * Enqueue penanda "lifecycle" (diedit / dihapus pelanggan) ke buffer durable,
 * lalu diteruskan `deliverOne()` ke endpoint CI4 `message-event` (TODO-F7).
 *
 * messageId SINTETIS (`lifecycle:<event>:<target>`) -- BUKAN wa_message_id
 * target, supaya tidak bentrok dengan UNIQUE `wa_message_id` baris pesan asli
 * yang mungkin masih ada di buffer. Idempotent: edit/hapus berulang pada pesan
 * yang sama memakai messageId yang sama -> INSERT OR IGNORE (status duplicate).
 */
async function enqueueLifecycle(res, lifecycle) {
  const event = {
    messageId: `lifecycle:${lifecycle.event}:${lifecycle.targetWaMessageId}`,
    chatId: lifecycle.chatId,
    jidType: lifecycle.jidType === 'group' ? 'group' : 'pn',
    sender: lifecycle.sender || { name: null, phone: null, jid: null },
    sender_jid: null,
    messageType: 'lifecycle',
    text: '',
    media: null,
    extra: {
      kind: 'lifecycle',
      event: lifecycle.event,
      target_wa_message_id: lifecycle.targetWaMessageId,
      ...(typeof lifecycle.editedText === 'string'
        ? { edited_text: lifecycle.editedText }
        : {}),
    },
    timestamp: lifecycle.timestamp,
    direction: 'incoming',
    is_forwarded: false,
    quoted: null,
  };

  try {
    const result = await enqueueWithRetry(incomingBuffer, event);
    logger.info('[EVOLUTION-IN] penanda lifecycle tersimpan di buffer durable', {
      event: lifecycle.event,
      target: lifecycle.targetWaMessageId,
      status: result.status,
    });
    return res.json({ success: true });
  } catch (err) {
    logger.error('[EVOLUTION-IN] GAGAL menyimpan penanda lifecycle ke buffer durable', {
      event: lifecycle.event,
      target: lifecycle.targetWaMessageId,
      error: err.message,
    });
    return res.status(500).json({ success: false, error: 'enqueue_failed' });
  }
}

/**
 * Handler webhook `messages.delete` (TODO-F7). Payload: satu objek
 * `{ id, remoteJid, remoteJidAlt, fromMe, status:'DELETED', ... }`;
 * `id` = wa_message_id pesan yang dihapus pelanggan.
 */
function handleMessagesDelete(res, payload) {
  const data = payload.data || {};
  const targetId = typeof data.id === 'string' ? data.id : '';
  if (!targetId) {
    logger.warn('[EVOLUTION-IN] messages.delete tanpa data.id -- dilewati');
    return res.json({ success: true, skipped: true, reason: 'messages.delete tanpa data.id' });
  }

  const chatId = data.remoteJidAlt || data.remoteJid || '';
  if (!chatId) {
    logger.warn('[EVOLUTION-IN] messages.delete tanpa chat id -- dilewati');
    return res.json({ success: true, skipped: true, reason: 'messages.delete tanpa chat id' });
  }

  return enqueueLifecycle(res, {
    event: 'deleted',
    targetWaMessageId: targetId,
    chatId,
    jidType: typeof chatId === 'string' && chatId.includes('@g.us') ? 'group' : 'pn',
    timestamp: new Date().toISOString(),
  });
}

module.exports = router;
module.exports.normalizeEventName = normalizeEventName;
module.exports.handleMessagesDelete = handleMessagesDelete;
module.exports.enqueueLifecycle = enqueueLifecycle;
