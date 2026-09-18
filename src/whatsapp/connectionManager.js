'use strict';

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  downloadContentFromMessage,
} = require('baileys');

const config = require('../config');
const logger = require('../logging');
const messageStore = require('./messageStore');
const incomingBuffer = require('../store/incomingBuffer');
const { jidToPhone } = require('./normalize');
const { classifyJid, isDecodableJid, extractPhoneIfAvailable } = require('./jidUtils');

const VALID_STATUSES = [
  'disconnected',
  'connecting',
  'connected',
  'reconnecting',
  'logged_out',
  'error',
];

/**
 * ConnectionManager bertanggung jawab penuh atas lifecycle koneksi WhatsApp:
 * - membuat/menutup socket Baileys
 * - menyimpan & memuat auth state
 * - mengelola status, QR terbaru, dan metadata koneksi
 * - reconnect dengan backoff
 * - memastikan tidak ada duplicate socket/listener yang aktif bersamaan
 */
class ConnectionManager {
  constructor() {
    this.sock = null;
    this.status = 'disconnected';
    this.qr = null; // raw QR string terbaru (null jika tidak ada/expired)
    this.qrDataUrl = null; // versi data:image untuk ditampilkan di dashboard
    this.connectedNumber = null;
    this.lastConnectedAt = null;
    this.lastDisconnectedAt = null;
    this.lastDisconnectReason = null;

    this.saveCreds = null;

    // Generation counter untuk mencegah event handler dari socket lama
    // memengaruhi state setelah socket baru dibuat (mencegah duplicate listener effect).
    this.generation = 0;

    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.isShuttingDown = false;
    this.isStarting = false; // mencegah start() dipanggil bersamaan (double start)

    // Cache in-memory (hilang saat restart, sengaja -- bukan sumber
    // kebenaran, cuma menghindari query onWhatsApp() berulang-ulang ke
    // server WhatsApp untuk nomor yang sama) untuk hasil resolusi LID
    // dari sebuah PN JID -- lihat _resolveLidForPhoneJid(). Key: JID PN
    // (string), Value: JID LID hasil resolve (string) ATAU null kalau
    // tidak ada/gagal.
    this._lidResolutionCache = new Map();
  }

  getStatusSnapshot() {
    return {
      status: this.status,
      connectedNumber: this.connectedNumber,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastDisconnectReason: this.lastDisconnectReason,
      hasQr: Boolean(this.qr),
    };
  }

  getQr() {
    if (!this.qr) return null;
    return { qr: this.qr, qrDataUrl: this.qrDataUrl };
  }

  setStatus(newStatus, extra = {}) {
    if (!VALID_STATUSES.includes(newStatus)) {
      logger.warn(`Status tidak dikenal diabaikan: ${newStatus}`);
      return;
    }
    this.status = newStatus;
    logger.info(`Status koneksi berubah menjadi: ${newStatus}`, extra);
  }

  async start() {
    if (this.isStarting) {
      logger.warn('start() dipanggil saat proses start lain sedang berjalan, diabaikan.');
      return;
    }
    this.isStarting = true;
    try {
      await this._connect();
    } finally {
      this.isStarting = false;
    }
  }

