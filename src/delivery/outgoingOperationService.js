'use strict';

const crypto = require('crypto');
const config = require('../config');
const logger = require('../logging');
const outgoingOperations = require('../store/outgoingOperations');

/**
 * Orkestrasi idempotensi KIRIM KELUAR (M1 Wave 2 TASK-003, spec 4.2/4.3/8),
 * dipakai bersama oleh POST /send dan POST /send-media supaya tidak duplikatif.
 *
 * Kunci desain (REQ-021, ASSUMPTION-009): baris `in_flight` ditulis DULU
 * (`begin()`), baru `send()` (yang memanggil Baileys) dijalankan. Mencatat
 * setelah kirim kalah balapan dengan crash dan membuat hasilnya tidak pasti.
 * Urutan ini dijaga tes runtime DAN guard statis
 * test/check-outgoing-begin-before-send.js.
 *
 * Service ini TIDAK menyentuh HTTP: runOperation() mengembalikan `outcome`,
 * toHttpResponse() menerjemahkannya ke status + body sesuai matriks 4.3.
 */

// REQ-020: 1-64 karakter, hanya alfanumerik dan . _ : - . (Tanpa flag `m`, `$`
// di JS hanya cocok di akhir string -- tidak ada celah "baris baru di ujung".)
const OPERATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * @param {*} raw nilai field `operation_id` dari body request
 * @returns {{ok: true, operationId: string|null} | {ok: false}}
 *   `undefined`/`null` = tidak dikirim (AuliaPos lama, REQ-026); field yang ada
 *   tetapi bukan string sesuai pola (termasuk string kosong) = tidak valid.
 */
function validateOperationId(raw) {
  if (raw === undefined || raw === null) return { ok: true, operationId: null };
  if (typeof raw !== 'string' || !OPERATION_ID_PATTERN.test(raw)) return { ok: false };
  return { ok: true, operationId: raw };
}

/**
 * Fingerprint payload (ASSUMPTION-005): SHA-256 dari JSON kanonik
 * [kind, chatId, text | null, mediaMeta | null]. Urutan elemen array tetap, jadi
 * hasilnya deterministik. Hanya teks/metadata yang masuk; base64 media TIDAK
 * pernah di-hash apa adanya (lihat mediaMeta di ci4Routes.js). Dipanggil SETELAH
 * seluruh validasi payload lolos (A-7).
 */
function computePayloadHash({ kind, chatId, text = null, mediaMeta = null }) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([kind, chatId, text, mediaMeta]))
    .digest('hex');
}

/**
 * Metadata media untuk fingerprint (ASSUMPTION-005, SEC-001): dihitung dari konten
 * HASIL DECODE base64, bukan dari string base64-nya -- string itu tidak pernah
 * di-hash apa adanya maupun ditulis ke log. Dua media berbeda dengan kunci yang
 * sama tetap terdeteksi lewat `sha256` isinya.
 */
function buildMediaMeta({ mediaType, buffer, mimetype, fileName, caption, isAnimated }) {
  return {
    media_type: mediaType,
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    mimetype: mimetype || null,
    file_name: fileName || null,
    caption: caption || null,
    is_animated: Boolean(isAnimated),
  };
}

// REQ-026: satu `warn` per PROSES (bukan per permintaan) supaya transisi AuliaPos
// terlihat tanpa membanjiri log.
let warnedWithoutOperationId = false;
function warnWithoutOperationIdOnce() {
  if (warnedWithoutOperationId) return;
  warnedWithoutOperationId = true;
  logger.warn('[SEND-OPERATION] permintaan kirim tanpa operation_id; idempotensi tidak aktif (AuliaPos lama?). Peringatan ini hanya dicatat sekali per proses.');
}

// Terminal state = hasil sudah pasti dan tersimpan; boleh dijawab ulang tanpa kirim.
const TERMINAL_STATES = ['sent', 'failed', 'abandoned'];
const MAX_LISTED_IDS = 20; // batas daftar operation_id di log start-up (REQ-031/REQ-032)

// REQ-028: `updated_at` diperbarui setiap kali baris disentuh (begin/registerRetry/
// markUnresolved), jadi lease mengukur "sejak sentuhan terakhir". Selagi masih di
// dalam lease, operasi in_flight dianggap sedang dikerjakan permintaan aktif dan
// MUST dijawab 409 SEND_IN_PROGRESS tanpa kirim.
function isLeaseExpired(row, nowMs) {
  return (nowMs - Date.parse(row.updated_at)) > config.outgoingLeaseMs;
}

