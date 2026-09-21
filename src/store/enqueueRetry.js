'use strict';

const logger = require('../logging');
const { EnqueueValidationError } = require('./enqueueValidationError');

/**
 * M1 Wave 1 TASK-002 (REQ-009, AC-007): coba ulang enqueue() untuk kegagalan
 * penyimpanan yang bersifat sementara (mis. database terkunci sesaat).
 *
 * Total pemanggilan = 1 percobaan awal + delaysMs.length percobaan ulang
 * (bawaan 3 ulangan berjeda 50, 200, 800 ms). Setelah semua gagal, error
 * TERAKHIR dilempar ulang -- pemanggil (TASK-004) yang memutuskan untuk
 * menampungnya di overflow buffer.
 *
 * EnqueueValidationError TIDAK dicoba ulang: event yang tidak lengkap tidak
 * akan pernah berhasil, jadi langsung dilempar. Pemanggil yang mencatat
 * error keras (REQ-006).
 *
 * `buffer` disuntik (bukan di-require di sini) supaya modul ini testable
 * tanpa membuka database.
 */
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([50, 200, 800]);

async function enqueueWithRetry(buffer, event, delaysMs = DEFAULT_RETRY_DELAYS_MS) {
  let lastError;
  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      return buffer.enqueue(event);
    } catch (err) {
      if (err instanceof EnqueueValidationError) throw err;

      lastError = err;
      if (attempt < delaysMs.length) {
        logger.warn('[DELIVERY] enqueue gagal, mencoba ulang', {
          messageId: event.messageId,
          attempt: attempt + 1,
          maxRetries: delaysMs.length,
          nextDelayMs: delaysMs[attempt],
          error: err.message,
        });
        await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
      }
    }
  }

  logger.error('[DELIVERY] GAGAL menyimpan pesan setelah dicoba ulang', {
    messageId: event.messageId,
    retries: delaysMs.length,
    error: lastError.message,
  });
  throw lastError;
}

module.exports = { enqueueWithRetry, DEFAULT_RETRY_DELAYS_MS };
