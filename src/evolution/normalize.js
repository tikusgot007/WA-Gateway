'use strict';

const crypto = require('crypto');
const logger = require('../logging');
const { isGroupJid, jidToPhone } = require('./jid');

/**
 * Normalisasi payload webhook Evolution API -> event buffer incoming gateway
 * (bentuk yang dimengerti store/incomingBuffer.enqueue()).
 *
 * BENTUK WEBHOOK EVOLUTION (terverifikasi dari docs resmi
 * `docs.evolutionfoundation.com.br/evolution-api/configuration/webhooks`):
 * body POST berisi `{ event, instance, data, destination, date_time, ... }`.
 * `event` salah satu dari MESSAGES_UPSERT/MESSAGES_UPDATE/CONNECTION_UPDATE/dst
 * (lihat tabel resmi). Bentuk detail `data` untuk MESSAGES_UPSERT TIDAK
 * didokumentasikan field-per-field di docs publik -- Evolution meneruskan
 * struktur ala-Baileys (`key`, `message`, `messageTimestamp`, `pushName`)
 * karena mode WHATSAPP-BAILEYS membungkus library Baileys.
 *
 * *** BELUM DIVERIFIKASI DENGAN PAYLOAD NYATA (lihat plan §7 item 2) ***
 * Normalizer ini ditulis DEFENSIF: menerima beberapa kemungkinan bentuk
 * (`data` langsung sebuah pesan, `data.message`/`data.messages[0]`, key di
 * `data.key` atau `data.messages[0].key`), dan MEMBUANG (bukan crash) event
 * yang tidak bisa dipetakan, dengan log yang jelas untuk debugging Tahap 2.
 * WAJIB direvisi memakai payload MESSAGES_UPSERT nyata sebelum produksi.
 */

function pickMessageRecord(data) {
  if (!data || typeof data !== 'object') return null;
  // Bentuk paling umum Baileys/Evolution: { key, message, messageTimestamp, pushName }
  if (data.key && typeof data.key === 'object') return data;
  // Beberapa versi membungkus di data.messages[] (mirip messages.upsert Baileys mentah)
  if (Array.isArray(data.messages) && data.messages.length > 0) return data.messages[0];
  if (data.message && data.message.key) return data.message;
  return null;
}

function extractText(messageObj) {
  if (!messageObj || typeof messageObj !== 'object') return null;
  if (typeof messageObj.conversation === 'string') return messageObj.conversation;
  if (messageObj.extendedTextMessage && typeof messageObj.extendedTextMessage.text === 'string') {
    return messageObj.extendedTextMessage.text;
  }
  if (messageObj.imageMessage && typeof messageObj.imageMessage.caption === 'string') {
    return messageObj.imageMessage.caption;
  }
  if (messageObj.documentMessage && typeof messageObj.documentMessage.caption === 'string') {
    return messageObj.documentMessage.caption;
  }
  return null;
}

/**
 * Pembungkus (wrapper) Baileys: isi pesan sebenarnya ada di `.message`.
 *
 * Sebelum ini view-once / ephemeral / dokumen-berjudul / pesan-diedit jatuh ke
 * default 'text' dengan isi kosong, lalu ditolak CI4 (400) dan ditandai dead
 * PERMANEN (tanpa retry) -- padahal isinya pesan pelanggan yang sah. Dibuka di
 * sini supaya isinya diklasifikasikan seperti pesan biasa.
 */
const MESSAGE_WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
];

/**
 * Pembungkus view-once. Isinya SENGAJA tidak pernah diambil/diunduh: WhatsApp
 * tidak menampilkannya di perangkat tertaut, dan gateway lama pun memilih tidak
 * menyimpannya (paritas CON-002). Dipakai hanya untuk MENGENALI lalu memberi
 * baris penanda.
 */
const VIEW_ONCE_WRAPPERS = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'];

