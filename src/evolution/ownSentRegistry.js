'use strict';

/**
 * Daftar ID pesan yang DIKIRIM adapter sendiri (hasil POST /message/send*),
 * dipakai menyaring event webhook `MESSAGES_UPSERT` untuk pesan kita sendiri.
 *
 * Evolution mengirim event UPSERT untuk SETIAP pesan termasuk yang dikirim
 * instance ini (`key.fromMe === true`). Tanpa filter, balasan kasir dari POS
 * akan kembali masuk ke Inbox sebagai pesan "outgoing" ganda. Registry ini
 * in-memory (pola yang sama dengan ownSentRegistry WA-Gateway): mencatat
 * `key.id` sesaat setelah kirim sukses, dengan TTL supaya tidak tumbuh tanpa
 * batas. Kalau entri kedaluwarsa sebelum webhook tiba, pesan hanya muncul
 * sebagai sinkronisasi outgoing biasa (tidak fatal, sama seperti perilaku
 * WA-Gateway saat registry kehabisan TTL).
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 menit
const DEFAULT_MAX = 1000;

class OwnSentRegistry {
  constructor(ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map(); // id -> expiry epoch ms
  }

  record(messageId, now = Date.now()) {
    if (!messageId) return;
    this.map.set(String(messageId), now + this.ttlMs);
    this._evict(now);
  }

  has(messageId, now = Date.now()) {
    if (!messageId) return false;
    const key = String(messageId);
    const expiry = this.map.get(key);
    if (expiry === undefined) return false;
    if (expiry <= now) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  _evict(now) {
    for (const [key, expiry] of this.map) {
      if (expiry <= now) this.map.delete(key);
    }
    // Batas keras: buang entri tertua bila masih melebihi kapasitas.
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  size() {
    return this.map.size;
  }
}

module.exports = { OwnSentRegistry, DEFAULT_TTL_MS, DEFAULT_MAX };
module.exports.instance = new OwnSentRegistry();
