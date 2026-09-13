'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logging');

/**
 * Reliability buffer untuk pesan MASUK **maupun** pesan KELUAR yang
 * disinkronkan dari device lain (WA Web/HP langsung, fromMe=true),
 * disimpan lokal di Gateway. Ini BUKAN source of truth bisnis -- source
 * of truth ada di aulia_inboxdb (CI4). Buffer ini murni jaminan supaya
 * pesan tidak hilang kalau HTTP ke CI4 gagal/CI4 sedang mati, dan bisa
 * di-retry sampai berhasil terkirim, TANPA membuat duplicate di CI4
 * (idempotensi dijamin oleh wa_message_id, di kedua sisi: UNIQUE di
 * sini, dan cek existsByWaMessageId di CI4).
 *
 * CATATAN NAMA: nama file/class/tabel ("incoming*") adalah peninggalan
 * dari sebelum kolom `direction` ditambahkan (awalnya memang cuma
 * untuk pesan masuk). Sengaja TIDAK di-rename supaya perubahan minimal
 * -- functionality-nya sekarang sudah mencakup dua arah, cukup lihat
 * kolom `direction` di setiap baris.
 *
 * DUA implementasi tersedia, dipilih OTOMATIS saat startup (lihat paling
 * bawah file ini), API publiknya identik (enqueue/getDueEvents/
 * markCompleted/markFailedAttempt/countPending) sehingga
 * incomingDelivery.js tidak perlu tahu/peduli mana yang sedang dipakai:
 *
 * - IncomingBufferSqlite: pakai `better-sqlite3` (native addon). Dipakai
 *   di Gateway desktop (Windows/Linux/Mac dengan Node.js biasa), di
 *   mana native addon bisa di-compile/tersedia prebuilt secara normal.
 *
 * - IncomingBufferJsonFile: murni JavaScript, simpan ke satu file JSON
 *   di disk. Dipakai sebagai FALLBACK otomatis kalau `better-sqlite3`
 *   tidak tersedia -- kasus utamanya adalah build Android (lihat
 *   android/app/src/main/assets/nodejs-project/), di mana native addon
 *   SQLite butuh cross-compile khusus untuk tiap arsitektur HP yang
 *   tidak sepadan untuk sekadar antrian retry kecil ini. Volume data di
 *   sini kecil (antrian pending, bukan arsip permanen), jadi file JSON
 *   lebih dari cukup.
 */

class IncomingBufferSqlite {
  constructor(Database) {
    const dir = path.dirname(config.sqlitePath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(config.sqlitePath);
    this.db.pragma('journal_mode = WAL'); // lebih tahan terhadap crash mendadak

    this._migrate();

    this.insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO incoming_queue
        (wa_message_id, chat_id, jid_type, contact_name, phone, sender_jid,
         message_type, text, media_json, identity_hint_json, message_timestamp,
         direction, status, attempts, next_attempt_at, created_at, updated_at)
      VALUES
        (@wa_message_id, @chat_id, @jid_type, @contact_name, @phone, @sender_jid,
         @message_type, @text, @media_json, @identity_hint_json, @message_timestamp,
         @direction, 'pending', 0, @next_attempt_at, @now, @now)
    `);

    this.getDueStmt = this.db.prepare(`
      SELECT * FROM incoming_queue
      WHERE status IN ('pending', 'failed') AND next_attempt_at <= @now
      ORDER BY id ASC
      LIMIT @limit
    `);

    this.markCompletedStmt = this.db.prepare(`
      UPDATE incoming_queue SET status = 'completed', updated_at = @now WHERE id = @id
    `);

    this.markFailedStmt = this.db.prepare(`
      UPDATE incoming_queue
      SET status = 'failed', attempts = attempts + 1, last_error = @error,
          next_attempt_at = @nextAttemptAt, updated_at = @now
      WHERE id = @id
    `);

    this.countPendingStmt = this.db.prepare(`
      SELECT COUNT(*) AS n FROM incoming_queue WHERE status IN ('pending', 'failed')
    `);

    logger.info('SQLite incoming buffer siap', {
      path: config.sqlitePath,
      pendingSaatStartup: this.countPending(),
    });
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS incoming_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_message_id TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        jid_type TEXT NOT NULL,
        contact_name TEXT,
        phone TEXT,
        sender_jid TEXT,
        message_type TEXT NOT NULL,
        text TEXT,
        message_timestamp TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_incoming_queue_due
        ON incoming_queue (status, next_attempt_at);
    `);

    // Migrasi ringan: kolom `direction` DAN `media_json` ditambahkan
    // belakangan (media_json untuk dukungan gambar/dokumen). Database
    // SQLite yang sudah ada dari sebelumnya belum punya kolom ini --
    // CREATE TABLE IF NOT EXISTS di atas TIDAK akan menambahkannya ke
    // tabel yang sudah ada, jadi perlu dicek manual & ALTER TABLE
    // kalau belum ada. Aman dijalankan berkali-kali (idempotent,
    // dicek dulu sebelum ALTER).
    const columns = this.db.prepare(`PRAGMA table_info(incoming_queue)`).all();
    const columnNames = columns.map((col) => col.name);

    if (!columnNames.includes('direction')) {
      this.db.exec(`ALTER TABLE incoming_queue ADD COLUMN direction TEXT NOT NULL DEFAULT 'incoming'`);
      logger.info('[MIGRASI] kolom direction ditambahkan ke incoming_queue (database SQLite lama).');
    }

    if (!columnNames.includes('media_json')) {
      // TEXT, nullable -- JSON string berisi {mediaType, directPath,
      // mediaKeyBase64, mimetype, fileLength, fileSha256Base64,
      // fileName} untuk pesan image/document. NULL untuk pesan teks.
      this.db.exec(`ALTER TABLE incoming_queue ADD COLUMN media_json TEXT`);
      logger.info('[MIGRASI] kolom media_json ditambahkan ke incoming_queue (database SQLite lama).');
    }

    if (!columnNames.includes('identity_hint_json')) {
      // TEXT, nullable -- Task Group 1.5 (revisi LID-FIRST -> PN-LATER).
      // JSON string berisi {lid: "<jid>@lid"} kalau berhasil di-resolve
      // dari onWhatsApp() untuk pesan jid_type='pn' (lihat
      // connectionManager.js _resolveLidForPhoneJid()). NULL untuk
      // pesan lid/group, atau kalau resolusi gagal/tidak tersedia.
      this.db.exec(`ALTER TABLE incoming_queue ADD COLUMN identity_hint_json TEXT`);
      logger.info('[MIGRASI] kolom identity_hint_json ditambahkan ke incoming_queue (database SQLite lama).');
    }
  }