  async _connect() {
    // Naikkan generation SEBELUM membuat socket baru.
    // Semua event handler socket lama akan mengecek generation ini dan
    // tidak melakukan apa-apa jika sudah bukan generation aktif.
    this.generation += 1;
    const myGeneration = this.generation;

    // Tutup socket lama jika masih ada, untuk mencegah duplicate socket.
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        this.sock.end(undefined);
      } catch (err) {
        logger.warn('Gagal menutup socket lama dengan bersih', { error: err.message });
      }
      this.sock = null;
    }

    fs.mkdirSync(config.authFolder, { recursive: true });

    this.setStatus('connecting');
    this.qr = null;
    this.qrDataUrl = null;

    const { state, saveCreds } = await useMultiFileAuthState(config.authFolder);
    this.saveCreds = saveCreds;

    let version;
    try {
      const versionInfo = await fetchLatestBaileysVersion();
      version = versionInfo.version;
      logger.info(`Menggunakan versi WhatsApp Web: ${version.join('.')} (isLatest: ${versionInfo.isLatest})`);
    } catch (err) {
      logger.warn('Gagal mengambil versi WA terbaru, menggunakan versi default Baileys', {
        error: err.message,
      });
    }

    const sock = makeWASocket({
      version,
      logger: logger.raw.child({ module: 'baileys' }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger.raw.child({ module: 'baileys-keys' })),
      },
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.sock = sock;

    sock.ev.on('creds.update', this.saveCreds);

    sock.ev.on('connection.update', (update) => this._onConnectionUpdate(update, myGeneration));

    sock.ev.on('messages.upsert', (payload) => this._onMessagesUpsert(payload, myGeneration));
  }

  async _onConnectionUpdate(update, myGeneration) {
    if (myGeneration !== this.generation) {
      // Event ini berasal dari socket generasi lama, abaikan agar tidak
      // menyebabkan efek ganda (mis. reconnect dobel).
      return;
    }

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.qr = qr;
      try {
        this.qrDataUrl = await QRCode.toDataURL(qr);
      } catch (err) {
        logger.error('Gagal membuat QR data URL', { error: err.message });
      }
      logger.info('QR code baru dihasilkan, silakan scan dari dashboard.');
    }

    if (connection === 'connecting') {
      this.setStatus('connecting');
    }

    if (connection === 'open') {
      this.reconnectAttempts = 0;
      this.qr = null;
      this.qrDataUrl = null;
      this.connectedNumber = jidToPhone(this.sock?.user?.id) || null;
      this.lastConnectedAt = new Date().toISOString();
      this.lastDisconnectReason = null;
      this.setStatus('connected', { number: this.connectedNumber });
    }

    if (connection === 'close') {
      this.lastDisconnectedAt = new Date().toISOString();

      const statusCode = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : lastDisconnect?.error?.output?.statusCode;

      const reasonText = lastDisconnect?.error?.message || 'unknown';
      this.lastDisconnectReason = `${statusCode || 'no-code'}: ${reasonText}`;

      logger.warn('Koneksi WhatsApp terputus', {
        statusCode,
        reason: reasonText,
      });

      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      if (isLoggedOut) {
        this.setStatus('logged_out');
        this.connectedNumber = null;
        logger.error('WhatsApp logout terdeteksi. Session tidak valid, perlu scan QR ulang.');
        // Tidak auto-reconnect setelah logout: harus reset session dulu via /api/logout
        // supaya operator sadar dan melakukan scan QR baru secara sengaja.
        return;
      }

      if (this.isShuttingDown) {
        this.setStatus('disconnected');
        return;
      }

      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    this.setStatus('reconnecting');

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const { initialDelayMs, maxDelayMs, backoffFactor } = config.reconnect;
    const delay = Math.min(
      initialDelayMs * Math.pow(backoffFactor, this.reconnectAttempts),
      maxDelayMs
    );
    this.reconnectAttempts += 1;

    logger.info(`Menjadwalkan reconnect percobaan ke-${this.reconnectAttempts} dalam ${delay}ms`);

    this.reconnectTimer = setTimeout(() => {
      if (this.isShuttingDown) return;
      this._connect().catch((err) => {
        logger.error('Gagal melakukan reconnect', { error: err.message });
        this.setStatus('error');
        this._scheduleReconnect();
      });
    }, delay);
  }

  /**
   * Reconnect manual dipicu dari dashboard/API (mis. tombol "Reconnect").
   * Membatalkan jadwal reconnect otomatis yang sedang berjalan lalu connect ulang segera.
   */
  async manualReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    logger.info('Reconnect manual dipicu dari dashboard/API.');
    await this._connect();
  }

  /**
   * Logout dari WhatsApp dan hapus folder session, sehingga QR baru
   * akan diminta pada koneksi berikutnya. Dipakai untuk kebutuhan testing.
   */
  async logout() {
    logger.info('Logout/reset session diminta.');

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.generation += 1; // pastikan socket lama tidak lagi memicu apa pun

    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (err) {
        logger.warn('sock.logout() gagal (mungkin memang sudah tidak connected)', {
          error: err.message,
        });
      }
      try {
        this.sock.ev.removeAllListeners();
        this.sock.end(undefined);
      } catch (err) {
        // abaikan
      }
      this.sock = null;
    }

    try {
      if (fs.existsSync(config.authFolder)) {
        fs.rmSync(config.authFolder, { recursive: true, force: true });
      }
    } catch (err) {
      logger.error('Gagal menghapus folder auth saat logout', { error: err.message });
    }

    this.connectedNumber = null;
    this.qr = null;
    this.qrDataUrl = null;
    this.lastDisconnectReason = 'manual logout';
    this.lastDisconnectedAt = new Date().toISOString();
    this.reconnectAttempts = 0;
    this.setStatus('disconnected');

    // Langsung mulai koneksi baru supaya QR baru muncul di dashboard tanpa restart aplikasi.
    await this._connect();
  }

  async _onMessagesUpsert({ messages, type }, myGeneration) {
    if (myGeneration !== this.generation) return;
    if (type !== 'notify') return; // hanya proses pesan baru real-time

    for (const msg of messages) {
      try {
        // await SATU per SATU (bukan Promise.all) -- _handleIncomingMessage
        // sekarang bisa melakukan 1 query jaringan (onWhatsApp(), lihat
        // _resolveLidForPhoneJid()) untuk pesan PN pertama dari sebuah
        // nomor. Diproses berurutan supaya tidak membanjiri koneksi
        // WhatsApp dengan query paralel kalau banyak pesan masuk sekaligus.
        await this._handleIncomingMessage(msg);
      } catch (err) {
        // Satu pesan gagal diproses tidak boleh menjatuhkan gateway.
        logger.error('Gagal memproses satu pesan masuk, dilewati', { error: err.message });
      }
    }
  }

  /**
   * Task Group 1.5 (revisi LID-FIRST -> PN-LATER): minta WhatsApp SENDIRI
   * (lewat USync query resmi `sock.onWhatsApp()`, BUKAN tebakan client)
   * memberi tahu JID @lid yang berkaitan dengan sebuah nomor PN asli.
   * Query ini SATU ARAH SAJA (PN -> LID) -- library yang dipakai (Baileys
   * versi terinstall) TIDAK punya mekanisme sebaliknya (LID -> PN), jadi
   * fungsi ini TIDAK PERNAH dipanggil dengan JID @lid sebagai input (lihat
   * pemanggil di _handleIncomingMessage -- hanya untuk pesan jid_type='pn').
   *
   * BEST-EFFORT & NON-FATAL: kalau belum connected, query gagal/timeout,
   * atau server tidak mengembalikan LID (banyak akun tidak punya LID sama
   * sekali), fungsi ini cukup mengembalikan null -- TIDAK PERNAH melempar
   * ke pemanggil, TIDAK PERNAH menahan/menggagalkan pemrosesan pesan itu
   * sendiri.
   *
   * Di-cache in-memory per JID PN supaya tidak query berulang-ulang ke
   * server WhatsApp untuk nomor yang sama setiap kali dia kirim pesan.
   *
   * CATATAN KEJUJURAN: signature/perilaku `sock.onWhatsApp()` diverifikasi
   * LANGSUNG dari source code Baileys yang ter-install (lib/Socket/chats.js
   * + lib/WAUSync/Protocols/UsyncLIDProtocol.js) -- BUKAN ditebak dari
   * dokumentasi/memori. TAPI belum pernah dipanggil terhadap koneksi
   * WhatsApp SUNGGUHAN di lingkungan pengembangan ini (tidak ada akses
   * jaringan ke server WhatsApp) -- format PERSIS nilai `lid` yang
   * dikembalikan server BELUM diverifikasi live, karena itu hasilnya
   * dinormalisasi defensif (ditambahkan "@lid" kalau belum ada) dan WAJIB
   * diverifikasi ulang begitu ada koneksi nyata (lihat
   * docs/aturan-bisnis-CHAT.md Section 12).
   *
   * @param {string} phoneJid JID PN asli (@s.whatsapp.net), BUKAN @lid.
   * @returns {Promise<string|null>} JID @lid yang berkaitan, atau null.
   */
  async _resolveLidForPhoneJid(phoneJid) {
    if (this._lidResolutionCache.has(phoneJid)) {
      return this._lidResolutionCache.get(phoneJid);
    }

    let resolvedLid = null;

    if (this.isConnected()) {
      try {
        const results = await this.sock.onWhatsApp(phoneJid);
        const match = Array.isArray(results) ? results.find((r) => r?.lid) : null;

        if (match?.lid) {
          const rawLid = String(match.lid);
          // Normalisasi defensif -- lihat catatan kejujuran di atas.
          resolvedLid = rawLid.includes('@') ? rawLid : `${rawLid}@lid`;
        }
      } catch (err) {
        logger.debug('[IDENTITY] gagal resolve LID untuk PN via onWhatsApp() (non-fatal, dilewati)', {
          phoneJid,
          error: err.message,
        });
      }
    }

    this._lidResolutionCache.set(phoneJid, resolvedLid);
    return resolvedLid;
  }

  async _handleIncomingMessage(msg) {
    if (!msg.message) return; // pesan protokol/kosong (mis. reaction, receipt), abaikan untuk POC

    // "Status" WhatsApp (Stories) bukan chat sama sekali -- JID-nya selalu
    // literal "status@broadcast". Difilter di titik PALING AWAL, sebelum
    // diproses/di-log sama sekali, supaya tidak pernah nyasar jadi
    // conversation/pesan di Inbox POS.
    if (msg.key?.remoteJid === 'status@broadcast') {
      return;
    }

    let messageType = 'text';
    let text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      null;
    let media = null;

    if (text === null) {
      // Bukan pesan teks biasa -- cek apakah gambar/dokumen/audio/video
      // (didukung), selain itu (sticker/lokasi/kontak/dst) di luar scope
      // untuk sekarang, cukup di-log & dilewati.
      const imageMsg = msg.message.imageMessage;
      const documentMsg = msg.message.documentMessage;
      const audioMsg = msg.message.audioMessage;
      const videoMsg = msg.message.videoMessage;

      if (imageMsg) {
        messageType = 'image';
        text = imageMsg.caption || null;
        media = buildMediaRef(imageMsg, 'image', null);

        if (!media) {
          // directPath/mediaKey tidak lengkap -- pesan media ini tidak
          // bisa didekripsi nanti, tidak ada gunanya diteruskan.
          logger.warn('Pesan media diterima tapi referensi tidak lengkap (directPath/mediaKey kosong), dilewati', {
            messageId: msg.key?.id,
            messageType,
          });
          return;
        }
      } else if (documentMsg) {
        messageType = 'document';
        text = documentMsg.caption || null;
        media = buildMediaRef(documentMsg, 'document', documentMsg.fileName || null);

        if (!media) {
          logger.warn('Pesan media diterima tapi referensi tidak lengkap (directPath/mediaKey kosong), dilewati', {
            messageId: msg.key?.id,
            messageType,
          });
          return;
        }
      } else if (audioMsg || videoMsg) {
        // Audio (termasuk voice note/PTT -- dianggap audio biasa, TIDAK
        // ada tipe/business logic terpisah) dan video: BEDA PRINSIP dari
        // image/document -- binary-nya TIDAK PERNAH diambil sama sekali
        // (bukan cuma "tidak disimpan", tapi memang tidak pernah
        // didownload/didekripsi baik di Gateway maupun di AuliaPos), jadi
        // TIDAK PERLU directPath/mediaKey/buildMediaRef() sama sekali --
        // cukup metadata ringan (mimetype + ukuran) buat ditampilkan di
        // Inbox POS sebagai placeholder ("cek WhatsApp Web").
        const mediaMsg = audioMsg || videoMsg;
        messageType = audioMsg ? 'audio' : 'video';
        // audioMessage tidak punya caption (WhatsApp tidak mengizinkan
        // caption pada voice note/audio); videoMessage punya.
        text = mediaMsg.caption || null;
        media = {
          mimetype: mediaMsg.mimetype || null,
          fileLength: mediaMsg.fileLength ? Number(mediaMsg.fileLength) : null,
        };
      } else {
        logger.debug('Melewati pesan yang belum didukung (bukan teks/gambar/dokumen/audio/video)', {
          messageId: msg.key?.id,
          type: Object.keys(msg.message)[0],
        });
        return;
      }
    }

    // chatId = JID ASLI dari WhatsApp, apa adanya. Ini identitas conversation,
    // BUKAN nomor telepon -- terutama penting untuk kasus @lid.
    const remoteJid = msg.key?.remoteJid || null;
    const fromMe = Boolean(msg.key?.fromMe);
    // pushName untuk fromMe:true adalah nama profil AKUN SENDIRI (staff
    // balas dari WA Web/HP), BUKAN nama customer -- jangan pernah
    // diteruskan sebagai identitas customer ke AuliaPos. AuliaPos akan
    // skip update whatsapp_name kalau nilainya null (lihat
    // InboxGatewayApi::messages() di sisi AuliaPos), jadi nama customer
    // yang sudah benar sebelumnya tidak akan tertimpa.
    const senderName = fromMe ? null : (msg.pushName || null);
    const jidType = classifyJid(remoteJid);

    // PRINSIP IDENTITAS: nomor telepon hanya diisi jika JID memang benar-benar
    // personal number (@s.whatsapp.net). Untuk @lid/@g.us/lainnya, phone = null.
    // Angka di depan "@lid" TIDAK PERNAH diperlakukan sebagai nomor telepon.
    const phone = extractPhoneIfAvailable(remoteJid);

    // Task Group 1.5 (revisi LID-FIRST -> PN-LATER): kalau pesan ini dari
    // JID PN asli, tanya WhatsApp (lewat onWhatsApp(), lihat
    // _resolveLidForPhoneJid()) apakah nomor ini punya JID @lid yang
    // berkaitan. HANYA untuk jidType==='pn' -- TIDAK PERNAH dipanggil
    // untuk @lid/@g.us (tidak ada gunanya/tidak didukung library, lihat
    // docblock _resolveLidForPhoneJid()). identityHint dikirim ke CI4
    // sebagai metadata TAMBAHAN saja -- AuliaPos yang memutuskan mau
    // dipakai untuk apa (business logic tetap di AuliaPos, Gateway cuma
    // transport+metadata).
    const identityHint = jidType === 'pn'
      ? { lid: await this._resolveLidForPhoneJid(remoteJid) }
      : null;

    const normalized = {
      messageId: msg.key?.id || null,
      chatId: remoteJid,
      jidType,
      sender: {
        jid: remoteJid,
        phone,
        name: senderName,
      },
      text,
      messageType,
      media,
      identityHint: identityHint?.lid ? identityHint : null,
      timestamp: msg.messageTimestamp
        ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
        : new Date().toISOString(),
      fromMe,
    };

    messageStore.add(normalized);

    // Diteruskan ke CI4 untuk KEDUA arah:
    // - fromMe=false (pesan asli dari customer) -> direction='incoming'
    // - fromMe=true (staff balas langsung dari WA Web/HP, di luar POS)
    //   -> direction='outgoing', TANPA identitas staff (Baileys tidak
    //   tahu staff mana yang balas dari HP-nya sendiri) -- CI4 akan
    //   simpan dengan sent_by_user_id NULL. Ini supaya Inbox POS tetap
    //   merefleksikan kenyataan percakapan walau balasannya tidak
    //   lewat POS, mencegah kasir lain mengira belum dibalas dan
    //   balas dobel.
    try {
      incomingBuffer.enqueue({
        ...normalized,
        direction: fromMe ? 'outgoing' : 'incoming',
      });
    } catch (err) {
      // Gagal simpan ke SQLite tidak boleh menjatuhkan proses penerimaan
      // pesan WhatsApp itu sendiri -- cukup log sekeras mungkin karena ini
      // berarti pesan BERISIKO tidak sampai ke POS.
      logger.error('[DELIVERY] GAGAL menyimpan pesan ke SQLite buffer -- pesan ini berisiko tidak sampai ke POS', {
        messageId: normalized.messageId,
        direction: fromMe ? 'outgoing' : 'incoming',
        error: err.message,
      });
    }

    logger.info('[CHAT] pesan masuk diterima', {
      chatId: normalized.chatId,
      jidType,
    });
    logger.info(`Pesan ${fromMe ? 'keluar (sinkron dari device lain)' : 'masuk'} diterima`, {
      messageId: normalized.messageId,
      chatId: normalized.chatId,
      jidType,
      phone: normalized.sender.phone,
    });
  }

  isConnected() {
    return this.status === 'connected' && Boolean(this.sock);
  }

  /**
   * Kirim pesan teks ke SEBUAH JID, apa adanya, tanpa normalisasi/tebakan apa pun.
   * `jid` di sini boleh berupa @s.whatsapp.net, @lid, atau @g.us -- fungsi ini
   * hanya meneruskan ke sock.sendMessage() milik Baileys, yang memang mendukung
   * ketiga jenis JID tersebut secara resmi (lihat relayMessage di Baileys, yang
   * punya cabang eksplisit untuk server === 'lid').
   *
   * Melempar Error dengan pesan yang jelas jika gagal.
   */
  async sendTextMessage(jid, text) {
    if (!this.isConnected()) {
      const err = new Error('WhatsApp belum connected, tidak bisa mengirim pesan');
      err.code = 'NOT_CONNECTED';
      throw err;
    }

    const jidType = classifyJid(jid);
    logger.info('[SEND] mengirim pesan keluar', { targetJid: jid, jidType });

    try {
      const result = await this.sock.sendMessage(jid, { text });
      logger.info('[SEND] pesan berhasil dikirim', {
        targetJid: jid,
        jidType,
        messageId: result?.key?.id,
      });
      return {
        messageId: result?.key?.id || null,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      logger.error('[SEND] gagal mengirim pesan', { targetJid: jid, jidType, error: err.message });
      const wrapped = new Error(`Gagal mengirim pesan: ${err.message}`);
      wrapped.code = 'SEND_FAILED';
      throw wrapped;
    }
  }

  /**
   * Balas SATU conversation berdasarkan chatId (JID asli conversation tersebut,
   * bisa @s.whatsapp.net ATAU @lid ATAU @g.us). Ini jalur khusus untuk fitur
   * "Balas" di dashboard -- BERBEDA dari endpoint /api/messages/send lama yang
   * menerima input nomor telepon bebas dan menormalisasinya sendiri.
   *
   * ATURAN KERAS: chatId di sini TIDAK PERNAH melalui normalizeToJid()/jidToPhone()
   * untuk menentukan tujuan pengiriman. chatId dikirim persis apa adanya ke Baileys.
   */
  async sendReply(chatId, text) {
    if (!isDecodableJid(chatId)) {
      const err = new Error(`chatId tidak valid/tidak dapat didecode sebagai JID: ${chatId}`);
      err.code = 'INVALID_CHAT_ID';
      throw err;
    }

    const jidType = classifyJid(chatId);
    logger.info('[CHAT] balasan diminta untuk conversation', { chatId, jidType });

    const result = await this.sendTextMessage(chatId, text);

    // Simpan pesan keluar ke conversation yang SAMA (berdasarkan chatId persis sama),
    // supaya langsung terlihat di history chat yang sedang dibuka di dashboard.
    messageStore.add({
      messageId: result.messageId,
      chatId,
      jidType,
      sender: {
        jid: this.sock?.user?.id || null,
        phone: jidToPhone(this.sock?.user?.id) || null,
        name: 'Gateway (akun sendiri)',
      },
      text,
      timestamp: result.timestamp,
      fromMe: true,
    });

    return result;
  }

  /**
   * Kirim SATU pesan media (gambar/dokumen) ke sebuah JID, apa adanya, tanpa
   * normalisasi/tebakan -- versi media dari sendTextMessage(). `jid` di sini
   * boleh berupa @s.whatsapp.net, @lid, atau @g.us, sama seperti sendTextMessage().
   *
   * PRINSIP SAMA seperti media MASUK: Gateway TIDAK PERNAH menyimpan file media
   * ke disk. `buffer` yang diterima di sini hanya dipegang di memory selama
   * pemanggilan function ini (diteruskan langsung ke Baileys), tidak pernah
   * disimpan ke property instance mana pun.
   *
   * @param {string} jid
   * @param {'image'|'document'} mediaType
   * @param {Buffer} buffer
   * @param {{ caption?: string, mimetype?: string, fileName?: string }} [options]
   */
  async sendMediaMessage(jid, mediaType, buffer, options = {}) {
    if (!this.isConnected()) {
      const err = new Error('WhatsApp belum connected, tidak bisa mengirim pesan');
      err.code = 'NOT_CONNECTED';
      throw err;
    }

    const jidType = classifyJid(jid);
    const { caption, mimetype, fileName } = options;

    let content;
    if (mediaType === 'image') {
      content = { image: buffer, caption: caption || undefined, mimetype: mimetype || 'image/jpeg' };
    } else if (mediaType === 'document') {
      content = {
        document: buffer,
        mimetype: mimetype || 'application/octet-stream',
        fileName: fileName || 'file',
        caption: caption || undefined,
      };
    } else {
      const err = new Error(`mediaType tidak dikenal: ${mediaType}`);
      err.code = 'INVALID_MEDIA_TYPE';
      throw err;
    }

    logger.info('[SEND] mengirim pesan media keluar', {
      targetJid: jid,
      jidType,
      mediaType,
      ukuranByte: buffer.length,
    });

    try {
      const result = await this.sock.sendMessage(jid, content);

      // Setelah upload sukses, message yang dikembalikan Baileys SUDAH berisi
      // directPath/mediaKey asli dari server WhatsApp untuk file yang baru
      // saja diunggah -- sama persis strukturnya dengan imageMessage/
      // documentMessage pada pesan MASUK. Diekstrak dengan buildMediaRef()
      // yang sama supaya media KELUAR ini juga bisa diambil ulang nanti
      // (mis. dibuka lagi dari Inbox POS) lewat alur downloadMediaByRef()
      // yang sudah ada, TANPA perlu menyimpan file apa pun di sini.
      const sentMediaMessage = mediaType === 'image'
        ? result?.message?.imageMessage
        : result?.message?.documentMessage;
      const mediaRef = buildMediaRef(sentMediaMessage, mediaType, fileName || null);

      logger.info('[SEND] pesan media berhasil dikirim', {
        targetJid: jid,
        jidType,
        mediaType,
        messageId: result?.key?.id,
        mediaRefTersedia: Boolean(mediaRef),
      });
      return {
        messageId: result?.key?.id || null,
        timestamp: new Date().toISOString(),
        mediaRef,
      };
    } catch (err) {
      logger.error('[SEND] gagal mengirim pesan media', {
        targetJid: jid,
        jidType,
        mediaType,
        error: err.message,
      });
      const wrapped = new Error(`Gagal mengirim media: ${err.message}`);
      wrapped.code = 'SEND_FAILED';
      throw wrapped;
    }
  }

  /**
   * Balas SATU conversation dengan media (gambar/dokumen) -- versi media dari
   * sendReply(). chatId di sini SAMA PRINSIPNYA dengan sendReply(): JID asli
   * apa adanya, TIDAK PERNAH melalui normalizeToJid()/jidToPhone().
   *
   * @param {string} chatId
   * @param {'image'|'document'} mediaType
   * @param {Buffer} buffer
   * @param {{ caption?: string, mimetype?: string, fileName?: string }} [options]
   */
  async sendMediaReply(chatId, mediaType, buffer, options = {}) {
    if (!isDecodableJid(chatId)) {
      const err = new Error(`chatId tidak valid/tidak dapat didecode sebagai JID: ${chatId}`);
      err.code = 'INVALID_CHAT_ID';
      throw err;
    }

    const jidType = classifyJid(chatId);
    logger.info('[CHAT] balasan media diminta untuk conversation', { chatId, jidType, mediaType });

    const result = await this.sendMediaMessage(chatId, mediaType, buffer, options);

    // Simpan ke messageStore SEPERTI sendReply(), tapi TANPA menyimpan file
    // media itu sendiri -- cuma metadata (mimetype/fileName/ukuran). Konsisten
    // dengan prinsip "tidak pernah simpan file" yang juga dipakai untuk media
    // MASUK (lihat buildMediaRef(), yang juga cuma menyimpan referensi/metadata).
    messageStore.add({
      messageId: result.messageId,
      chatId,
      jidType,
      sender: {
        jid: this.sock?.user?.id || null,
        phone: jidToPhone(this.sock?.user?.id) || null,
        name: 'Gateway (akun sendiri)',
      },
      text: options.caption || null,
      messageType: mediaType,
      media: {
        mimetype: options.mimetype || null,
        fileName: options.fileName || null,
        fileLength: buffer.length,
      },
      timestamp: result.timestamp,
      fromMe: true,
    });

    // mediaRef (di dalam result) diteruskan apa adanya ke pemanggil
    // (ci4Routes.js) supaya CI4 bisa menyimpannya persis seperti referensi
    // media MASUK -- kalau null (mis. Baileys tidak mengembalikan
    // directPath/mediaKey untuk kasus tertentu), CI4 cukup tidak menyimpan
    // media_metadata untuk pesan ini (bukan error fatal, cuma berarti tidak
    // bisa dibuka ulang nanti).
    return result;
  }

  /**
   * Ambil & dekripsi ulang 1 file media (gambar/dokumen) dari server
   * WhatsApp, ON-DEMAND, berdasarkan referensi yang tersimpan (bukan
   * file yang sudah diunduh sebelumnya -- kita memang tidak pernah
   * menyimpan file-nya, cuma referensi ini, sesuai keputusan desain).
   *
   * Bisa gagal (throw) kalau media sudah "basi"/kadaluarsa di server
   * WhatsApp (biasa terjadi untuk pesan yang cukup lama) -- pemanggil
   * (ci4Routes.js) yang menerjemahkan ini jadi respons error yang
   * jelas ke CI4/browser.
   *
   * @param {{mediaType: 'image'|'document', directPath: string, mediaKeyBase64: string}} mediaRef
   * @returns {Promise<Buffer>}
   */
  async downloadMediaByRef(mediaRef) {
    const mediaKey = Buffer.from(mediaRef.mediaKeyBase64, 'base64');

    const stream = await downloadContentFromMessage(
      { directPath: mediaRef.directPath, mediaKey },
      mediaRef.mediaType
    );

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  }

  async shutdown() {
    this.isShuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        this.sock.end(undefined);
      } catch (err) {
        // abaikan saat shutdown
      }
    }
    logger.info('Gateway shutting down.');
  }
}