function unwrapMessage(recordMessage) {
  let inner = recordMessage;
  let outerBase64 = inner && typeof inner.base64 === 'string' ? inner.base64 : null;
  let outerMessageContextInfo = inner && typeof inner.messageContextInfo === 'object'
    ? inner.messageContextInfo
    : null;

  for (let i = 0; i < 10; i += 1) {
    if (!inner || typeof inner !== 'object') break;
    const wrapper = MESSAGE_WRAPPERS.find(
      (k) => inner[k] && typeof inner[k] === 'object' && inner[k].message,
    );
    if (!wrapper) break;

    outerBase64 = outerBase64 || (typeof inner.base64 === 'string' ? inner.base64 : null);
    if (!outerMessageContextInfo && inner.messageContextInfo
      && typeof inner.messageContextInfo === 'object') {
      outerMessageContextInfo = inner.messageContextInfo;
    }
    inner = inner[wrapper].message;
  }

  // `base64` (webhook_base64=true) kadang menempel di lapisan LUAR, bukan di node
  // media dalam. Kalau lapisan dalam tidak punya, turunkan supaya extractMedia
  // tetap menemukan blob-nya.
  if (inner && typeof inner === 'object') {
    const carry = {};
    if (!inner.base64 && outerBase64) carry.base64 = outerBase64;

    // WhatsApp dapat menaruh messageSecret pada messageContextInfo di luar
    // ephemeral/view-once wrapper. Secret tersebut harus tetap ikut ke konten
    // terdalam supaya quotedStore dapat menyimpannya untuk decrypt MESSAGE_EDIT.
    if (!inner.messageContextInfo && outerMessageContextInfo) {
      carry.messageContextInfo = outerMessageContextInfo;
    }

    if (Object.keys(carry).length > 0) inner = { ...inner, ...carry };
  }

  return inner || {};
}

/**
 * Tipe konten yang DIDUKUNG CI4, atau `null` kalau bukan konten yang dikenal.
 *
 * Mengembalikan `null` (bukan default `'text'`) adalah inti perbaikan: default
 * `'text'` membuat tipe tak dikenal terkirim sebagai teks kosong -> ditolak CI4.
 */
function detectMessageType(messageObj) {
  if (!messageObj || typeof messageObj !== 'object') return null;
  if (messageObj.imageMessage) return 'image';
  if (messageObj.documentMessage) return 'document';
  if (messageObj.stickerMessage) return 'sticker';
  if (messageObj.audioMessage) return 'audio';
  if (messageObj.videoMessage) return 'video';
  // Tahap 4: lokasi & kontak punya data terstruktur (bukan blob), dikirim lewat
  // `extra` dan ditampilkan di Inbox.
  if (messageObj.locationMessage || messageObj.liveLocationMessage) return 'location';
  if (messageObj.contactMessage || messageObj.contactsArrayMessage) return 'contact';
  if (typeof messageObj.conversation === 'string') return 'text';
  if (messageObj.extendedTextMessage) return 'text';
  return null;
}

/**
 * Deteksi pesan EDIT pelanggan (mekanisme baru WhatsApp): node
 * `secretEncryptedMessage` dengan `secretEncType === 2` (MESSAGE_EDIT).
 * Isi hasil edit ada di `encPayload` dan TERENKRIPSI -- Baileys tidak
 * men-dekodenya, jadi teks baru tidak bisa dibaca (spike TODO-F7).
 * Yang bisa dipakai: `targetMessageKey.id` = wa_message_id pesan ASLI,
 * untuk memberi penanda "diedit" di CI4.
 *
 * @param {object} messageObj pesan yang SUDAH di-unwrap
 * @returns {string|null} wa_message_id pesan asli, atau null bila bukan edit
 */
function extractEditTarget(messageObj) {
  const sem = messageObj && messageObj.secretEncryptedMessage;
  if (!sem || typeof sem !== 'object') return null;
  if (Number(sem.secretEncType) !== 2) return null; // 2 = MESSAGE_EDIT
  const key = sem.targetMessageKey;
  if (!key || typeof key.id !== 'string' || key.id === '') return null;
  return key.id;
}

/**
 * Data terstruktur untuk tipe yang tidak berbentuk file: lokasi & kontak.
 * Dikirim apa adanya ke CI4 lewat field `extra` dan disimpan di kolom JSON.
 * @returns {object|null}
 */