  /**
   * Simpan 1 event pesan (masuk ATAU keluar-sinkron) ke buffer. Aman
   * dipanggil berkali-kali dengan wa_message_id yang sama -- baris
   * kedua akan diabaikan (INSERT OR IGNORE + UNIQUE constraint).
   *
   * event.direction: 'incoming' (default, pesan asli dari customer)
   * atau 'outgoing' (balasan staff dari WA Web/HP langsung, di luar
   * POS -- fromMe=true di Baileys).
   *
   * event.messageType: 'text' (default) | 'image' | 'document' |
   * 'audio' | 'video'.
   * event.media: untuk 'image'/'document', object referensi lengkap
   * (lihat buildMediaRef() di connectionManager.js, dipakai untuk
   * download ulang on-demand). Untuk 'audio'/'video', cuma metadata
   * ringan ({mimetype, fileLength}, TANPA referensi download -- binary-
   * nya tidak pernah diambil sama sekali, lihat _handleIncomingMessage()).
   * null untuk teks.
   */
  enqueue(event) {
    const now = new Date().toISOString();
    this.insertStmt.run({
      wa_message_id: event.messageId,
      chat_id: event.chatId,
      jid_type: event.jidType,
      contact_name: event.sender?.name ?? null,
      phone: event.sender?.phone ?? null,
      sender_jid: event.sender?.jid ?? null,
      message_type: event.messageType || 'text',
      text: event.text,
      media_json: event.media ? JSON.stringify(event.media) : null,
      identity_hint_json: event.identityHint ? JSON.stringify(event.identityHint) : null,
      message_timestamp: event.timestamp,
      direction: event.direction === 'outgoing' ? 'outgoing' : 'incoming',
      next_attempt_at: now, // langsung boleh dicoba kirim saat itu juga
      now,
    });
  }

  /** Ambil event yang sudah waktunya dicoba kirim (pending atau failed yang sudah lewat backoff-nya). */
  getDueEvents(limit = 20) {
    return this.getDueStmt.all({ now: new Date().toISOString(), limit });
  }

  markCompleted(id) {
    this.markCompletedStmt.run({ id, now: new Date().toISOString() });
  }

  markFailedAttempt(id, attempts, errorMessage) {
    const { initialDelayMs, maxDelayMs, backoffFactor } = config.deliveryRetry;
    const delayMs = Math.min(initialDelayMs * Math.pow(backoffFactor, attempts), maxDelayMs);
    const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();

    this.markFailedStmt.run({
      id,
      error: String(errorMessage).slice(0, 1000),
      nextAttemptAt,
      now: new Date().toISOString(),
    });

    return { delayMs, nextAttemptAt };
  }

  countPending() {
    return this.countPendingStmt.get().n;
  }

  close() {
    this.db.close();
  }
}

/**
 * Implementasi fallback murni JavaScript (tanpa native addon apa pun),
 * dipakai kalau `better-sqlite3` tidak tersedia (lihat komentar di
 * puncak file). Satu file JSON di disk (config.sqlitePath, dengan
 * ekstensi diganti .json), ditulis ulang UTUH setiap kali ada
 * perubahan -- cukup untuk volume antrian retry yang kecil, TIDAK
 * cocok untuk data besar/query kompleks (memang bukan tujuannya).
 *
 * Penulisan pakai pola write-to-temp-then-rename supaya file tidak
 * pernah dalam keadaan setengah tertulis kalau proses/app tiba-tiba
 * mati (mis. Android mematikan proses) di tengah penulisan.
 */