/**
 * Klasifikasikan baris operasi yang SUDAH ADA (spec 4.2/4.3). Lima kemungkinan:
 *   reused        -- payload_hash berbeda (REQ-023, 409 OPERATION_ID_REUSED)
 *   replay        -- state terminal, hasil dijawab ulang dari catatan (REQ-022)
 *   in_progress   -- in_flight & masih di dalam lease (REQ-028, 409 SEND_IN_PROGRESS)
 *   retry         -- in_flight, lease lewat, attempts < cap -> boleh kirim ulang (REQ-028)
 *   dead_lettered -- in_flight, lease lewat, attempts >= cap (REQ-029, 502 DEAD_LETTERED)
 */
function classifyExisting(row, payloadHash, nowMs) {
  // REQ-023: kunci yang sama, isi berbeda -> ditolak tanpa menyentuh Baileys.
  if (row.payload_hash !== payloadHash) return { outcome: 'reused', row };
  // REQ-022: hasil terminal dijawab ulang dari catatan (replay).
  if (TERMINAL_STATES.includes(row.state)) return { outcome: 'replay', row };
  // in_flight: kiriman sebelumnya belum pasti hasilnya.
  if (!isLeaseExpired(row, nowMs)) return { outcome: 'in_progress', row };
  // R-2/REQ-029: cap diperiksa SEBELUM kirim ulang; `attempts` = jumlah kiriman
  // yang sudah dijalankan, jadi cap 5 = maksimum 5 kiriman per operasi.
  if (row.attempts >= config.outgoingMaxAttempts) return { outcome: 'dead_lettered', row };
  return { outcome: 'retry', row };
}

/**
 * REQ-029/R-2: cap tercapai -> operasi masuk dead-letter kirim keluar.
 * Log `[CRITICAL]` ditulis store.abandon() (P-6) supaya jejaknya satu tempat;
 * fungsi ini mengembalikan keputusan siap-respons (502 DEAD_LETTERED).
 */
function deadLetter(operationId) {
  outgoingOperations.abandon(operationId, 'max_attempts');
  return { outcome: 'dead_lettered', row: outgoingOperations.get(operationId) };
}

/**
 * Jalankan satu niat kirim dengan idempotensi.
 *
 * @param {object} args
 * @param {string} args.operationId sudah lolos validateOperationId()
 * @param {string} args.payloadHash dari computePayloadHash()
 * @param {'text'|'media'} args.kind
 * @param {string} args.chatId
 * @param {() => boolean} args.isReady false -> `not_connected`. Diperiksa SEBELUM
 *   baris operasi dibuat (REQ-030) dan sebelum kirim ulang pasca-lease supaya
 *   penolakan koneksi tidak meninggalkan `in_flight` palsu maupun menghabiskan
 *   percobaan; replay tetap bisa dijawab walau WhatsApp sedang tidak connected.
 * @param {() => Promise<{messageId: string|null, timestamp: string, mediaRef?: object|null}>} args.send
 *   pemanggilan Baileys; HANYA dipanggil setelah begin().
 * @returns {Promise<{outcome: string, row?: object, result?: object, error?: Error}>}
 *   outcome: sent | failed | unresolved | replay | in_progress | dead_lettered |
 *            reused | not_connected | store_error
 */