function extractExtra(messageObj) {
  if (!messageObj || typeof messageObj !== 'object') return null;

  const loc = messageObj.locationMessage || messageObj.liveLocationMessage;
  if (loc) {
    const latitude = Number(loc.degreesLatitude);
    const longitude = Number(loc.degreesLongitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return {
      kind: 'location',
      latitude,
      longitude,
      name: typeof loc.name === 'string' && loc.name ? loc.name : null,
      address: typeof loc.address === 'string' && loc.address ? loc.address : null,
      live: Boolean(messageObj.liveLocationMessage),
    };
  }

  const normalizeContact = (c) => {
    if (!c || typeof c !== 'object') return null;
    const displayName = typeof c.displayName === 'string' && c.displayName.trim() ? c.displayName.trim() : null;
    const vcard = typeof c.vcard === 'string' && c.vcard ? c.vcard : null;
    if (!displayName && !vcard) return null;
    return { display_name: displayName, vcard };
  };

  if (messageObj.contactMessage) {
    const contact = normalizeContact(messageObj.contactMessage);
    if (!contact) return null;
    return { kind: 'contact', contacts: [contact] };
  }

  if (messageObj.contactsArrayMessage) {
    const arr = Array.isArray(messageObj.contactsArrayMessage.contacts) ? messageObj.contactsArrayMessage.contacts : [];
    const contacts = arr.map(normalizeContact).filter(Boolean);
    if (contacts.length === 0) return null;
    return { kind: 'contact', contacts };
  }

  return null;
}

/**
 * Node yang BUKAN konten pelanggan (metadata/status sistem) -> dilewati tanpa
 * masuk antrean dan tanpa dead-letter. Sebelumnya ini pun jadi 'text' kosong.
 */
const NOISE_NODES = [
  'reactionMessage',
  'protocolMessage',
  'senderKeyDistributionMessage',
  'pollUpdateMessage',
];

/**
 * Wadah yang ISINYA dikirim Evolution sebagai pesan TERPISAH.
 *
 * `albumMessage` hanya membawa `expectedImageCount`/`expectedVideoCount` -- tidak
 * ada blob di dalamnya. Fotonya tiba sendiri-sendiri sebagai `imageMessage`.
 * Terverifikasi dari DB Evolution + log adapter (2026-10-01): album
 * A5F78764... disertai 4 `imageMessage` pada detik yang sama, dan ketiganya
 * tersimpan sebagai media lokal. Karena itu wadahnya dilewati; kalau tidak, ia
 * menambah baris penanda mubazir (dulu: dead-letter) di samping foto aslinya.
 */
const CONTAINER_ONLY_NODES = ['albumMessage'];

function noiseReason(record, messageObj) {
  if (record && record.messageStubType) return 'stub sistem (messageStubType)';
  if (!messageObj || typeof messageObj !== 'object') return null;
  for (const node of NOISE_NODES) {
    if (messageObj[node]) return node;
  }
  for (const node of CONTAINER_ONLY_NODES) {
    if (messageObj[node]) return node + ' (isinya dikirim sebagai pesan terpisah)';
  }
  const keys = Object.keys(messageObj);
  if (keys.length > 0 && keys.every((k) => k === 'messageContextInfo' || k === 'base64')) {
    return 'messageContextInfo saja (tanpa konten)';
  }
  return null;
}

function isViewOnceMessage(record) {
  if (!record) return false;
  // Jalur NYATA dari HP ke perangkat tertaut: stanza <unavailable
  // type="view_once"> -> key.isViewOnce=true dan isi pesan KOSONG
  // (terverifikasi di WA-Gateway lama, commit 66bff03 / connectionManager.js:923).
  if (record.key && record.key.isViewOnce === true) return true;
  const raw = record.message;
  if (!raw || typeof raw !== 'object') return false;
  return VIEW_ONCE_WRAPPERS.some((k) => Boolean(raw[k]));
}

/**
 * Penanda teks untuk tipe/isi yang belum didukung. GAYA SERAGAM dengan
 * placeholder audio/video yang dibuat UI Inbox:
 *   "Customer mengirim <jenis> — cek WhatsApp Web."
 * Tujuannya supaya semua pesan yang tampil sebagai placeholder terbaca
 * konsisten di Inbox.
 */
const PENANDA_AWAL = 'Customer mengirim ';
const PENANDA_AKHIR = ' — cek WhatsApp Web.';

function unsupportedLabel(messageObj) {
  if (!messageObj || typeof messageObj !== 'object') {
    return PENANDA_AWAL + 'pesan yang belum didukung' + PENANDA_AKHIR;
  }
  const count = Number(messageObj.albumMessage && messageObj.albumMessage.expectedImageCount) || null;
  if (messageObj.albumMessage) {
    return PENANDA_AWAL + (count ? `album ${count} foto` : 'album foto') + PENANDA_AKHIR;
  }
  if (messageObj.pollCreationMessage || messageObj.pollCreationMessageV2 || messageObj.pollCreationMessageV3) {
    return PENANDA_AWAL + 'polling' + PENANDA_AKHIR;
  }
  if (messageObj.eventMessage) return PENANDA_AWAL + 'undangan acara' + PENANDA_AKHIR;
  if (messageObj.productMessage) return PENANDA_AWAL + 'katalog produk' + PENANDA_AKHIR;
  if (messageObj.ptvMessage) return PENANDA_AWAL + 'video singkat' + PENANDA_AKHIR;
  if (
    messageObj.buttonsResponseMessage
    || messageObj.listResponseMessage
    || messageObj.templateButtonReplyMessage
    || messageObj.interactiveResponseMessage
    || messageObj.interactiveMessage
  ) {
    return PENANDA_AWAL + 'balasan tombol/daftar' + PENANDA_AKHIR;
  }
  const node = Object.keys(messageObj).find((k) => k !== 'base64' && k !== 'messageContextInfo');
  return node
    ? PENANDA_AWAL + `pesan bertipe "${node}"` + PENANDA_AKHIR
    : PENANDA_AWAL + 'pesan yang belum didukung' + PENANDA_AKHIR;
}

/**
 * Ekstrak info media dari objek `message` Evolution.
 *
 * `messageType` yang dikenali CI4: image/document/sticker/audio/video.
 * Untuk image/document/sticker, CI4 MEMBUTUHKAN referensi file (direct_path +
 * media_key_base64); karena Evolution tidak memberi directPath/mediaKey
 * Baileys, adapter menyimpan blob-nya lokal (mediaStore) dan mengirim ref
 * opaque. Sumber blob: `message.base64` yang disertakan Evolution ketika
 * `webhook_base64=true` (lihat whatsapp.baileys.service.ts ~1444).
 *
 * audio/video: CI4 hanya butuh metadata ringan (mimetype/ukuran), TIDAK
 * pernah dibuka ulang lewat Inbox -> tanpa ref file.
 *
 * @returns {{ type:string, mimetype:string|null, fileName:string|null, caption:string|null, base64:string|null }|null}
 */
function extractMedia(messageObj) {
  if (!messageObj || typeof messageObj !== 'object') return null;
  const candidates = [
    ['image', messageObj.imageMessage],
    ['document', messageObj.documentMessage],
    ['sticker', messageObj.stickerMessage],
    ['video', messageObj.videoMessage],
    ['audio', messageObj.audioMessage],
  ];
  for (const [type, node] of candidates) {
    if (!node || typeof node !== 'object') continue;
    return {
      type,
      mimetype: typeof node.mimetype === 'string' ? node.mimetype : null,
      fileName: typeof node.fileName === 'string' ? node.fileName : null,
      caption: typeof node.caption === 'string' ? node.caption : null,
      // Ukuran berkas dari METADATA pesan. Dipakai untuk memutuskan
      // unduh/penanda TANPA harus mengunduh lebih dulu (mediaMode ondemand).
      // Bisa number, string angka, atau Long protobuf ({low,high}).
      fileLength: mediaLengthToNumber(node.fileLength),
      base64: typeof messageObj.base64 === 'string' && messageObj.base64 ? messageObj.base64 : null,
    };
  }
  return null;
}

/** Normalisasi `fileLength` (number | string | Long protobuf) -> number|null. */
function mediaLengthToNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  if (value && typeof value === 'object' && typeof value.low === 'number') return value.low;
  return null;
}

