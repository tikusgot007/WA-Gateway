'use strict';

const express = require('express');
const connectionManager = require('../whatsapp/connectionManager');
const messageStore = require('../whatsapp/messageStore');
const logger = require('../logging');
const config = require('../config');
const { normalizeToJid } = require('../whatsapp/normalize');
const { isDecodableJid } = require('../whatsapp/jidUtils');
const { VALID_MEDIA_TYPES, decodeBase64Media, fetchMediaFromUrl, isValidWebp } = require('../whatsapp/mediaPayload');

const router = express.Router();

// Body-parser JSON default (256kb, cukup untuk teks) dan versi khusus untuk
// endpoint kirim media (base64 file jauh lebih besar dari teks biasa) --
// dipasang PER ROUTE di bawah, bukan global, supaya endpoint lain tetap
// terlindungi limit kecil seperti semula.
const jsonSmall = express.json({ limit: '256kb' });
const jsonMedia = express.json({ limit: config.mediaJsonBodyLimitBytes });

// --- GET /api/status ---------------------------------------------------
router.get('/status', (req, res) => {
  res.json({
    ok: true,
    data: connectionManager.getStatusSnapshot(),
  });
});

// --- GET /api/qr ---------------------------------------------------------
router.get('/qr', (req, res) => {
  const qr = connectionManager.getQr();
  if (!qr) {
    return res.json({
      ok: true,
      data: { available: false, message: 'QR tidak tersedia (sudah connected atau belum digenerate)' },
    });
  }
  res.json({
    ok: true,
    data: { available: true, qrDataUrl: qr.qrDataUrl },
  });
});

// --- GET /api/messages -----------------------------------------------------
router.get('/messages', (req, res) => {
  const limitRaw = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
  res.json({
    ok: true,
    data: messageStore.getRecent(limit),
  });
});

