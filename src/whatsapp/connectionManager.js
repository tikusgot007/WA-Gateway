'use strict';

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { Boom } = require('@hapi/boom');
// baileys di-load lewat baileysLoader.js (dynamic import di-cache), bukan
// require() langsung -- lihat penjelasan lengkap di file itu. ensureBaileysLoaded()
// SUDAH di-await di src/app/index.js sebelum ConnectionManager dipakai, jadi
// getBaileys() di sini aman dipanggil sinkron.
const { getBaileys } = require('./baileysLoader');

const config = require('../config');
const logger = require('../logging');
const messageStore = require('./messageStore');
const incomingBuffer = require('../store/incomingBuffer');
const { enqueueWithRetry } = require('../store/enqueueRetry');
const { EnqueueValidationError } = require('../store/enqueueValidationError');
const { overflowBuffer } = require('../store/overflowBuffer');
const { ownSentRegistry } = require('./ownSentRegistry');
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

    // Alternatif login selain scan QR: pairing code (dipakai terutama
    // ketika Gateway dijalankan di HP YANG SAMA dengan HP yang punya
    // WhatsApp aktif -- lihat requestPairingCode()). null kalau belum
    // pernah diminta / sudah dipakai (connected) / expired karena
    // reconnect baru.
    this.pairingCode = null;
    this.pairingCodeRequestedFor = null;

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

    // M1 Wave 1 TASK-013 (REQ-019): cache NEGATIF untuk KEGAGALAN query LID
    // (timeout/error). Key: JID PN, Value: waktu gagal (ms epoch). Berbeda
    // dari _lidResolutionCache di atas: entri di sini KEDALUWARSA setelah
    // config.lidLookupNegativeTtlMs, supaya kegagalan sesaat tidak membuat JID
    // itu tidak pernah dicoba lagi, tapi pesan-pesan beruntun dari JID yang
    // sama tidak menunggu timeout berulang kali.
    this._lidFailureCache = new Map();

    // Grup Tahap 2 (REQ-002/REQ-003, GUD-001/ASSUMPTION-003): cache in-memory
    // subject grup per JID grup. Key: JID grup (@g.us), Value:
    // { subject: string, fetchedAt: number (ms epoch) }. Dipakai supaya
    // groupMetadata() TIDAK dipanggil di jalur kritis penerimaan tiap pesan;
    // di-refresh hanya saat cache miss atau setelah config.groupNameCacheTtlMs.
    this._groupNameCache = new Map();

    // JID grup yang refresh groupMetadata()-nya sedang berjalan (fire-and-forget).
    // Mencegah banyak pesan beruntun dari grup yang sama memicu query paralel.
    this._groupNameFetchInFlight = new Set();
  }

  getStatusSnapshot() {
    return {
      status: this.status,
      connectedNumber: this.connectedNumber,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastDisconnectReason: this.lastDisconnectReason,
      hasQr: Boolean(this.qr),
      pairingCode: this.pairingCode,
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
    this.pairingCode = null;
    this.pairingCodeRequestedFor = null;

    const {
      default: makeWASocket,
      useMultiFileAuthState,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
    } = getBaileys();

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
      this.pairingCode = null;
      this.pairingCodeRequestedFor = null;
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

      const { DisconnectReason } = getBaileys();
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      if (isLoggedOut) {
        this.setStatus('logged_out');
        this.connectedNumber = null;
        logger.error('WhatsApp logout terdeteksi. Session tidak valid, perlu scan QR ulang.');

        // Bug-fix REQ-001 (plan-bugfix-wa-gateway-pairing-code-logged-out-v1.0):
        // socket ini sudah mati (WebSocket-nya sudah ditutup server WhatsApp),
        // tapi objeknya sendiri masih tersimpan di this.sock kalau tidak
        // dibersihkan di sini -- menyebabkan requestPairingCode() melihat
        // this.sock yang "ada" padahal zombie. Bersihkan dengan pola yang
        // sama seperti logout() (lines 356-370) di bawah.
        if (this.sock) {
          try {
            this.sock.ev.removeAllListeners();
            this.sock.end(undefined);
          } catch (err) {
            // abaikan -- socket memang sudah mati, kegagalan cleanup di sini tidak fatal
          }
          this.sock = null;
        }

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
   * Minta pairing code (alternatif login selain scan QR) untuk nomor
   * tertentu. Dipakai terutama saat Gateway dijalankan di HP YANG SAMA
   * dengan HP yang memegang WhatsApp aktif (app Android) -- scan QR ke
   * layar HP itu sendiri tidak praktis, sedangkan pairing code cukup
   * diketik manual di WhatsApp: Setelan > Perangkat Tertaut > Tautkan
   * dengan nomor telepon.
   *
   * Pembatasan dari Baileys sendiri: hanya bisa diminta SEBELUM device
   * berhasil registered (belum pernah/tidak sedang login), dan idealnya
   * dipanggil sekali per siklus socket -- kalau socket keburu reconnect
   * (mis. karena code sudah expired), operator perlu memicu ulang lewat
   * endpoint ini (pairingCode lama otomatis di-reset di awal _connect()).
   *
   * phoneNumber: format internasional TANPA '+'/spasi/tanda lain,
   * misalnya "62812xxxxxxx".
   */
  async requestPairingCode(phoneNumber) {
    if (typeof phoneNumber !== 'string' || !/^\d{8,15}$/.test(phoneNumber)) {
      throw new Error('Nomor telepon tidak valid. Gunakan format internasional tanpa "+"/spasi/0 di depan, contoh: 62812xxxxxxx.');
    }
    // Bug-fix REQ-002 (plan-bugfix-wa-gateway-pairing-code-logged-out-v1.0):
    // dicek SEBELUM guard !this.sock -- setelah logged_out, this.sock memang
    // sudah di-null-kan (lihat isLoggedOut branch di _onConnectionUpdate()),
    // tapi guard ini tetap fail-fast dengan pesan yang jelas dan spesifik
    // (bukan pesan generik "Koneksi belum siap") supaya operator langsung
    // tahu harus /api/logout dulu, bukan sekadar menunggu lebih lama.
    if (this.status === 'logged_out') {
      throw new Error('Session sudah logout. Panggil /api/logout untuk mereset session sebelum meminta pairing code baru.');
    }
    if (!this.sock) {
      throw new Error('Koneksi belum siap. Tunggu status "connecting" muncul lalu coba lagi.');
    }
    if (this.sock.authState?.creds?.registered) {
      throw new Error('WhatsApp sudah pernah login sebelumnya. Logout/reset session dulu sebelum meminta pairing code baru.');
    }

    const code = await this.sock.requestPairingCode(phoneNumber);
    this.pairingCode = code;
    this.pairingCodeRequestedFor = phoneNumber;
    logger.info('Pairing code baru diminta, silakan masukkan di WhatsApp.', { phoneNumber });
    return code;
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
    this.pairingCode = null;
    this.pairingCodeRequestedFor = null;
    this.lastDisconnectReason = 'manual logout';
    this.lastDisconnectedAt = new Date().toISOString();
    this.reconnectAttempts = 0;
    this.setStatus('disconnected');

    // Langsung mulai koneksi baru supaya QR baru muncul di dashboard tanpa restart aplikasi.
    await this._connect();
  }

  async _onMessagesUpsert({ messages, type }, myGeneration) {
    if (myGeneration !== this.generation) return;
    // M1 Wave 1 TASK-010 (REQ-001, E-01): proses 'notify' (real-time) DAN
    // 'append' (pesan titipan yang WhatsApp kirim ulang setelah Gateway
    // offline). Filter lama `type !== 'notify'` menghilangkan pesan yang tiba
    // saat Gateway mati (terukur hilang 3/14 dan 3/15, spec Bagian 10).
    // Tipe lain diabaikan dengan log debug.
    //
    // Filter 'append' JANGAN dilepas tanpa _shouldAcceptAppend(): Baileys juga
    // memancarkan 'append' untuk kiriman Gateway SENDIRI (ALT-002), jadi tanpa
    // penyaringan setiap balasan kasir masuk ulang sebagai pesan keluar ganda.
    if (type !== 'notify' && type !== 'append') {
      logger.debug('[CHAT] messages.upsert bertipe selain notify/append diabaikan', {
        type,
        jumlah: messages?.length ?? 0,
      });
      return;
    }

    for (const msg of messages) {
      try {
        if (type === 'append' && !this._shouldAcceptAppend(msg)) continue;

        // await SATU per SATU (bukan Promise.all) -- _handleIncomingMessage
        // sekarang bisa melakukan 1 query jaringan (onWhatsApp(), lihat
        // _resolveLidForPhoneJid()) untuk pesan PN pertama dari sebuah
        // nomor. Diproses berurutan supaya tidak membanjiri koneksi
        // WhatsApp dengan query paralel kalau banyak pesan masuk sekaligus.
        await this._handleIncomingMessage(msg);
      } catch (err) {
        // Satu pesan gagal diproses tidak boleh menjatuhkan gateway, dan pesan
        // LAIN dalam batch yang sama tetap diproses (loop lanjut ke pesan
        // berikutnya). M1 Wave 1 TASK-014 (REQ-015, GUD-002): catat cukup
        // konteks untuk melacak pesan mana yang hilang -- ID pesan, JID, dan
        // tipe konten -- karena Baileys sudah mengirim tanda terima sehingga
        // pesan ini TIDAK akan datang lagi.
        logger.error('Gagal memproses satu pesan masuk, dilewati', {
          messageId: msg?.key?.id ?? null,
          jid: msg?.key?.remoteJid ?? null,
          contentType: this._describeContentType(msg),
          upsertType: type,
          error: err.message,
        });
        // E-06 DIREVERT: sempat ditambah fallback yang menyimpan pesan
        // "minimal" (tanpa teks/media) di sini. Plan resmi
        // (plan/plan-process-m1-wave1-incoming-reliability-v1.0.md,
        // ALT-004) menolak eksplisit pendekatan ini -- kontrak AuliaPos
        // menolak event tidak lengkap, jadi pesan minimal jadi poison
        // message yang dicoba ulang tanpa batas. Ditahan ke sekadar log
        // (perilaku lama) sampai dead-letter (gelombang 3 plan resmi) ada.
      }
    }
  }

  /**
   * M1 Wave 1 TASK-014: tipe konten pesan Baileys (kunci pertama `msg.message`,
   * mis. 'conversation', 'imageMessage', 'ephemeralMessage') untuk log error.
   * Tidak pernah melempar: dipanggil DI DALAM catch, jadi kegagalannya sendiri
   * tidak boleh menutupi error asli atau menghentikan batch.
   */
  _describeContentType(msg) {
    try {
      return Object.keys(msg?.message || {})[0] ?? null;
    } catch (err) {
      return null;
    }
  }

  /**
   * M1 Wave 1 TASK-010: penyaring HANYA untuk event bertipe 'append'.
   * Perilaku 'notify' TIDAK melewati fungsi ini dan tidak berubah.
   *
   * 1. Kiriman Gateway sendiri (ID ada di ownSentRegistry) -> dilewati, TIDAK
   *    masuk buffer (REQ-002, D-01).
   * 2. Alamat selain pn/lid/group (mis. channel yang terklasifikasi 'unknown')
   *    -> dilewati dan dicatat info berisi JID + ID pesan (REQ-018, D-04).
   * 3. Sisanya diproses seperti 'notify'; arah incoming/outgoing mengikuti
   *    `fromMe` di _handleIncomingMessage() (REQ-004, termasuk balasan yang
   *    diketik dari HP saat Gateway mati). Duplikat dengan 'notify' aman:
   *    enqueue() idempoten lewat wa_message_id (REQ-005).
   *
   * @returns {boolean} true kalau pesan harus diproses.
   */
  _shouldAcceptAppend(msg) {
    const messageId = msg.key?.id;

    if (messageId && ownSentRegistry.wasSentByUs(messageId)) {
      logger.debug('[CHAT] append kiriman Gateway sendiri dilewati (sudah tercatat di POS)', { messageId });
      return false;
    }

    const remoteJid = msg.key?.remoteJid;
    const jidType = classifyJid(remoteJid);
    if (jidType !== 'pn' && jidType !== 'lid' && jidType !== 'group') {
      logger.info('[CHAT] append beralamat non-pelanggan dilewati', { remoteJid, messageId, jidType });
      return false;
    }

    return true;
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

    // M1 Wave 1 TASK-013 (REQ-019, AC-018): JID yang query-nya BARU gagal
    // dilewati TANPA memanggil onWhatsApp() dan tanpa menunggu timeout, selama
    // masa cache negatif belum lewat. Sesudahnya dicoba lagi.
    const failedAt = this._lidFailureCache.get(phoneJid);
    if (failedAt !== undefined) {
      if (Date.now() - failedAt < config.lidLookupNegativeTtlMs) return null;
      this._lidFailureCache.delete(phoneJid);
    }

    // Refactor TASK-203 (REQ-002, CR-13): belum connected -> tidak ada query,
    // dan null TIDAK di-cache: itu bukan hasil query, jadi JID ini dicoba lagi
    // begitu tersambung (bukan hilang sampai restart).
    if (!this.isConnected()) return null;

    let resolvedLid = null;

    let timer;
    try {
      // E-05 / REQ-014 (AC-010): query ini di-`await` di dalam loop pesan
      // yang berurutan (_onMessagesUpsert), jadi satu query yang tersangkut
      // menahan SEMUA pesan berikutnya dalam batch sebelum sempat tersimpan.
      // Batas waktu config.lidLookupTimeoutMs (bawaan 2 detik) membatasi
      // jendela itu; resolusi LID tetap best-effort (non-fatal). Timer
      // dibersihkan di `finally` supaya tidak menahan proses saat query cepat.
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`onWhatsApp() timeout (${config.lidLookupTimeoutMs}ms)`)),
          config.lidLookupTimeoutMs
        );
      });
      const results = await Promise.race([this.sock.onWhatsApp(phoneJid), timeout]);
      const match = Array.isArray(results) ? results.find((r) => r?.lid) : null;

      if (match?.lid) {
        const rawLid = String(match.lid);
        // Normalisasi defensif -- lihat catatan kejujuran di atas.
        resolvedLid = rawLid.includes('@') ? rawLid : `${rawLid}@lid`;
      }
    } catch (err) {
      // KEGAGALAN (timeout/error): pesan tetap disimpan tanpa identity_hint,
      // dicatat sebagai peringatan, dan JID ini masuk cache negatif -- TIDAK
      // masuk _lidResolutionCache, jadi bisa dicoba lagi setelah TTL.
      logger.warn('[IDENTITY] gagal resolve LID untuk PN via onWhatsApp(); pesan disimpan tanpa identity_hint', {
        phoneJid,
        error: err.message,
        negativeCacheMs: config.lidLookupNegativeTtlMs,
      });
      this._lidFailureCache.set(phoneJid, Date.now());
      return null;
    } finally {
      clearTimeout(timer);
    }

    this._lidResolutionCache.set(phoneJid, resolvedLid);
    return resolvedLid;
  }

  /**
   * Grup Tahap 2 (REQ-002, GUD-001/ASSUMPTION-003): baca subject grup dari
   * cache in-memory. Sinkron & TIDAK pernah memanggil jaringan -- dipakai di
   * jalur kritis penerimaan pesan supaya group_name bisa disertakan hanya
   * kalau sudah tersedia.
   *
   * @param {string} jid JID grup (@g.us).
   * @returns {string|null} subject bila masih segar, atau null bila belum ada/kadaluarsa.
   */
  _getCachedGroupName(jid) {
    const entry = this._groupNameCache.get(jid);
    if (!entry) return null;

    if (Date.now() - entry.fetchedAt > config.groupNameCacheTtlMs) {
      this._groupNameCache.delete(jid);
      return null;
    }

    return entry.subject;
  }

  /**
   * Grup Tahap 2 (REQ-002/REQ-003, GUD-001): isi/segarkan cache subject grup
   * dengan `groupMetadata(jid)`.
   *
   * FIRE-AND-FORGET dengan sengaja: pemanggil TIDAK meng-await fungsi ini,
   * sehingga (a) pesan grup yang sedang diproses tetap diteruskan SEGERA tanpa
   * group_name saat cache miss, dan (b) cache terisi di latar untuk pesan grup
   * berikutnya. Tidak ada opsi "menunggu inline" di jalur kritis (ASSUMPTION-003).
   *
   * Best-effort & non-fatal: kegagalan/timeout cukup dicatat, TIDAK PERNAH
   * melempar ke pemanggil dan TIDAK menahan/menggagalkan pesan itu sendiri.
   */
  _refreshGroupName(jid) {
    if (this._groupNameFetchInFlight.has(jid)) return;

    const sock = this.sock;
    if (!this.isConnected() || !sock) return;

    this._groupNameFetchInFlight.add(jid);
    Promise.resolve()
      .then(() => sock.groupMetadata(jid))
      .then((metadata) => {
        const subject = metadata?.subject;
        if (typeof subject === 'string' && subject.length > 0) {
          this._groupNameCache.set(jid, { subject, fetchedAt: Date.now() });
        } else {
          logger.debug('[CHAT] groupMetadata() tidak mengembalikan subject -- group_name dibiarkan kosong', { jid });
        }
      })
      .catch((err) => {
        logger.warn('[CHAT] gagal mengambil groupMetadata() untuk group_name; pesan grup tetap diteruskan tanpa group_name', {
          jid,
          error: err.message,
        });
      })
      .finally(() => {
        this._groupNameFetchInFlight.delete(jid);
      });
  }

  /**
   * M1 Wave 1 TASK-004 (REQ-006, REQ-009, REQ-010, REQ-011; menggantikan
   * `_enqueueWithRetry` ad-hoc E-04). Menyimpan satu event ke buffer utama:
   *
   * 1. Coba `enqueueWithRetry()` (1 percobaan + ulangan berjeda, TASK-002).
   * 2. Semua percobaan gagal (kegagalan penyimpanan) -> event DITAMPUNG di
   *    `overflowBuffer` dan error keras dicatat; siklus worker berikutnya
   *    (incomingDelivery.js) mengurasnya kembali ke buffer utama.
   * 3. Event TIDAK LENGKAP (EnqueueValidationError) tidak akan pernah
   *    berhasil, jadi TIDAK ditampung -- hanya dicatat error keras berisi
   *    alasan dan kunci pesan (REQ-006).
   *
   * Baileys sudah mengirim tanda terima untuk pesan yang sedang diproses di
   * sini, jadi pesan ini TIDAK akan datang lagi (E-13) -- karena itu kegagalan
   * tidak boleh senyap. Tidak pernah melempar: satu pesan yang gagal tidak
   * boleh menjatuhkan penerimaan pesan WhatsApp lainnya.
   */
  async _persistIncoming(event) {
    try {
      await enqueueWithRetry(incomingBuffer, event, config.enqueueRetryDelaysMs);
    } catch (err) {
      if (err instanceof EnqueueValidationError) {
        logger.error('[DELIVERY] pesan DITOLAK sebelum tersimpan: field wajib kosong -- pesan ini hilang', {
          messageId: event.messageId,
          chatId: event.chatId,
          missing: err.missing,
        });
        return;
      }

      const dropped = overflowBuffer.push(event);
      logger.error('[DELIVERY] GAGAL menyimpan pesan ke buffer utama setelah dicoba ulang -- berisiko tidak sampai ke POS', {
        messageId: event.messageId,
        direction: event.direction,
        overflowSize: overflowBuffer.size(),
        droppedFromOverflow: dropped,
        error: err.message,
      });
    }
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
      // Bukan pesan teks biasa -- cek apakah gambar/dokumen/sticker/audio/video
      // (didukung), selain itu (lokasi/kontak/dst) di luar scope untuk
      // sekarang, cukup di-log & dilewati.
      const imageMsg = msg.message.imageMessage;
      const documentMsg = msg.message.documentMessage;
      const stickerMsg = msg.message.stickerMessage;
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
      } else if (stickerMsg) {
        // SAMA PRINSIP dengan image/document (BUKAN audio/video): sticker
        // wajib punya directPath/mediaKey lengkap, kalau tidak dibuang --
        // lihat buildMediaRef(). WhatsApp TIDAK mengizinkan caption pada
        // sticker (stickerMessage proto memang tidak punya field caption),
        // jadi text selalu null di sini, konsisten dengan audioMessage.
        //
        // stickerMsg.isAnimated SENGAJA TIDAK ikut dimasukkan ke `media`
        // di sini -- kontrak field `media` yang diteruskan ke CI4 (lihat
        // normalized.media di bawah & incomingBuffer.js) WAJIB IDENTIK
        // dengan image/document (direct_path/media_key_base64/mimetype/
        // file_length/file_sha256_base64/file_name) supaya AuliaPos bisa
        // memproses sticker lewat cabang kode yang sama dengan image/
        // document, tanpa field tambahan yang tidak dikenal.
        messageType = 'sticker';
        text = null;
        media = buildMediaRef(stickerMsg, 'sticker', null);

        if (!media) {
          logger.warn('Pesan sticker diterima tapi referensi tidak lengkap (directPath/mediaKey kosong), dilewati', {
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
        logger.debug('Melewati pesan yang belum didukung (bukan teks/gambar/dokumen/sticker/audio/video)', {
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

    // ===== Grup Tahap 2 (plan/plan-feature-grup-tahap2-wa-gateway-v1.0.md) =====
    // Identitas pengirim pesan GRUP adalah key.participant (JID anggota), BUKAN
    // remoteJid (= JID grup). Sebelum ini sender.jid selalu = chatId, sehingga
    // pesan grup membawa JID grup sebagai sender_jid -- salah.
    //
    // REQ-001/CON-001: sender_jid hanya diubah untuk jidType==='group'; jalur
    // pn/lid sama sekali tidak berubah (sender_jid tetap sender.jid seperti
    // sebelumnya, additive/tidak breaking untuk kontrak pesan pribadi).
    // Keputusan pemilik 2026-09-26: untuk grup KELUAR (fromMe) participant
    // TIDAK diekstrak (semantik Baileys untuk fromMe tidak diandalkan);
    // AuliaPos menerima outgoing grup tanpa sender_jid, jadi nilainya null.
    //
    // REQ-002/REQ-003: group_name diambil dari subject grup TER-CACHE. Pada
    // cache miss, refresh dijalankan FIRE-AND-FORGET di _refreshGroupName()
    // supaya pesan tetap diteruskan segera tanpa group_name; retry terjadi
    // otomatis pada pesan grup berikutnya saat cache sudah terisi.
    const isGroup = jidType === 'group';
    const isGroupIncoming = isGroup && !fromMe;
    let groupSenderJid; // undefined -> jangan sentuh sender_jid (non-grup)
    let groupName; // undefined -> belum diketahui, jangan kirim field-nya

    if (isGroup) {
      if (isGroupIncoming) {
        const participant = msg.key?.participant || null;
        groupSenderJid = participant;
        if (!participant) {
          // Kegagalan yang TERLIHAT, bukan senyap: AuliaPos menolak 400 pesan
          // grup masuk tanpa sender_jid (REQ-010 sisi AuliaPos).
          logger.warn('[CHAT] pesan grup masuk tanpa key.participant -- sender_jid kosong, AuliaPos akan menolak 400 (kegagalan yang terlihat, bukan senyap)', {
            messageId: msg.key?.id || null,
            chatId: remoteJid,
          });
        }

        const cachedGroupName = this._getCachedGroupName(remoteJid);
        if (cachedGroupName !== null) {
          groupName = cachedGroupName;
        } else {
          this._refreshGroupName(remoteJid); // fire-and-forget, sengaja TIDAK di-await
        }
      } else {
        groupSenderJid = null; // grup keluar: JID grup TIDAK dipakai sebagai sender_jid
      }
    }

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

    if (isGroup) {
      normalized.sender_jid = groupSenderJid; // REQ-001: participant (atau null bila tak tersedia)
      if (groupName !== undefined) {
        normalized.group_name = groupName; // REQ-002: hanya bila sudah diketahui
      }
    }

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
    // Kegagalan simpan ditangani di _persistIncoming() (retry -> overflow
    // buffer, TASK-004); metode itu tidak pernah melempar.
    await this._persistIncoming({
      ...normalized,
      direction: fromMe ? 'outgoing' : 'incoming',
    });

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
   * M1 Wave 1 TASK-009 (REQ-003, D-03): tentukan ID pesan SEBELUM kirim dan
   * catat ke ownSentRegistry. WAJIB dipanggil SEBELUM `await sock.sendMessage()`
   * (RISK-001): Baileys memancarkan `append` untuk kiriman sendiri lewat
   * process.nextTick TEPAT SEBELUM sendMessage() kembali, jadi mencatat ID
   * setelah kirim kalah balapan dan filter `append` (TASK-010) akan mencatat
   * ulang balasan kasir sebagai pesan ganda.
   *
   * ID diteruskan ke Baileys lewat opsi `messageId`, yang menimpa ID otomatis
   * (dibaca dari messages-send.js: `messageId: generateMessageIDV2(...),
   * ...options`). ID tetap tercatat walau pengiriman gagal -- tidak berbahaya.
   */
  _registerOwnSentId() {
    const { generateMessageIDV2 } = getBaileys();
    const messageId = generateMessageIDV2(this.sock?.user?.id);
    ownSentRegistry.register(messageId);
    return messageId;
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
      const ownMessageId = this._registerOwnSentId(); // SEBELUM sendMessage (D-03)
      const result = await this.sock.sendMessage(jid, { text }, { messageId: ownMessageId });
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
   * Kirim SATU pesan media (gambar/dokumen/sticker) ke sebuah JID, apa
   * adanya, tanpa normalisasi/tebakan -- versi media dari
   * sendTextMessage(). `jid` di sini boleh berupa @s.whatsapp.net, @lid,
   * atau @g.us, sama seperti sendTextMessage().
   *
   * PRINSIP SAMA seperti media MASUK: Gateway TIDAK PERNAH menyimpan file media
   * ke disk. `buffer` yang diterima di sini hanya dipegang di memory selama
   * pemanggilan function ini (diteruskan langsung ke Baileys), tidak pernah
   * disimpan ke property instance mana pun.
   *
   * Sticker: WhatsApp TIDAK mengizinkan caption/mimetype custom untuk
   * sticker (diverifikasi dari `AnyMediaMessageContent` di Baileys --
   * variant sticker cuma `{ sticker, isAnimated? }`), jadi `caption`/
   * `mimetype` di `options` diabaikan untuk mediaType ini. `buffer`
   * WAJIB sudah berupa WebP valid -- Gateway TIDAK melakukan konversi
   * otomatis dari format lain (lihat validasi di ci4Routes.js/routes.js
   * SEBELUM fungsi ini dipanggil).
   *
   * @param {string} jid
   * @param {'image'|'document'|'sticker'} mediaType
   * @param {Buffer} buffer
   * @param {{ caption?: string, mimetype?: string, fileName?: string, isAnimated?: boolean }} [options]
   */
  async sendMediaMessage(jid, mediaType, buffer, options = {}) {
    if (!this.isConnected()) {
      const err = new Error('WhatsApp belum connected, tidak bisa mengirim pesan');
      err.code = 'NOT_CONNECTED';
      throw err;
    }

    const jidType = classifyJid(jid);
    const { caption, mimetype, fileName, isAnimated } = options;

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
    } else if (mediaType === 'sticker') {
      content = { sticker: buffer, isAnimated: Boolean(isAnimated) || undefined };
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
      const ownMessageId = this._registerOwnSentId(); // SEBELUM sendMessage (D-03)
      const result = await this.sock.sendMessage(jid, content, { messageId: ownMessageId });

      // Setelah upload sukses, message yang dikembalikan Baileys SUDAH berisi
      // directPath/mediaKey asli dari server WhatsApp untuk file yang baru
      // saja diunggah -- sama persis strukturnya dengan imageMessage/
      // documentMessage/stickerMessage pada pesan MASUK. Diekstrak dengan
      // buildMediaRef() yang sama supaya media KELUAR ini juga bisa diambil
      // ulang nanti (mis. dibuka lagi dari Inbox POS) lewat alur
      // downloadMediaByRef() yang sudah ada, TANPA perlu menyimpan file
      // apa pun di sini.
      const sentMediaMessageByType = {
        image: result?.message?.imageMessage,
        document: result?.message?.documentMessage,
        sticker: result?.message?.stickerMessage,
      };
      const sentMediaMessage = sentMediaMessageByType[mediaType];
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
   * Balas SATU conversation dengan media (gambar/dokumen/sticker) -- versi
   * media dari sendReply(). chatId di sini SAMA PRINSIPNYA dengan
   * sendReply(): JID asli apa adanya, TIDAK PERNAH melalui
   * normalizeToJid()/jidToPhone().
   *
   * @param {string} chatId
   * @param {'image'|'document'|'sticker'} mediaType
   * @param {Buffer} buffer
   * @param {{ caption?: string, mimetype?: string, fileName?: string, isAnimated?: boolean }} [options]
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
   * @param {{mediaType: 'image'|'document'|'sticker', directPath: string, mediaKeyBase64: string}} mediaRef
   * @returns {Promise<Buffer>}
   */
  async downloadMediaByRef(mediaRef) {
    const mediaKey = Buffer.from(mediaRef.mediaKeyBase64, 'base64');

    const { downloadContentFromMessage } = getBaileys();
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
 * documentMessage/stickerMessage Baileys -- directPath + mediaKey
 * (base64) + info lain yang cukup untuk mendekripsi ulang NANTI,
 * on-demand, saat kasir benar-benar membuka pesan itu di Inbox POS.
 * File aslinya TIDAK diunduh/didekripsi di sini sama sekali (sesuai
 * keputusan: "cukup simpan referensi, file tetap di WhatsApp").
 *
 * Generik untuk ketiga tipe (image/document/sticker) -- field yang
 * diekstrak sama persis di ketiganya (directPath/mediaKey/mimetype/
 * fileLength/fileSha256), sudah diverifikasi langsung dari proto
 * Baileys (WAProto/index.d.ts: IImageMessage/IDocumentMessage/
 * IStickerMessage semuanya punya field yang sama untuk ini).
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