class IncomingBufferJsonFile {
  constructor() {
    const dir = path.dirname(config.sqlitePath);
    fs.mkdirSync(dir, { recursive: true });

    this.filePath = config.sqlitePath.replace(/\.sqlite$/i, '') + '.json';
    this.nextId = 1;
    this.rows = [];

    this._load();

    logger.info('JSON incoming buffer siap (fallback, better-sqlite3 tidak tersedia)', {
      path: this.filePath,
      pendingSaatStartup: this.countPending(),
    });
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        this.rows = Array.isArray(parsed.rows) ? parsed.rows : [];
        this.nextId = Number.isFinite(parsed.nextId) ? parsed.nextId : this._computeNextId();
      }
    } catch (err) {
      // File korup/tidak terbaca -- jangan crash, mulai dari kosong.
      // Lebih baik kehilangan antrian retry lama daripada Gateway tidak
      // bisa start sama sekali.
      logger.error('Gagal membaca file JSON incoming buffer, memulai dari kosong', { error: err.message });
      this.rows = [];
      this.nextId = 1;
    }
  }

  _computeNextId() {
    return this.rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
  }

  _persist() {
    // Buang event 'completed' yang sudah cukup lama (30 hari) supaya file
    // ini tidak terus membesar tanpa batas selama uptime HP yang panjang
    // -- SQLite (indexed) tidak butuh ini, tapi file JSON dibaca/ditulis
    // UTUH tiap operasi, jadi ukurannya perlu dijaga.
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    this.rows = this.rows.filter((row) => {
      if (row.status !== 'completed') return true;
      return new Date(row.updated_at).getTime() > cutoff;
    });

    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ nextId: this.nextId, rows: this.rows }));
    fs.renameSync(tmpPath, this.filePath);
  }

  enqueue(event) {
    if (this.rows.some((row) => row.wa_message_id === event.messageId)) {
      return; // INSERT OR IGNORE -- sudah pernah tercatat, abaikan (idempoten)
    }

    const now = new Date().toISOString();
    this.rows.push({
      id: this.nextId++,
      wa_message_id: event.messageId,
      chat_id: event.chatId,
      jid_type: event.jidType,
      contact_name: event.sender?.name ?? null,
      phone: event.sender?.phone ?? null,
      sender_jid: event.sender?.jid ?? null,
      message_type: event.messageType || 'text',
      text: event.text,
      media_json: event.media ? JSON.stringify(event.media) : null,
      identity_hint_json: event.identityHint ? JSON.stringify(event.identityHint) : null,
      message_timestamp: event.timestamp,
      direction: event.direction === 'outgoing' ? 'outgoing' : 'incoming',
      status: 'pending',
      attempts: 0,
      last_error: null,
      next_attempt_at: now,
      created_at: now,
      updated_at: now,
    });
    this._persist();
  }

  getDueEvents(limit = 20) {
    const now = new Date().toISOString();
    return this.rows
      .filter((row) => (row.status === 'pending' || row.status === 'failed') && row.next_attempt_at <= now)
      .sort((a, b) => a.id - b.id)
      .slice(0, limit);
  }

  markCompleted(id) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    row.status = 'completed';
    row.updated_at = new Date().toISOString();
    this._persist();
  }

  markFailedAttempt(id, attempts, errorMessage) {
    const { initialDelayMs, maxDelayMs, backoffFactor } = config.deliveryRetry;
    const delayMs = Math.min(initialDelayMs * Math.pow(backoffFactor, attempts), maxDelayMs);
    const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();

    const row = this.rows.find((r) => r.id === id);
    if (row) {
      row.status = 'failed';
      row.attempts += 1;
      row.last_error = String(errorMessage).slice(0, 1000);
      row.next_attempt_at = nextAttemptAt;
      row.updated_at = new Date().toISOString();
      this._persist();
    }

    return { delayMs, nextAttemptAt };
  }

  countPending() {
    return this.rows.filter((row) => row.status === 'pending' || row.status === 'failed').length;
  }

  close() {
    // no-op -- tidak ada handle yang perlu ditutup untuk file biasa.
  }
}

let instance;
try {
  // eslint-disable-next-line global-require
  const Database = require('better-sqlite3');
  instance = new IncomingBufferSqlite(Database);
} catch (err) {
  logger.warn('better-sqlite3 tidak tersedia, memakai fallback JSON file untuk incoming buffer.', {
    error: err.message,
  });
  instance = new IncomingBufferJsonFile();
}

process.on('exit', () => {
  try {
    instance.close();
  } catch (err) {
    // abaikan saat shutdown
  }
});

module.exports = instance;
