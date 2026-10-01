'use strict';

const config = require('../config');
const logger = require('../logging');

/**
 * M1 Wave 1 TASK-003 (REQ-010, REQ-012, D-02): penampung sementara IN-MEMORY
 * untuk event yang gagal disimpan ke buffer utama setelah dicoba ulang
 * (enqueueWithRetry, TASK-002). Melindungi dari gangguan SEMENTARA
 * (lock/disk sibuk), BUKAN dari crash proses -- isinya hilang kalau proses
 * mati (batasan yang diterima, spec E-04 dan ALT-001).
 *
 * - push(event): tambah ke penampung. Penuh -> event TERBARU dibuang (yang
 *   lama dipertahankan), dicatat sebagai error keras, mengembalikan true.
 * - drain(tryEnqueue): coba tiap event SATU kali tanpa jeda lewat callback
 *   sinkron (melempar = gagal). Yang berhasil dikeluarkan, sisanya tetap
 *   tertampung dan dikembalikan (REQ-011, ASSUMPTION-003).
 * - size(): jumlah event tertampung.
 *
 * Setiap perubahan ukuran (push atau drain) MUST tercatat di log dengan
 * ukuran terbaru (REQ-012, AC-016).
 *
 * LEVEL LOG: logger proyek hanya punya info/warn/error/debug, tidak ada
 * `critical`. Pembuangan event dicatat lewat logger.error dengan prefix
 * "[CRITICAL]" dan `severity: 'critical'` (memenuhi GUD-002: error atau lebih
 * tinggi) tanpa mengubah logger bersama.
 */
const DEFAULT_OVERFLOW_MAX = 500;

class OverflowBuffer {
  constructor(maxSize = DEFAULT_OVERFLOW_MAX) {
    this.maxSize = maxSize;
    this.items = [];
    this.totalDropped = 0;
  }

  /** @returns {boolean} true kalau event DIBUANG karena penampung penuh. */
  push(event) {
    if (this.items.length >= this.maxSize) {
      this.totalDropped += 1;
      logger.error('[CRITICAL] overflow buffer penuh -- event terbaru DIBUANG, pesan hilang', {
        severity: 'critical',
        messageId: event.messageId,
        size: this.items.length,
        maxSize: this.maxSize,
        dropped: 1,
        totalDropped: this.totalDropped,
      });
      return true;
    }

    this.items.push(event);
    logger.warn('[DELIVERY] event masuk overflow buffer (buffer utama gagal)', {
      messageId: event.messageId,
      size: this.items.length,
    });
    return false;
  }

  /**
   * @param {(event: object) => void} tryEnqueue callback sinkron; melempar = gagal.
   * @returns {object[]} event yang masih tertampung (gagal lagi).
   */
  drain(tryEnqueue) {
    const before = this.items.length;
    if (before === 0) return [];

    const remaining = [];
    for (const event of this.items) {
      try {
        tryEnqueue(event);
      } catch (err) {
        remaining.push(event);
      }
    }
    this.items = remaining;

    if (remaining.length !== before) {
      logger.info('[DELIVERY] overflow buffer dikuras', {
        size: remaining.length,
        drained: before - remaining.length,
      });
    }
    return remaining.slice();
  }

  size() {
    return this.items.length;
  }
}

// Satu instance bersama untuk jalur terima pesan (connectionManager) dan
// siklus worker (incomingDelivery). Kapasitas dari ENQUEUE_OVERFLOW_MAX
// (TASK-005, GUD-001); bawaan 500.
const overflowBuffer = new OverflowBuffer(config.enqueueOverflowMax);

module.exports = { OverflowBuffer, DEFAULT_OVERFLOW_MAX, overflowBuffer };
