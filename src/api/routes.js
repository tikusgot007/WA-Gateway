'use strict';

const express = require('express');
const connectionManager = require('../whatsapp/connectionManager');
const messageStore = require('../whatsapp/messageStore');
const logger = require('../logging');
const { normalizeToJid } = require('../whatsapp/normalize');
const { isDecodableJid } = require('../whatsapp/jidUtils');

const router = express.Router();

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
router.post('/messages/send', async (req, res) => {
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
router.post('/chats/:chatId/reply', async (req, res) => {
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

// --- GET /api/events (untuk dashboard event log) ---------------------------
router.get('/events', (req, res) => {
  res.json({
    ok: true,
    data: logger.getRecentEvents(),
  });
});

module.exports = router;