async function runOperation({ operationId, payloadHash, kind, chatId, isReady, send }) {
  // --- tahap 1: catat niat kirim. Gagal di sini = TIDAK ADA yang dikirim, jadi
  // menolak (fail closed) aman; mengirim tanpa catatan justru membuka duplikat. ---
  try {
    const existing = outgoingOperations.get(operationId);
    if (existing) {
      const decision = classifyExisting(existing, payloadHash, outgoingOperations.now());
      if (decision.outcome === 'dead_lettered') return logOutcome(deadLetter(operationId), operationId, chatId);
      if (decision.outcome !== 'retry') return logOutcome(decision, operationId, chatId);
      // REQ-028: lease sudah lewat -> ini sisa percobaan yang mati, boleh dicoba
      // ulang. REQ-030 tetap berlaku supaya 409 NOT_CONNECTED tidak menghabiskan
      // percobaan (attempts = jumlah kiriman yang benar-benar dijalankan, REQ-029).
      if (!isReady()) return { outcome: 'not_connected' };
      // R-2/REQ-029: cap SUDAH dicek di classifyExisting() sebelum baris ini.
      outgoingOperations.registerRetry(operationId);
      logger.info('[SEND-OPERATION] lease lewat -- kirim ulang (attempts dicatat sebelum kirim)', {
        operationId,
        chatId,
        attempts: outgoingOperations.get(operationId).attempts,
      });
    } else {
      // REQ-030: periksa koneksi SEBELUM baris dibuat supaya 409 NOT_CONNECTED
      // tidak meninggalkan `in_flight` palsu.
      if (!isReady()) return { outcome: 'not_connected' };

      const begun = outgoingOperations.begin({ operationId, payloadHash, kind, chatId });
      if (!begun.created) {
        // Balapan: permintaan lain membuat baris ini beberapa milidetik lalu.
        // Barisnya baru, jadi tidak mungkin stale; klasifikasikan lalu berhenti.
        const raced = classifyExisting(begun.row, payloadHash, outgoingOperations.now());
        return logOutcome(raced.outcome === 'dead_lettered' ? deadLetter(operationId) : raced, operationId, chatId);
      }
    }
  } catch (err) {
    logger.error('[SEND-OPERATION] gagal mencatat operasi -- pesan TIDAK dikirim', { operationId, chatId, error: err.message });
    return { outcome: 'store_error', error: err };
  }

  // --- tahap 2: titik tanpa kembali. Baris in_flight SUDAH tersimpan, baru kirim. ---
  let result;
  try {
    result = await send();
  } catch (err) {
    // ASSUMPTION-006: hanya INVALID_CHAT_ID (jalur cadangan guard JID) yang
    // pasti gagal; SEMUA error lain ambigu -- pesan mungkin sudah diterima
    // WhatsApp. Jangan pernah menganggapnya "belum terkirim".
    const definitive = err.code === 'INVALID_CHAT_ID';
    recordSafely(operationId, () => (definitive
      ? outgoingOperations.markFailed(operationId, err.message)
      : outgoingOperations.markUnresolved(operationId, err.message)));
    logger.error(definitive ? '[SEND-OPERATION] kirim gagal definitif' : '[SEND-OPERATION] hasil kirim tidak pasti (in_flight)', {
      operationId,
      chatId,
      errorCode: err.code || null,
      error: err.message,
    });
    return { outcome: definitive ? 'failed' : 'unresolved', error: err };
  }

  // Kirim SUDAH berhasil: kegagalan mencatatnya tidak boleh mengubah hasil menjadi
  // "gagal/tidak pasti" (pesan benar-benar terkirim). Baris tinggal in_flight dan
  // terlihat sebagai operasi basi saat start (REQ-031).
  recordSafely(operationId, () => {
    if (!outgoingOperations.markSent(operationId, { waMessageId: result.messageId, mediaRef: result.mediaRef || null, sentAt: result.timestamp })) {
      logger.error('[SEND-OPERATION] markSent tidak mengubah baris (bukan in_flight lagi?)', { operationId });
    }
  });
  logger.info('[SEND-OPERATION] kirim berhasil, operasi sent', { operationId, chatId, waMessageId: result.messageId });
  return { outcome: 'sent', result };
}

function recordSafely(operationId, write) {
  try {
    write();
  } catch (err) {
    logger.error('[SEND-OPERATION] gagal memperbarui catatan operasi setelah kirim', { operationId, error: err.message });
  }
}

// GUD-004: setiap keputusan yang mencegah duplikat tercatat bersama operation_id (tanpa isi pesan, SEC-001).
function logOutcome(decision, operationId, chatId) {
  const meta = { operationId, chatId, state: decision.row && decision.row.state };
  if (decision.outcome === 'reused') logger.warn('[SEND-OPERATION] operation_id dipakai ulang dengan payload berbeda -- ditolak, tidak dikirim', meta);
  else if (decision.outcome === 'replay') logger.info('[SEND-OPERATION] replay hasil tersimpan, tidak dikirim ulang', meta);
  else if (decision.outcome === 'dead_lettered') logger.warn('[SEND-OPERATION] operasi sudah dead-letter (attempts >= cap) -- ditolak tanpa kirim', meta);
  else logger.info('[SEND-OPERATION] operasi masih in_flight di dalam lease -- ditolak tanpa kirim (hasil belum pasti)', meta);
  return decision;
}

