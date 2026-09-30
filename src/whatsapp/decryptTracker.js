'use strict';

/**
 * Pencegahan insiden 2026-09-29 (sesi WA "connected" tapi diam-diam gagal
 * proses semua pesan karena dekripsi Signal Protocol corrupt/desync).
 *
 * Bungkus child logger pino yang diberikan ke Baileys supaya Gateway bisa
 * MENGHITUNG kegagalan dekripsi sesi (SessionError/MessageCounterError/"Bad
 * MAC"/"failed to decrypt message") TANPA mengubah perilaku logging aslinya
 * sama sekali -- setiap panggilan diteruskan apa adanya ke logger asli
 * setelah dihitung.
 *
 * KENAPA DI SINI (bukan process.on('unhandledRejection') seperti di
 * src/app/index.js): Baileys/libsignal MENANGKAP sendiri error dekripsi ini
 * secara internal dan HANYA melaporkannya lewat logger yang diberikan
 * (module: 'baileys') -- tidak pernah melempar ke process-level handler dan
 * tidak pernah muncul di event messages.upsert. Titik intersep SATU-SATUNYA
 * yang bisa dipakai untuk mendeteksi pola ini adalah logger itu sendiri.
 * Dikonfirmasi dari log insiden: baris-baris SessionError/MessageCounterError
 * muncul dengan level 50 (error) langsung dari module 'baileys', TIDAK
 * pernah lewat penekan noise di app/index.js (yang menangani jalur
 * unhandledRejection/uncaughtException yang berbeda).
 *
 * `onFailure()` dipanggil SETIAP KALI panggilan .error()/.warn() yang cocok
 * pola di atas terdeteksi. Pemanggil (ConnectionManager) yang memutuskan
 * ambang batas dan tindakan -- modul ini murni deteksi pola, tidak menyimpan
 * state apa pun sendiri.
 */
const NOISE_PATTERNS = [
  'SessionError',
  'MessageCounterError',
  'Bad MAC',
  'failed to decrypt',
];

function looksLikeDecryptFailure(args) {
  for (const arg of args) {
    if (typeof arg === 'string' && NOISE_PATTERNS.some((p) => arg.includes(p))) {
      return true;
    }
    if (arg && typeof arg === 'object') {
      const errType = arg.err?.type || arg.type;
      if (errType === 'SessionError' || errType === 'MessageCounterError') return true;
      const msg = arg.msg;
      if (typeof msg === 'string' && NOISE_PATTERNS.some((p) => msg.includes(p))) return true;
    }
  }
  return false;
}

/**
 * @param {object} pinoLogger instance pino (atau child-nya) yang akan dibungkus.
 * @param {() => void} onFailure dipanggil setiap kali pola kegagalan dekripsi terdeteksi.
 * @returns {object} Proxy transparan -- semua method lain (info/debug/child/dst) tetap bekerja apa adanya.
 */
function wrapLoggerForDecryptTracking(pinoLogger, onFailure) {
  return new Proxy(pinoLogger, {
    get(target, prop, receiver) {
      if (prop === 'error' || prop === 'warn') {
        const original = target[prop].bind(target);
        return function (...args) {
          try {
            if (looksLikeDecryptFailure(args)) onFailure();
          } catch (_) {
            // Tracking TIDAK PERNAH boleh menjatuhkan logging asli Baileys.
          }
          return original(...args);
        };
      }
      if (prop === 'child') {
        const originalChild = target.child.bind(target);
        return function (...args) {
          const child = originalChild(...args);
          return wrapLoggerForDecryptTracking(child, onFailure);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

module.exports = { wrapLoggerForDecryptTracking };
