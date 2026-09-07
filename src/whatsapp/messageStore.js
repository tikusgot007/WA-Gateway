'use strict';

const config = require('../config');

/**
 * Penyimpanan pesan sementara di memory (bukan database).
 * Sesuai instruksi POC: pesan boleh disimpan sementara/in-memory untuk dashboard.
 * Data akan hilang setiap kali aplikasi direstart -- ini disengaja untuk POC.
 *
 * PRINSIP IDENTITAS: setiap pesan disimpan dengan `chatId` = JID ASLI dari WhatsApp
 * (bisa @s.whatsapp.net, @lid, atau @g.us) apa adanya, tanpa dinormalisasi/ditebak
 * jadi nomor telepon. Percakapan (conversation) dikelompokkan berdasarkan `chatId`
 * ini, BUKAN berdasarkan nomor telepon.
 */
class MessageStore {
  constructor(maxItems = config.maxMessagesInMemory) {
    this.maxItems = maxItems;
    this.messages = []; // urutan: terlama -> terbaru, seluruh chat tercampur
  }

  add(message) {
    this.messages.push(message);
    if (this.messages.length > this.maxItems) {
      this.messages.shift();
    }
    return message;
  }

  getRecent(limit = this.maxItems) {
    const n = Math.min(limit, this.messages.length);
    return this.messages.slice(this.messages.length - n).reverse(); // terbaru dulu
  }

  /**
   * Ambil pesan milik SATU chatId saja (perbandingan string exact, case-sensitive,
   * tidak ada normalisasi). Ini yang menjamin isolasi antar conversation.
   */
  getByChatId(chatId, limit = this.maxItems) {
    const filtered = this.messages.filter((m) => m.chatId === chatId);
    const n = Math.min(limit, filtered.length);
    return filtered.slice(filtered.length - n); // urutan kronologis lama -> baru, cocok untuk tampilan chat
  }

  /**
   * Bentuk daftar conversation dari seluruh pesan yang tersimpan, dikelompokkan
   * berdasarkan chatId (JID asli). Satu entri per chatId, berisi info pesan
   * terakhir untuk ditampilkan di daftar chat pada dashboard.
   */
  listConversations() {
    const byChatId = new Map();

    for (const m of this.messages) {
      if (!m.chatId) continue; // pesan tanpa chatId (seharusnya tidak terjadi) diabaikan dari daftar
      const existing = byChatId.get(m.chatId);
      if (!existing || new Date(m.timestamp) >= new Date(existing.lastTimestamp)) {
        byChatId.set(m.chatId, {
          chatId: m.chatId,
          jidType: m.jidType || null,
          name: !m.fromMe ? m.sender?.name || existing?.name || null : existing?.name || null,
          phone: !m.fromMe ? (m.sender?.phone ?? existing?.phone ?? null) : (existing?.phone ?? null),
          lastMessageText: m.text,
          lastTimestamp: m.timestamp,
          lastFromMe: m.fromMe,
        });
      }
    }

    return Array.from(byChatId.values()).sort(
      (a, b) => new Date(b.lastTimestamp) - new Date(a.lastTimestamp)
    );
  }

  clear() {
    this.messages = [];
  }
}

module.exports = new MessageStore();