const UNRESOLVED_MESSAGE = 'Hasil pengiriman belum pasti: pesan mungkin sudah terkirim. Jangan kirim ulang dulu.';

function parseMediaRef(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch (err) {
    return null;
  }
}

/**
 * Terjemahkan hasil runOperation() ke respons HTTP (matriks spec 4.3).
 * Field lama (success, wa_message_id, timestamp, media_ref, error_code,
 * message) tetap ada dengan arti yang sama (REQ-025); `state`/`replayed`
 * (dan `operation_id`) hanya ditambahkan.
 *
 * @param {object} decision hasil runOperation()
 * @param {{operationId: string, withMediaRef?: boolean}} options withMediaRef:
 *   true untuk /send-media (selalu sertakan `media_ref`, null bila tidak ada).
 * @returns {{status: number, body: object}}
 */
function toHttpResponse(decision, { operationId, withMediaRef = false }) {
  const respond = (status, body) => ({ status, body: { ...body, operation_id: operationId } });

  switch (decision.outcome) {
    case 'sent': {
      const body = {
        success: true,
        state: 'sent',
        replayed: false,
        wa_message_id: decision.result.messageId,
        timestamp: decision.result.timestamp,
      };
      if (withMediaRef) body.media_ref = decision.result.mediaRef || null;
      return respond(200, body);
    }
    case 'failed':
      return respond(500, {
        success: false,
        state: 'failed',
        replayed: false,
        error_code: decision.error.code || 'SEND_FAILED',
        message: decision.error.message,
      });
    case 'unresolved':
      return respond(504, {
        success: false,
        state: 'in_flight',
        replayed: false,
        error_code: 'SEND_UNRESOLVED',
        message: UNRESOLVED_MESSAGE,
      });
    case 'in_progress':
      return respond(409, {
        success: false,
        state: 'in_flight',
        replayed: true,
        error_code: 'SEND_IN_PROGRESS',
        message: UNRESOLVED_MESSAGE,
      });
    case 'dead_lettered':
      // REQ-029/AC-029: cap tercapai -> terminal `abandoned`; TIDAK ada kiriman baru.
      return respond(502, {
        success: false,
        state: 'abandoned',
        replayed: true,
        error_code: 'DEAD_LETTERED',
        message: 'Operasi ini sudah mencapai batas percobaan dan tidak akan dikirim lagi.',
      });
    case 'reused':
      return respond(409, {
        success: false,
        replayed: false,
        error_code: 'OPERATION_ID_REUSED',
        message: 'operation_id sudah dipakai untuk pesan yang berbeda. Gunakan operation_id baru untuk pesan baru.',
      });
    case 'store_error':
      // Belum ada yang dikirim (gagal mencatat SEBELUM kirim) -- aman dicoba ulang.
      return respond(500, {
        success: false,
        error_code: 'OPERATION_STORE_ERROR',
        message: 'Gagal mencatat operasi kirim; pesan belum dikirim.',
      });
    case 'not_connected':
      return respond(409, {
        success: false,
        error_code: 'NOT_CONNECTED',
        message: 'WhatsApp belum connected.',
      });
    case 'replay': {
      const { row } = decision;
      if (row.state === 'sent') {
        const body = {
          success: true,
          state: 'sent',
          replayed: true,
          wa_message_id: row.wa_message_id,
          timestamp: row.resolved_at,
        };
        if (withMediaRef) body.media_ref = parseMediaRef(row.media_ref_json);
        return respond(200, body);
      }
      if (row.state === 'failed') {
        return respond(500, {
          success: false,
          state: 'failed',
          replayed: true,
          error_code: 'SEND_FAILED',
          message: row.last_error || 'Pengiriman sebelumnya gagal.',
        });
      }
      return respond(502, {
        success: false,
        state: 'abandoned',
        replayed: true,
        error_code: 'DEAD_LETTERED',
        message: 'Operasi ini sudah mencapai batas percobaan dan tidak akan dikirim lagi.',
      });
    }
    default:
      throw new Error(`outcome tidak dikenal: ${decision.outcome}`);
  }
}

module.exports = {
  OPERATION_ID_PATTERN,
  validateOperationId,
  computePayloadHash,
  buildMediaMeta,
  warnWithoutOperationIdOnce,
  runOperation,
  toHttpResponse,
};
