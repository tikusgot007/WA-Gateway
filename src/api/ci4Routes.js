'use strict';

const express = require('express');
const connectionManager = require('../whatsapp/connectionManager');
const logger = require('../logging');
const { isDecodableJid } = require('../whatsapp/jidUtils');
const { requireCI4Token } = require('./authMiddleware');

/**
 * Router khusus endpoint yang dipanggil CI4 (Phase 3: outgoing text
 * message; belakangan +media on-demand download). SENGAJA dipisah
 * dari router /api/* (yang dipakai dashboard test lokal, tanpa auth)
 * -- endpoint di sini WAJIB Bearer token dan dipasang di path ROOT
 * (/send, /media/download), bukan /api/*, persis sesuai spec /send.
 *
 * Gateway TIDAK menyimpan conversation/business state apa pun --
 * murni meneruskan perintah kirim/ambil ke Baileys dan melaporkan
 * hasilnya. Termasuk untuk media: Gateway TIDAK pernah menyimpan
 * file media di disk sama sekali -- selalu ambil+dekripsi on-demand
 * dari server WhatsApp berdasarkan referensi yang dikirim CI4 (yang
 * menyimpan referensi itu di aulia_inboxdb), lalu langsung streaming
 * balik tanpa disimpan.
 */
const router = express.Router();

// --- POST /send --------------------------------------------------------
router.post('/send', requireCI4Token, async (req, res) => {
  const { chat_id: chatId, text } = req.body || {};

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

  if (!connectionManager.isConnected()) {
    logger.warn('[SEND-CI4] ditolak, WhatsApp belum connected', { chatId });
    return res.status(409).json({
      success: false,
      error_code: 'NOT_CONNECTED',
      message: 'WhatsApp belum connected.',
    });
  }

  try {
    // sendReply() dipilih (bukan sendTextMessage() langsung) supaya
    // pesan yang dikirim dari POS JUGA tercatat di messageStore lokal
    // Gateway -- dashboard test Gateway tetap konsisten menampilkan
    // semua pesan keluar, dari mana pun asalnya.
    const result = await connectionManager.sendReply(chatId, text);

    logger.info('[SEND-CI4] pesan keluar dari POS berhasil dikirim', {
      chatId,
      waMessageId: result.messageId,
    });

    return res.json({
      success: true,
      wa_message_id: result.messageId,
      timestamp: result.timestamp,
    });
  } catch (err) {
    logger.error('[SEND-CI4] gagal mengirim pesan dari POS', { chatId, error: err.message });

    return res.status(500).json({
      success: false,
      error_code: err.code || 'SEND_FAILED',
      message: err.message,
    });
  }
});

// --- POST /media/download -----------------------------------------------
// CI4 mengirim REFERENSI media (directPath + mediaKey, yang tersimpan
// di aulia_inboxdb) di body, Gateway ambil+dekripsi dari server
// WhatsApp saat itu juga, dan STREAMING balik file-nya langsung --
// tidak pernah disimpan di disk Gateway sama sekali.
router.post('/media/download', requireCI4Token, async (req, res) => {
  const { media_type: mediaType, direct_path: directPath, media_key_base64: mediaKeyBase64, mimetype } = req.body || {};

  if (!['image', 'document'].includes(mediaType)) {
    return res.status(400).json({
      success: false,
      error_code: 'INVALID_MEDIA_TYPE',
      message: `media_type harus 'image' atau 'document', diterima: ${mediaType}`,
    });
  }

  if (typeof directPath !== 'string' || !directPath || typeof mediaKeyBase64 !== 'string' || !mediaKeyBase64) {
    return res.status(400).json({
      success: false,
      error_code: 'INVALID_MEDIA_REF',
      message: 'direct_path dan media_key_base64 wajib diisi.',
    });
  }

  try {
    const buffer = await connectionManager.downloadMediaByRef({
      mediaType,
      directPath,
      mediaKeyBase64,
    });

    logger.info('[MEDIA] berhasil mengambil & mendekripsi media on-demand', {
      mediaType,
      ukuranByte: buffer.length,
    });

    res.setHeader('Content-Type', mimetype || 'application/octet-stream');
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (err) {
    // Penyebab paling umum: media sudah kadaluarsa di server WhatsApp
    // (pesan cukup lama) -- ini KEMUNGKINAN BESAR terjadi cepat atau
    // lambat, sesuai keputusan desain "simpan referensi saja, bukan
    // file permanen". Bukan bug, tapi keterbatasan yang disadari sejak
    // awal.
    logger.warn('[MEDIA] gagal mengambil/mendekripsi media (kemungkinan sudah kadaluarsa di server WhatsApp)', {
      mediaType,
      error: err.message,
    });

    return res.status(410).json({
      success: false,
      error_code: 'MEDIA_UNAVAILABLE',
      message: 'Media sudah tidak tersedia di server WhatsApp (kemungkinan kadaluarsa karena pesan cukup lama).',
    });
  }
});

module.exports = router;
