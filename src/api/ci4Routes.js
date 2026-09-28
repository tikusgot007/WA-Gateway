'use strict';

const express = require('express');
const connectionManager = require('../whatsapp/connectionManager');
const logger = require('../logging');
const config = require('../config');
const { isDecodableJid } = require('../whatsapp/jidUtils');
const { requireCI4Token } = require('./authMiddleware');
const { VALID_MEDIA_TYPES, decodeBase64Media, isValidWebp } = require('../whatsapp/mediaPayload');
const { resolveForwardRequest } = require('../whatsapp/forwardMarker');
const outgoingOperationService = require('../delivery/outgoingOperationService');

// M1 Wave 2 (REQ-020): respons 400 yang sama untuk /send dan /send-media.
function invalidOperationIdResponse(res) {
  return res.status(400).json({
    success: false,
    error_code: 'INVALID_OPERATION_ID',
    message: 'operation_id harus string 1-64 karakter dengan pola [A-Za-z0-9._:-].',
  });
}

// Teruskan (Tahap 4, CON-001): `forward` dan `quoted` TIDAK PERNAH dikirim
// bersamaan. AuliaPos menegakkannya di sisi POS (server), jadi kemunculannya di
// sini berarti bug pemanggil -- ditolak 400 supaya terlihat, bukan didiamkan
// dengan diam-diam mengorbankan salah satu penanda.
function forwardWithQuotedResponse(res) {
  return res.status(400).json({
    success: false,
    error_code: 'FORWARD_WITH_QUOTED',
    message: 'Field "forward" dan "quoted" tidak boleh dikirim bersamaan pada satu request.',
  });
}

/**
 * Baca field `forward` dari body request dan laporkan penyimpangan bentuknya.
 * Nilai selain boolean diperlakukan `false` (pola degradasi F-C, sama seperti
 * `quoted`) dan di-log -- isi pesan pengguna tidak boleh hilang karena field
 * tambahan yang salah. `absent`/`null` = tidak diminta sama sekali.
 */