/**
 * Label singkat untuk tipe media tanpa teks, dipakai sebagai `snippet` kutipan
 * (padanan `buildQuotedSnippet` gateway lama, `connectionManager.js`).
 */
const QUOTED_MEDIA_LABELS = {
  imageMessage: '[Foto]',
  documentMessage: '[Dokumen]',
  stickerMessage: '[Stiker]',
  audioMessage: '[Audio]',
  videoMessage: '[Video]',
};
const QUOTED_SNIPPET_MAX_CHARS = 200;

/**
 * Cuplikan singkat pesan yang DIKUTIP (bukan pesan masuk itu sendiri), dipakai
 * CI4 sebagai fallback tampilan bila pesan sumber tidak ada di DB lokal
 * (`InboxGatewayApi::resolveKutipanMasuk`). TANPA ini, kutipan ke pesan yang
 * belum tersimpan muncul sebagai "Pesan tidak ditemukan" meski pelanggan
 * jelas membalas sesuatu.
 * @param {object|null|undefined} quotedMessageObj isi `contextInfo.quotedMessage`
 * @returns {string|null}
 */
function buildQuotedSnippet(quotedMessageObj) {
  if (!quotedMessageObj || typeof quotedMessageObj !== 'object') return null;
  const text = extractText(quotedMessageObj);
  if (typeof text === 'string' && text.trim()) {
    return text.length > QUOTED_SNIPPET_MAX_CHARS ? text.slice(0, QUOTED_SNIPPET_MAX_CHARS) : text;
  }
  for (const [key, label] of Object.entries(QUOTED_MEDIA_LABELS)) {
    if (quotedMessageObj[key]) return label;
  }
  return null;
}

