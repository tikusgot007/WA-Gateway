'use strict';

const express = require('express');
const connectionManager = require('../whatsapp/connectionManager');
const logger = require('../logging');
const config = require('../config');
const { isDecodableJid } = require('../whatsapp/jidUtils');
const { requireCI4Token } = require('./authMiddleware');
const { VALID_MEDIA_TYPES, decodeBase64Media } = require('../whatsapp/mediaPayload');

/**
 * Router khusus endpoint yang dipanggil CI4 (Phase 3: outgoing text
 * message; +media on-demand download; +kirim media KELUAR dari POS).
 * SENGAJA dipisah dari router /api/* (yang dipakai dashboard test
 * lokal, tanpa auth) -- endpoint di sini WAJIB Bearer token dan
 * dipasang di path ROOT (/send, /send-media, /media/download), bukan
 * /api/*, persis sesuai spec /send.
 *
 * Gateway TIDAK menyimpan conversation/business state apa pun --
 * murni meneruskan perintah kirim/ambil ke Baileys dan melaporkan
 * hasilnya. Termasuk untuk media: Gateway TIDAK pernah menyimpan
 * file media di disk sama sekali. Untuk media MASUK, selalu
 * ambil+dekripsi on-demand dari server WhatsApp berdasarkan referensi
 * yang dikirim CI4, lalu langsung streaming balik tanpa disimpan. Untuk
 * media KELUAR (/send-media), file base64 yang dikirim CI4 hanya
 * dipegang di memory selama proses kirim ke Baileys, lalu dibuang.
 */
const router = express.Router();

// Body-parser JSON default (256kb, cukup untuk /send teks & /media/download
// yang cuma berisi referensi) dan versi khusus /send-media (base64 file jauh
// lebih besar) -- dipasang PER ROUTE, bukan global, supaya endpoint lain
// tetap terlindungi limit kecil seperti semula.
const jsonSmall = express.json({ limit: '256kb' });
const jsonMedia = express.json({ limit: config.mediaJsonBodyLimitBytes });

// --- POST /send --------------------------------------------------------
router.post('/send', jsonSmall, requireCI4Token, async (req, res) => {
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

// --- POST /send-media ----------------------------------------------------
// Kirim media (gambar/dokumen) KELUAR dari POS. Berbeda dari /media/download
// (yang MENGAMBIL referensi media dari WhatsApp), di sini CI4 mengirim
// KONTEN file itu sendiri sebagai base64 (`media_base64`) -- kasir upload
// file baru dari komputernya, jadi tidak ada referensi WhatsApp yang bisa
// dipakai ulang. SENGAJA hanya menerima base64 (bukan URL) supaya Gateway
// tidak perlu mempercayai/mengambil URL sembarangan dari sistem lain -- file
// yang diterima di sini HANYA dipegang di memory selama proses kirim,
// TIDAK PERNAH ditulis ke disk Gateway.
router.post('/send-media', jsonMedia, requireCI4Token, async (req, res) => {
  const {
    chat_id: chatId,
    media_type: mediaType,
    media_base64: mediaBase64,
    mimetype,
    file_name: fileName,
    caption,
  } = req.body || {};

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
  if (caption && caption.length > 1024) {
    return res.status(400).json({
      success: false,
      error_code: 'CAPTION_TOO_LONG',
      message: 'Caption terlalu panjang (maks 1024 karakter).',
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

  if (!connectionManager.isConnected()) {
    logger.warn('[SEND-MEDIA-CI4] ditolak, WhatsApp belum connected', { chatId, mediaType });
    return res.status(409).json({
      success: false,
      error_code: 'NOT_CONNECTED',
      message: 'WhatsApp belum connected.',
    });
  }

  try {
    // sendMediaReply() dipilih (bukan sendMediaMessage() langsung) supaya
    // media yang dikirim dari POS JUGA tercatat di messageStore lokal
    // Gateway, konsisten dengan /send (yang memakai sendReply()).
    const result = await connectionManager.sendMediaReply(chatId, mediaType, decoded.buffer, {
      caption: caption || undefined,
      mimetype: mimetype || undefined,
      fileName: fileName || undefined,
    });

    logger.info('[SEND-MEDIA-CI4] media keluar dari POS berhasil dikirim', {
      chatId,
      mediaType,
      waMessageId: result.messageId,
      mediaRefTersedia: Boolean(result.mediaRef),
    });

    // media_ref (kalau ada) memakai nama field YANG SAMA dengan payload
    // referensi media MASUK (direct_path/media_key_base64) supaya CI4 bisa
    // menyimpan & memakainya lewat alur POST /media/download yang sudah ada,
    // tanpa endpoint/logic baru -- media KELUAR jadi bisa dibuka ulang nanti
    // persis seperti media MASUK. Kalau Baileys tidak mengembalikan
    // referensi lengkap (mediaRef null), field ini cukup diabaikan CI4.
    return res.json({
      success: true,
      wa_message_id: result.messageId,
      timestamp: result.timestamp,
      media_ref: result.mediaRef ? {
        direct_path: result.mediaRef.directPath,
        media_key_base64: result.mediaRef.mediaKeyBase64,
      } : null,
    });
  } catch (err) {
    logger.error('[SEND-MEDIA-CI4] gagal mengirim media dari POS', { chatId, mediaType, error: err.message });

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
router.post('/media/download', jsonSmall, requireCI4Token, async (req, res) => {
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