function readForwardRequest(req, label) {
  const parsed = resolveForwardRequest((req.body || {}).forward);
  if (parsed.malformed) {
    logger.warn(`[${label}] field "forward" bukan boolean -- diperlakukan false, pesan tetap dikirim`, {
      nilaiDiterima: typeof (req.body || {}).forward,
    });
  }
  return parsed;
}

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

  // Balas Pesan (Tahap 3, REQ-001): `quoted` opsional. Kehadirannya menentukan
  // apakah respons menyertakan `quote_applied` -- request TANPA `quoted` tetap
  // berperilaku persis seperti sebelumnya. Nilai malformed TIDAK ditolak di sini
  // (F-C/CON-001): connectionManager mendegradasinya jadi "tanpa kutipan".
  const rawQuoted = (req.body || {}).quoted;
  const quoteRequested = rawQuoted !== undefined && rawQuoted !== null;

  // Teruskan (Tahap 4, REQ-001): `forward` opsional (boolean, default false).
  // Kehadirannya menentukan apakah respons menyertakan `forward_marker_applied` --
  // request TANPA `forward` tetap berperilaku persis seperti sebelumnya.
  const forward = readForwardRequest(req, 'SEND-CI4');
  if (forward.requested && quoteRequested) return forwardWithQuotedResponse(res);

  // M1 Wave 2 (REQ-020): operation_id opsional; yang ada tapi tidak valid ditolak
  // 400 SEBELUM apa pun menyentuh Baileys.
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

  // sendReply() dipilih (bukan sendTextMessage() langsung) supaya
  // pesan yang dikirim dari POS JUGA tercatat di messageStore lokal
  // Gateway -- dashboard test Gateway tetap konsisten menampilkan
  // semua pesan keluar, dari mana pun asalnya.
  // Satu-satunya titik panggilan sendReply() di route ini: jalur idempotensi
  // memanggilnya HANYA lewat runOperation() (setelah baris in_flight tersimpan);
  // jalur lama (tanpa operation_id) memanggilnya langsung.
  const doSend = () => connectionManager.sendReply(chatId, text, { quoted: rawQuoted, forward: forward.requested });

  if (operationId) {
    // M1 Wave 2 (REQ-021..REQ-027): kirim dengan idempotensi. payload_hash
    // dihitung SETELAH seluruh validasi payload di atas lolos (A-7).
    // `forward` SENGAJA tidak masuk hash (pola `quoted`): supaya hash request
    // lama tidak berubah dan operasi in_flight milik AuliaPos tidak ter-abort
    // saat Gateway naik versi.
    const decision = await outgoingOperationService.runOperation({
      operationId,
      payloadHash: outgoingOperationService.computePayloadHash({ kind: 'text', chatId, text }),
      kind: 'text',
      chatId,
      isReady: () => connectionManager.isConnected(),
      send: doSend,
    });
    const { status, body } = outgoingOperationService.toHttpResponse(decision, {
      operationId,
      withQuoteApplied: quoteRequested,
      withForwardMarker: forward.requested,
    });
    return res.status(status).json(body);
  }

  // --- jalur lama: tanpa operation_id, perilaku seperti sebelumnya (REQ-026) ---
  outgoingOperationService.warnWithoutOperationIdOnce();

  if (!connectionManager.isConnected()) {
    logger.warn('[SEND-CI4] ditolak, WhatsApp belum connected', { chatId });
    return res.status(409).json({
      success: false,
      error_code: 'NOT_CONNECTED',
      message: 'WhatsApp belum connected.',
    });
  }

  try {
    const result = await doSend();

    logger.info('[SEND-CI4] pesan keluar dari POS berhasil dikirim', {
      chatId,
      waMessageId: result.messageId,
      quoteApplied: Boolean(result.quoteApplied),
      forwardMarkerApplied: result.forwardMarkerApplied,
    });

    return res.json({
      success: true,
      state: 'sent',
      replayed: false,
      wa_message_id: result.messageId,
      timestamp: result.timestamp,
      ...(quoteRequested ? { quote_applied: Boolean(result.quoteApplied) } : {}),
      ...(forward.requested ? { forward_marker_applied: result.forwardMarkerApplied || null } : {}),
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
// Kirim media (gambar/dokumen/sticker) KELUAR dari POS. Berbeda dari /media/download
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
    is_animated: isAnimated,
  } = req.body || {};

  // Balas Pesan (Tahap 3, REQ-001a): `quoted` opsional dengan struktur IDENTIK
  // /send (termasuk semantik fromMe & aturan malformed F-C). Kehadirannya
  // menentukan apakah respons menyertakan `quote_applied`.
  const rawQuoted = (req.body || {}).quoted;
  const quoteRequested = rawQuoted !== undefined && rawQuoted !== null;

  // Teruskan (Tahap 4, REQ-001a): `forward` opsional dengan struktur & aturan
  // IDENTIK /send. Kehadirannya menentukan apakah respons menyertakan
  // `forward_marker_applied`.
  const forward = readForwardRequest(req, 'SEND-MEDIA-CI4');
  if (forward.requested && quoteRequested) return forwardWithQuotedResponse(res);

  // M1 Wave 2 (REQ-020): dicek paling awal -- sebelum decode base64 yang mahal --
  // dan tanpa menyentuh Baileys.
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

  if (mediaType === 'sticker' && !isValidWebp(decoded.buffer)) {
    // Gateway TIDAK melakukan konversi otomatis (JPEG/PNG -> WebP) --
    // lihat komentar isValidWebp() di mediaPayload.js. Ditolak dengan
    // pesan jelas di sini, SEBELUM sempat diteruskan ke Baileys/WhatsApp.
    return res.status(400).json({
      success: false,
      error_code: 'INVALID_STICKER_FORMAT',
      message: 'File sticker harus berupa WebP valid (Gateway tidak melakukan konversi otomatis dari format lain).',
    });
  }

  // sendMediaReply() dipilih (bukan sendMediaMessage() langsung) supaya
  // media yang dikirim dari POS JUGA tercatat di messageStore lokal
  // Gateway, konsisten dengan /send (yang memakai sendReply()).
  // media_ref (kalau ada) memakai nama field YANG SAMA dengan payload
  // referensi media MASUK (direct_path/media_key_base64) supaya CI4 bisa
  // menyimpan & memakainya lewat alur POST /media/download yang sudah ada,
  // tanpa endpoint/logic baru -- media KELUAR jadi bisa dibuka ulang nanti
  // persis seperti media MASUK. Kalau Baileys tidak mengembalikan
  // referensi lengkap (mediaRef null), field ini cukup diabaikan CI4.
  // Satu-satunya titik panggilan sendMediaReply() di route ini (lihat /send).
  const doSend = async () => {
    const result = await connectionManager.sendMediaReply(chatId, mediaType, decoded.buffer, {
      caption: caption || undefined,
      mimetype: mimetype || undefined,
      fileName: fileName || undefined,
      isAnimated: Boolean(isAnimated),
      quoted: rawQuoted,
      forward: forward.requested,
    });
    return {
      messageId: result.messageId,
      timestamp: result.timestamp,
      mediaRef: result.mediaRef ? {
        direct_path: result.mediaRef.directPath,
        media_key_base64: result.mediaRef.mediaKeyBase64,
      } : null,
      quoteApplied: result.quoteApplied,
      forwardMarkerApplied: result.forwardMarkerApplied,
    };
  };

  if (operationId) {
    // M1 Wave 2 (REQ-021..REQ-027): kirim dengan idempotensi. Fingerprint dari
    // metadata + SHA-256 konten hasil decode (bukan string base64, SEC-001),
    // dihitung SETELAH seluruh validasi payload di atas lolos (A-7). `forward`
    // SENGAJA tidak masuk hash (pola `quoted`): hash request lama tidak boleh
    // berubah hanya karena Gateway naik versi.
    const mediaMeta = outgoingOperationService.buildMediaMeta({
      mediaType, buffer: decoded.buffer, mimetype, fileName, caption, isAnimated,
    });
    const decision = await outgoingOperationService.runOperation({
      operationId,
      payloadHash: outgoingOperationService.computePayloadHash({ kind: 'media', chatId, mediaMeta }),
      kind: 'media',
      chatId,
      isReady: () => connectionManager.isConnected(),
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

  // --- jalur lama: tanpa operation_id, perilaku seperti sebelumnya (REQ-026) ---
  outgoingOperationService.warnWithoutOperationIdOnce();

  if (!connectionManager.isConnected()) {
    logger.warn('[SEND-MEDIA-CI4] ditolak, WhatsApp belum connected', { chatId, mediaType });
    return res.status(409).json({
      success: false,
      error_code: 'NOT_CONNECTED',
      message: 'WhatsApp belum connected.',
    });
  }

  try {
    const result = await doSend();

    logger.info('[SEND-MEDIA-CI4] media keluar dari POS berhasil dikirim', {
      chatId,
      mediaType,
      waMessageId: result.messageId,
      mediaRefTersedia: Boolean(result.mediaRef),
      quoteApplied: Boolean(result.quoteApplied),
      forwardMarkerApplied: result.forwardMarkerApplied,
    });

    return res.json({
      success: true,
      state: 'sent',
      replayed: false,
      wa_message_id: result.messageId,
      timestamp: result.timestamp,
      media_ref: result.mediaRef,
      ...(quoteRequested ? { quote_applied: Boolean(result.quoteApplied) } : {}),
      ...(forward.requested ? { forward_marker_applied: result.forwardMarkerApplied || null } : {}),
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

  if (!VALID_MEDIA_TYPES.includes(mediaType)) {
    return res.status(400).json({
      success: false,
      error_code: 'INVALID_MEDIA_TYPE',
      message: `media_type harus salah satu dari: ${VALID_MEDIA_TYPES.join(', ')}, diterima: ${mediaType}`,
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
    // Klasifikasi kegagalan (plan-bugfix-inbox-media-unavailable-v1.0,
    // TASK-011, REQ-001/REQ-005).
    //
    // Sebelum ini SETIAP error dipetakan ke 410 MEDIA_UNAVAILABLE. Itu
    // berbahaya: CI4 memperlakukan 410 sebagai final (menulis
    // media_confirmed_gone_at, lalu semua request berikutnya di-short-circuit
    // tanpa pernah menghubungi Gateway) -- jadi satu kedip jaringan bisa
    // memblacklist foto yang masih utuh selamanya.
    //
    // TASK-010 sudah MENGUKUR sinyal asli dari host media (bukti:
    // build/task-010-expiry-signal-evidence.md):
    //   - tanda tangan URL kedaluwarsa -> 403
    //   - tanda tangan rusak            -> 403
    //   - objek media tidak ada         -> 403
    // Ketiganya IDENTIK, jadi 403 TIDAK BISA dipakai sebagai tanda
    // "kadaluarsa" -- memetakannya ke 410 akan menghapus foto yang utuh.
    // Karena tidak ada sinyal eksplisit yang bisa dipercaya, hanya 410
    // yang benar-benar dikirim host media yang diperlakukan final
    // (ASSUMPTION-001: arah yang aman -- salah tebak ke "coba lagi"
    // cuma menambah percobaan, salah tebak ke "permanen" menghapus foto).
    //
    // Bentuk objek error diverifikasi langsung terhadap axios yang
    // terpasang (scripts/probe-axios-error-shape.js): AxiosError dengan
    // `.response.status` dan `.code = 'ERR_BAD_REQUEST'` (BUKAN Boom).
    const statusDariHost = err.response?.status;

    if (err.code === 'MEDIA_DOWNLOAD_TIMEOUT') {
      logger.warn('[MEDIA] unduhan media melewati batas waktu (sementara, bisa dicoba lagi)', {
        mediaType,
        batasMs: config.mediaDownloadTimeoutMs,
      });

      return res.status(504).json({
        success: false,
        error_code: 'MEDIA_DOWNLOAD_TIMEOUT',
        message: `Gateway melewati batas waktu ${config.mediaDownloadTimeoutMs}ms saat mengambil media dari WhatsApp.`,
      });
    }

    if (statusDariHost === 410) {
      // Satu-satunya status yang CI4 perlakukan sebagai hilang permanen.
      // BELUM PERNAH teramati dari host media (2026-09-28); jalur ini
      // disediakan supaya kontrak 410 tetap utuh (CON-006) tanpa
      // mengorbankan media yang masih ada.
      logger.warn('[MEDIA] host media menyatakan media hilang permanen (410)', {
        mediaType,
        statusDariHost,
      });

      return res.status(410).json({
        success: false,
        error_code: 'MEDIA_UNAVAILABLE',
        message: 'Media sudah tidak tersedia di server WhatsApp.',
      });
    }

    // Semua sisanya SEMENTARA: kegagalan ambil di host media (403/4xx lain),
    // kegagalan dekripsi, dan error tak terduga. CI4 boleh mencoba lagi.
    logger.warn('[MEDIA] gagal mengambil/mendekripsi media (sementara, bisa dicoba lagi)', {
      mediaType,
      statusDariHost: statusDariHost ?? null,
      error: err.message,
    });

    return res.status(503).json({
      success: false,
      error_code: 'MEDIA_DOWNLOAD_FAILED',
      message: 'Gateway gagal mengambil media dari WhatsApp saat ini. Coba beberapa saat lagi.',
    });
  }
});

module.exports = router;