/**
 * `contextInfo` balasan (native reply) bisa muncul di DUA tempat tergantung
 * tipe pesan pembalas:
 *  - `record.contextInfo` (SEJAJAR `message`) -- balasan teks polos
 *    (`message.conversation`). TERVERIFIKASI dari payload nyata produksi
 *    (`evolution.log` 2026-10-02 14:22:35 WIB, conv id=6 message id=190
 *    "Siap di goyang" membalas sticker id=183); lihat TODO-F4.
 *  - di DALAM sub-objek tipe pesan (`extendedTextMessage.contextInfo`, dst)
 *    -- balasan dengan caption/media, pola gateway Baileys lama
 *    (`connectionManager.js` REQ-010).
 * `record.contextInfo` dicek LEBIH DULU: tidak mengubah pesan yang memang
 * tidak membalas apa pun (tetap mensyaratkan `stanzaId`).
 * @param {object} record baris pesan Evolution (hasil `pickMessageRecord`)
 * @param {object} messageObj isi `message` SETELAH dibuka pembungkus (`unwrapMessage`)
 */
function extractQuotedContext(record, messageObj) {
  if (record && record.contextInfo && record.contextInfo.stanzaId) {
    return record.contextInfo;
  }
  // contextInfo di dalam sub-objek tipe pesan -- paritas 6 tipe konten
  // gateway Baileys lama (`connectionManager.js` INCOMING_QUOTE_CONTENT_KEYS).
  const candidates = [
    messageObj && messageObj.extendedTextMessage,
    messageObj && messageObj.imageMessage,
    messageObj && messageObj.documentMessage,
    messageObj && messageObj.stickerMessage,
    messageObj && messageObj.audioMessage,
    messageObj && messageObj.videoMessage,
  ].filter(Boolean);
  for (const c of candidates) {
    if (c.contextInfo && c.contextInfo.stanzaId) return c.contextInfo;
  }
  return null;
}