// --- POST /api/messages/send ------------------------------------------------
router.post('/messages/send', jsonSmall, async (req, res) => {
  const { to, text } = req.body || {};

  if (typeof to !== 'string' || to.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'Field "to" wajib diisi (string)' });
  }
  if (typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'Field "text" wajib diisi (string)' });
  }
  if (text.length > 4096) {
    return res.status(400).json({ ok: false, error: 'Teks pesan terlalu panjang (maks 4096 karakter)' });
  }

  const normalized = normalizeToJid(to);
  if (!normalized.ok) {
    return res.status(400).json({ ok: false, error: `Nomor tujuan tidak valid: ${normalized.reason}` });
  }

  if (!connectionManager.isConnected()) {
    return res.status(409).json({ ok: false, error: 'WhatsApp belum connected' });
  }

  try {
    const result = await connectionManager.sendTextMessage(normalized.jid, text);
    return res.json({ ok: true, data: result });
  } catch (err) {
    logger.error('Endpoint send message gagal', { error: err.message });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// --- POST /api/pairing-code -----------------------------------------------
// Alternatif login selain scan QR (lihat requestPairingCode() di
// connectionManager.js) -- terutama untuk kasus Gateway dijalankan di HP
// yang sama dengan HP pemilik nomor WhatsApp, di mana scan QR ke layar
// sendiri tidak praktis. Body: { "phone": "62812xxxxxxx" } (format
// internasional, tanpa '+'/spasi/0 di depan).
router.post('/pairing-code', jsonSmall, async (req, res) => {
  const { phone } = req.body || {};

  try {
    const code = await connectionManager.requestPairingCode(phone);
    res.json({ ok: true, data: { pairingCode: code, phone } });
  } catch (err) {
    logger.warn('Gagal meminta pairing code', { phone, error: err.message });
    res.status(400).json({ ok: false, error: err.message });
  }
});

// --- POST /api/reconnect -----------------------------------------------------
router.post('/reconnect', async (req, res) => {
  try {
    // Jangan tunggu koneksi selesai total sebelum respon (bisa makan waktu),
    // cukup konfirmasi bahwa proses reconnect sudah dipicu.
    connectionManager.manualReconnect().catch((err) => {
      logger.error('Reconnect manual gagal di background', { error: err.message });
    });
    res.json({ ok: true, message: 'Reconnect dipicu' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- POST /api/logout -----------------------------------------------------
router.post('/logout', async (req, res) => {
  try {
    connectionManager.logout().catch((err) => {
      logger.error('Logout gagal di background', { error: err.message });
    });
    res.json({ ok: true, message: 'Logout/reset session dipicu, QR baru akan tersedia sebentar lagi' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// Conversation-based endpoints (validasi identitas chat, termasuk kasus @lid)
//
// PRINSIP: chatId di sini SELALU JID asli WhatsApp (@s.whatsapp.net / @lid / @g.us)
// apa adanya. Tidak ada endpoint di bawah ini yang menormalisasi atau menebak
// nomor telepon dari chatId.
// ============================================================================

// --- GET /api/chats ---------------------------------------------------------
// Daftar conversation, dikelompokkan berdasarkan chatId (JID asli).
router.get('/chats', (req, res) => {
  res.json({
    ok: true,
    data: messageStore.listConversations(),
  });
});

// --- GET /api/chats/:chatId/messages -----------------------------------------
// Pesan milik SATU conversation saja. chatId harus JID asli, contoh:
//   /api/chats/255490491736112%40lid/messages
// (encodeURIComponent pada client akan meng-escape "@" menjadi "%40", Express
// men-decode otomatis sehingga req.params.chatId berisi JID asli kembali.)
router.get('/chats/:chatId/messages', (req, res) => {
  const { chatId } = req.params;

  if (!isDecodableJid(chatId)) {
    return res.status(400).json({ ok: false, error: `chatId tidak valid: ${chatId}` });
  }

  res.json({
    ok: true,
    data: messageStore.getByChatId(chatId),
  });
});

// --- POST /api/chats/:chatId/reply --------------------------------------------
// Balas SATU conversation. chatId dari URL dipakai LANGSUNG sebagai target
// pengiriman ke Baileys -- TIDAK pernah dikonversi ke nomor telepon terlebih dahulu.
router.post('/chats/:chatId/reply', jsonSmall, async (req, res) => {
  const { chatId } = req.params;
  const { text } = req.body || {};

  if (!isDecodableJid(chatId)) {
    return res.status(400).json({ ok: false, error: `chatId tidak valid: ${chatId}` });
  }
  if (typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'Field "text" wajib diisi (string)' });
  }
  if (text.length > 4096) {
    return res.status(400).json({ ok: false, error: 'Teks pesan terlalu panjang (maks 4096 karakter)' });
  }
  if (!connectionManager.isConnected()) {
    return res.status(409).json({ ok: false, error: 'WhatsApp belum connected' });
  }

  try {
    const result = await connectionManager.sendReply(chatId, text);
    return res.json({ ok: true, data: result });
  } catch (err) {
    logger.error('Endpoint reply gagal', { chatId, error: err.message });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// --- POST /api/chats/:chatId/reply-media --------------------------------------
// Balas SATU conversation dengan media (gambar/dokumen/sticker). Sumber file boleh
// SALAH SATU: `mediaBase64` (konten langsung, base64) ATAU `mediaUrl` (Gateway
// mengunduhnya sendiri). `mediaUrl` HANYA untuk kemudahan uji manual dari
// dashboard test ini (tempel link gambar/dokumen) -- endpoint machine-to-machine
// untuk CI4 (POST /send-media, lihat ci4Routes.js) SENGAJA hanya menerima base64.
router.post('/chats/:chatId/reply-media', jsonMedia, async (req, res) => {
  const { chatId } = req.params;
  const { mediaType, mediaBase64, mediaUrl, caption, fileName, mimetype, isAnimated } = req.body || {};

  if (!isDecodableJid(chatId)) {
    return res.status(400).json({ ok: false, error: `chatId tidak valid: ${chatId}` });
  }
  if (!VALID_MEDIA_TYPES.includes(mediaType)) {
    return res.status(400).json({ ok: false, error: `mediaType harus salah satu dari: ${VALID_MEDIA_TYPES.join(', ')}` });
  }
  if (mediaType === 'document' && (typeof fileName !== 'string' || fileName.trim().length === 0)) {
    return res.status(400).json({ ok: false, error: 'Field "fileName" wajib diisi untuk mediaType "document"' });
  }
  if (typeof caption !== 'undefined' && typeof caption !== 'string') {
    return res.status(400).json({ ok: false, error: 'Field "caption" harus berupa string jika diisi' });
  }
  if (caption && caption.length > 1024) {
    return res.status(400).json({ ok: false, error: 'Caption terlalu panjang (maks 1024 karakter)' });
  }
  if (!connectionManager.isConnected()) {
    return res.status(409).json({ ok: false, error: 'WhatsApp belum connected' });
  }

  let buffer;
  let resolvedMimetype = mimetype;

  if (typeof mediaBase64 === 'string' && mediaBase64.trim().length > 0) {
    const decoded = decodeBase64Media(mediaBase64);
    if (!decoded.ok) {
      return res.status(400).json({ ok: false, error: decoded.reason });
    }
    buffer = decoded.buffer;
  } else if (typeof mediaUrl === 'string' && mediaUrl.trim().length > 0) {
    const fetched = await fetchMediaFromUrl(mediaUrl.trim());
    if (!fetched.ok) {
      return res.status(400).json({ ok: false, error: fetched.reason });
    }
    buffer = fetched.buffer;
    resolvedMimetype = resolvedMimetype || fetched.mimetype || undefined;
  } else {
    return res.status(400).json({ ok: false, error: 'Wajib isi salah satu: "mediaBase64" atau "mediaUrl"' });
  }

  if (mediaType === 'sticker' && !isValidWebp(buffer)) {
    // Gateway TIDAK melakukan konversi otomatis (JPEG/PNG -> WebP) --
    // lihat komentar isValidWebp() di mediaPayload.js.
    return res.status(400).json({
      ok: false,
      error: 'File sticker harus berupa WebP valid (Gateway tidak melakukan konversi otomatis dari format lain)',
    });
  }

  try {
    const result = await connectionManager.sendMediaReply(chatId, mediaType, buffer, {
      caption: caption || undefined,
      mimetype: resolvedMimetype || undefined,
      fileName: fileName || undefined,
      isAnimated: Boolean(isAnimated),
    });
    return res.json({ ok: true, data: result });
  } catch (err) {
    logger.error('Endpoint reply media gagal', { chatId, mediaType, error: err.message });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// --- GET /api/events (untuk dashboard event log) ---------------------------
router.get('/events', (req, res) => {
  res.json({
    ok: true,
    data: logger.getRecentEvents(),
  });
});

module.exports = router;