/**
 * Ekstrak REFERENSI media (bukan file-nya) dari sebuah imageMessage/
 * documentMessage Baileys -- directPath + mediaKey (base64) + info
 * lain yang cukup untuk mendekripsi ulang NANTI, on-demand, saat
 * kasir benar-benar membuka pesan itu di Inbox POS. File aslinya
 * TIDAK diunduh/didekripsi di sini sama sekali (sesuai keputusan:
 * "cukup simpan referensi, file tetap di WhatsApp").
 *
 * Mengembalikan null kalau directPath/mediaKey tidak ada -- berarti
 * referensinya tidak lengkap, tidak ada gunanya diteruskan (nanti
 * juga tidak akan bisa didekripsi ulang).
 */
function buildMediaRef(mediaMessage, mediaType, fileName) {
  if (!mediaMessage?.directPath || !mediaMessage?.mediaKey) {
    return null;
  }

  return {
    mediaType, // 'image' | 'document' -- dipakai persis sebagai `type` di downloadContentFromMessage() Baileys
    directPath: mediaMessage.directPath,
    mediaKeyBase64: Buffer.from(mediaMessage.mediaKey).toString('base64'),
    mimetype: mediaMessage.mimetype || null,
    fileLength: mediaMessage.fileLength ? Number(mediaMessage.fileLength) : null,
    fileSha256Base64: mediaMessage.fileSha256 ? Buffer.from(mediaMessage.fileSha256).toString('base64') : null,
    fileName,
  };
}

module.exports = new ConnectionManager();