/**
 * Forward MASUK (dari pelanggan) -- TODO-F5. Sinyal WhatsApp untuk pesan yang
 * diteruskan ada di `record.contextInfo`, SEJAJAR `message`, sama seperti
 * kutipan (lihat `extractQuotedContext()`). TERVERIFIKASI dari payload nyata
 * produksi (`evolution.log` 2026-10-02 16:41:37 WIB, conv 628563324637,
 * waMessageId A5159B2E89F09DB93394D45A866ED431, messageType 'conversation'):
 * `contextInfo: { forwardingScore: 1, isForwarded: true, forwardOrigin: 0 }`.
 * `isForwarded` dicek lebih dulu (boolean eksplisit); `forwardingScore > 0`
 * sebagai fallback untuk kompatibilitas versi WhatsApp yang mungkin hanya
 * mengirim salah satunya (gateway Baileys lama menulis keduanya saat
 * forward KELUAR, lihat `forwardMarker.js`).
 * @param {object} record baris pesan Evolution (hasil `pickMessageRecord`)
 * @returns {boolean}
 */
function extractForwardFlag(record) {
  const ctx = record && record.contextInfo;
  if (!ctx || typeof ctx !== 'object') return false;
  if (ctx.isForwarded === true) return true;
  return Number(ctx.forwardingScore) > 0;
}

