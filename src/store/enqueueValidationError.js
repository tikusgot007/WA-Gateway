'use strict';

/**
 * M1 Wave 1 TASK-001 (REQ-006): error bertipe khusus untuk event yang tidak
 * lengkap. Dibedakan dari error penyimpanan (disk/lock) karena event yang
 * tidak valid tidak akan pernah berhasil kalau dicoba ulang -- pemanggil
 * (enqueueWithRetry, TASK-002) MUST melemparnya langsung tanpa retry.
 *
 * Sengaja di file sendiri (bukan di incomingBuffer.js) supaya modul lain
 * bisa mengenalinya lewat `instanceof` tanpa ikut membuat singleton buffer
 * (membuka database) saat di-require.
 */
class EnqueueValidationError extends Error {
  constructor(missing) {
    super(
      `incomingBuffer.enqueue: field wajib kosong/null (${missing.join(', ')}) -- pesan DITOLAK sebelum tersimpan, bukan diabaikan diam-diam`
    );
    this.name = 'EnqueueValidationError';
    this.missing = missing;
  }
}

module.exports = { EnqueueValidationError };
