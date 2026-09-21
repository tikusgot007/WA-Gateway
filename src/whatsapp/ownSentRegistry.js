'use strict';

const config = require('../config');

/**
 * M1 Wave 1 TASK-008 (REQ-003, D-01, D-03): daftar ID pesan yang Gateway
 * kirim SENDIRI, disimpan in-memory dengan batas waktu dan ukuran.
 *
 * Kenapa perlu: Baileys memancarkan kiriman Gateway sendiri sebagai event
 * `append` (emitOwnEvents aktif) lewat process.nextTick TEPAT SEBELUM
 * sendMessage() mengembalikan hasil. Tanpa daftar ini, membuka filter
 * `type !== 'notify'` (E-01) akan mencatat ulang setiap balasan kasir sebagai
 * pesan `outgoing` ganda di Inbox.
 *
 * KONTRAK PEMAKAIAN (D-03, RISK-001): `register(id)` MUST dipanggil SEBELUM
 * `sock.sendMessage()`, tanpa menunggu hasilnya -- mencatat setelah kirim
 * kalah balapan dengan event `append` tadi. ID tetap tercatat walau kirim
 * gagal (tidak berbahaya: hanya menyaring event yang toh tidak akan datang).
 *
 * - register(messageId): catat ID + waktu sekarang. Melebihi `max` ->
 *   ID TERLAMA dikeluarkan.
 * - wasSentByUs(messageId): true kalau ID ada dan belum lewat `ttlMs`; entri
 *   kedaluwarsa dibersihkan saat dicek.
 *
 * Hilang saat proses restart (ASSUMPTION-001): idempotensi wa_message_id di
 * buffer dan AuliaPos menjadi jaring pengaman kedua.
 *
 * `now` disuntik hanya supaya test bisa memajukan waktu tanpa menunggu.
 */
class OwnSentRegistry {
  constructor({ ttlMs = config.ownSentTtlMs, max = config.ownSentMax, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.now = now;
    this.entries = new Map(); // messageId -> waktu dicatat (urutan sisip = urutan usia)
  }

  register(messageId) {
    if (!messageId) return;
    // Hapus dulu supaya ID yang dicatat ulang pindah ke posisi TERBARU.
    this.entries.delete(messageId);
    this.entries.set(messageId, this.now());

    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  wasSentByUs(messageId) {
    const registeredAt = this.entries.get(messageId);
    if (registeredAt === undefined) return false;

    if (this.now() - registeredAt > this.ttlMs) {
      this.entries.delete(messageId); // kedaluwarsa
      return false;
    }
    return true;
  }

  size() {
    return this.entries.size;
  }
}

// Satu instance bersama untuk titik kirim (TASK-009) dan filter `append`
// (TASK-010); batas dari OWN_SENT_TTL_MS / OWN_SENT_MAX.
const ownSentRegistry = new OwnSentRegistry();

module.exports = { OwnSentRegistry, ownSentRegistry };