function toIsoTimestamp(messageTimestamp) {
  const n = Number(messageTimestamp);
  if (Number.isFinite(n) && n > 0) {
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function synthesizeMessageIdFallback(record) {
  const basis = JSON.stringify([record.key || null, record.messageTimestamp || null]);
  return `evolution:${crypto.createHash('sha1').update(basis).digest('hex').slice(0, 32)}`;
}

/**
 * @param {object} payload body webhook Evolution (`{ event, instance, data, ... }`)
 * @returns {{ok: true, event: object} | {ok: false, reason: string}}
 */
function normalizeMessagesUpsert(payload) {
  const record = pickMessageRecord(payload.data);
  if (!record) {
    return { ok: false, reason: 'payload MESSAGES_UPSERT tidak punya bentuk pesan yang dikenali (lihat normalize.js, belum diverifikasi ke payload nyata)' };
  }

  const key = record.key || {};
  const remoteJid = key.remoteJid;
  if (typeof remoteJid !== 'string' || !remoteJid) {
    return { ok: false, reason: 'payload tanpa key.remoteJid yang valid' };
  }

  const fromMe = Boolean(key.fromMe);
  const isGroup = isGroupJid(remoteJid);

  // Grup: butuh identitas pengirim (key.participant). Tanpa itu, pesan grup
  // masuk ditolak CI4 -- lebih baik dibuang di sini dengan log jelas.
  if (isGroup && !fromMe && !key.participant) {
    return { ok: false, reason: 'pesan grup masuk tanpa key.participant -- dibuang (kontrak CI4 mewajibkan sender_jid)' };
  }

  // View-once: isinya memang tidak dapat diambil di perangkat tertaut, dan
  // sengaja TIDAK diunduh/disimpan (paritas WA-Gateway lama, CON-002). Dikirim
  // sebagai baris penanda supaya kasir tahu -- kalau tidak, pesannya hilang.
  const viewOnce = isViewOnceMessage(record);
  if (viewOnce && fromMe) {
    return { ok: false, skip: true, reason: 'view-once kiriman sendiri diabaikan' };
  }

  // Buka pembungkus (ephemeral, dokumen-berjudul, pesan diedit) SEBELUM
  // klasifikasi. View-once tidak dibuka karena isinya tidak akan diambil.
  const messageObj = viewOnce ? {} : unwrapMessage(record.message || {});

  if (!viewOnce) {
    // Metadata/sistem (reaction, protocol, stub) bukan konten pelanggan.
    const noise = noiseReason(record, messageObj);
    if (noise) {
      return { ok: false, skip: true, reason: 'pesan sistem/metadata dilewati: ' + noise };
    }

    // Edit pelanggan (secretEncryptedMessage): BUKAN konten baru -- tandai
    // pesan ASLI "diedit" lewat jalur lifecycle, JANGAN buat baris noise
    // 'unsupported' (TODO-F7). Teks hasil edit tidak terbaca (terenkripsi).
    const editTarget = extractEditTarget(messageObj);
    if (editTarget) {
      return {
        ok: true,
        lifecycle: {
          event: 'edited',
          targetWaMessageId: editTarget,
          chatId: remoteJid,
          jidType: isGroup ? 'group' : 'pn',
          timestamp: toIsoTimestamp(record.messageTimestamp),
          sender: { name: record.pushName || null, jid: null, phone: null },
        },
      };
    }
  }

  let messageType = null;
  let text = null;
  let extra = null;

  if (viewOnce) {
    messageType = 'unsupported';
    text = PENANDA_AWAL + 'pesan lihat-sekali' + PENANDA_AKHIR;
  } else {
    messageType = detectMessageType(messageObj);
    text = extractText(messageObj);
    extra = extractExtra(messageObj);

    if (messageType === null) {
      // Konten NYATA yang belum didukung: kirim penanda teks, JANGAN 'text' kosong
      // (yang akan ditolak CI4 400 dan menjadi dead permanen).
      messageType = 'unsupported';
      text = unsupportedLabel(messageObj);
    } else if (messageType === 'text' && (text === null || text === '')) {
      // Jaring pengaman: teks kosong (mis. hanya contextInfo) tidak boleh lolos
      // sebagai message_type='text' -- itu persis kelas bug yang lalu jadi dead.
      messageType = 'unsupported';
      text = PENANDA_AWAL + 'pesan tanpa isi teks' + PENANDA_AKHIR;
    }
  }

  const media = viewOnce ? null : extractMedia(messageObj);
  const quotedContext = viewOnce ? null : extractQuotedContext(record, messageObj);
  // TODO-F5 (masuk, fromMe=false) + TODO-F6 (keluar tersinkron dari WA
  // Web/HP, fromMe=true): keduanya memakai contextInfo yang SAMA
  // (extractForwardFlag()), jadi tidak ada lagi batas `!fromMe`. Forward
  // keluar lewat tombol "Teruskan" POS (kirimKeConversation di CI4) tetap
  // tidak terpengaruh -- itu jalur CI4 yang berbeda, tidak lewat sini.
  const isForwarded = !viewOnce ? extractForwardFlag(record) : false;

  const waMessageId = key.id || synthesizeMessageIdFallback(record);
  const senderJid = isGroup ? (key.participant || null) : (fromMe ? null : remoteJid);
  const senderPhone = jidToPhone(senderJid || remoteJid);

  const event = {
    messageId: waMessageId,
    chatId: remoteJid,
    jidType: isGroup ? 'group' : 'pn',
    sender: {
      name: record.pushName || null,
      phone: senderPhone,
      jid: senderJid,
    },
    sender_jid: senderJid,
    messageType,
    text: text || '',
    media: null, // Tahap 4: diisi oleh caller bila messageType butuh referensi media
    extra: extra || null, // Tahap 4: data terstruktur untuk location/contact
    timestamp: toIsoTimestamp(record.messageTimestamp),
    direction: fromMe ? 'outgoing' : 'incoming',
    // TODO-F5/TODO-F6: boolean eksplisit di objek event internal, arah apa
    // pun; caller (buffer/delivery) yang memutuskan field ini hanya
    // DIPERSIST/DIKIRIM bila true (pola aditif sama dengan quoted/extra --
    // payload pesan biasa tidak berubah).
    is_forwarded: isForwarded,
    quoted: quotedContext ? {
      wa_message_id: quotedContext.stanzaId,
      sender_jid: quotedContext.participant || null,
      snippet: buildQuotedSnippet(quotedContext.quotedMessage),
    } : null,
    // Metadata mentah dipertahankan untuk dipakai quotedStore (key+message
    // lengkap Evolution) -- BUKAN dikirim ke CI4, hanya dipakai internal.
    _evolutionKey: key,
    _evolutionMessage: messageObj,
    // Info media (base64 dari webhook + mimetype/nama file) -- diproses
    // oleh caller (webhookRoutes): blob disimpan ke mediaStore, lalu
    // event.media diisi dengan ref opaque sebelum masuk buffer.
    _evolutionMedia: media,
  };

  return { ok: true, event };
}

/**
 * @param {object} payload body webhook CONNECTION_UPDATE
 * @returns {{state: string|null, phone: string|null}}
 */
function normalizeConnectionUpdate(payload) {
  const data = payload.data || {};
  const state = data.state || data.status || null;
  const phone = data.wuid ? jidToPhone(data.wuid) : (data.number || null);
  return { state, phone };
}

/**
 * Map status Evolution (dari `fetchStatus`/MessageUpdate) ke status yang
 * dikonsumsi AuliaPos. Hanya status PESAN KELUAR yang relevan:
 *  - DELIVERY_ACK -> 'delivered' (sampai HP pelanggan)
 *  - READ         -> 'read'      (pelanggan membaca)
 * PLAYED/PENDING/SERVER_ACK/ERROR sengaja tidak dipetakan.
 * Sumber enum: `src/utils/renderStatus.ts` + `src/api/types/wa.types.ts`
 * (StatusMessage) di source Evolution API v2.3.7.
 */
const MESSAGE_STATUS_MAP = {
  DELIVERY_ACK: 'delivered',
  READ: 'read',
};

/**
 * Normalisasi payload webhook `MESSAGES_UPDATE` (status kirim/baca) menjadi
 * event status yang diteruskan ke CI4.
 *
 * Bentuk `data` (dari `whatsapp.baileys.service.ts:1613-1621`, dikirim pada
 * `sendDataWebhook(Events.MESSAGES_UPDATE, message)`):
 *   { keyId, remoteJid, fromMe, participant, status, pollUpdates, instanceId, messageId? }
 * `keyId` = wa_message_id pesan yang di-ACK.
 *
 * @param {object} payload
 * @returns {{ok:true, statusEvent:{waMessageId:string,chatId:string,status:string,timestamp:string}} | {ok:false, skip?:boolean, reason:string}}
 */
function normalizeMessagesUpdate(payload) {
  const data = payload.data || {};
  const waMessageId = data.keyId;
  const remoteJid = data.remoteJid;

  if (typeof remoteJid !== 'string' || !remoteJid) {
    return { ok: false, skip: true, reason: 'messages.update tanpa remoteJid' };
  }
  if (typeof waMessageId !== 'string' || !waMessageId) {
    return { ok: false, skip: true, reason: 'messages.update tanpa keyId' };
  }

  // Hanya status pesan KELUAR (fromMe=true) = receipt dari pelanggan untuk
  // pesan yang kita kirim. fromMe=false adalah update pesan MASUK (mis.
  // tanda baca perangkat kita sendiri) -- BUKAN receipt pelanggan.
  if (data.fromMe !== true) {
    return { ok: false, skip: true, reason: 'messages.update bukan pesan keluar (fromMe!=true)' };
  }

  // Grup dikecualikan (semantik read grup berbeda; konsisten dengan POS).
  if (isGroupJid(remoteJid)) {
    return { ok: false, skip: true, reason: 'messages.update grup diabaikan' };
  }

  const status = MESSAGE_STATUS_MAP[String(data.status || '').toUpperCase()];
  if (!status) {
    return { ok: false, skip: true, reason: `status "${data.status}" tidak dipetakan` };
  }

  return {
    ok: true,
    statusEvent: {
      waMessageId,
      chatId: remoteJid,
      status,
      timestamp: new Date().toISOString(),
    },
  };
}

module.exports = {
  normalizeMessagesUpsert,
  normalizeMessagesUpdate,
  pickMessageRecord,
  normalizeConnectionUpdate,
  detectMessageType,
  extractText,
  unwrapMessage,
  unsupportedLabel,
  extractExtra,
  extractQuotedContext,
  extractForwardFlag,
  extractEditTarget,
  buildQuotedSnippet,
  noiseReason,
  toIsoTimestamp,
};
