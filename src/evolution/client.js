'use strict';

const config = require('../config');
const { jidToPhone } = require('./jid');

/**
 * Klien REST Evolution API (v2.3.7) untuk adapter.
 *
 * SENGAJA hanya memakai `fetch`/`FormData`/`Blob` bawaan Node (>=18), tanpa
 * dependency HTTP baru. Endpoint & bentuk payload diverifikasi dari:
 *  - docs resmi: https://docs.evolutionfoundation.com.br/evolution-api/*
 *  - source code resmi: github.com/evolution-foundation/evolution-api
 *    (src/api/routes/sendMessage.router.ts, src/api/dto/sendMessage.dto.ts,
 *    src/validate/message.schema.ts, commit terverifikasi 2026-10-01)
 *
 * Auth: header `apikey` (BUKAN Bearer) -- beda dari kontrak CI4 yang pakai
 * `Authorization: Bearer <token>`. Jangan disamakan.
 *
 * Endpoint kirim mengembalikan HTTP 201 dengan body
 * `{ key: { id, remoteJid, fromMe }, message: {...}, status }`.
 * `key.id` dipakai sebagai `wa_message_id` yang dilaporkan ke CI4.
 *
 * CATATAN VERIFIKASI (lihat plan §7 item 1): satu halaman OpenAPI docs
 * menampilkan body `sendText` sebagai `{ number, textMessage: { text } }`,
 * TAPI `src/validate/message.schema.ts` resmi (sumber kebenaran runtime)
 * mewajibkan bentuk FLAT `{ number, text }`. Klien ini memakai bentuk flat
 * sesuai schema. WAJIB diverifikasi ulang ke instance nyata di Tahap 2
 * (Swagger `/docs` instance) sebelum dianggap final.
 */

function isConfigured() {
  return Boolean(config.evolution.apiKey && config.evolution.instance);
}

function notConfiguredError() {
  const err = new Error('EVOLUTION_API_KEY/EVOLUTION_INSTANCE belum dikonfigurasi -- adapter tidak bisa mengirim.');
  err.code = 'EVOLUTION_NOT_CONFIGURED';
  return err;
}

function instancePath(suffix) {
  return `${config.evolution.baseUrl}${suffix}/${encodeURIComponent(config.evolution.instance)}`;
}

async function withTimeout(fn, timeoutMs = config.evolution.requestTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function networkError(err) {
  const e = new Error(
    err.name === 'AbortError' ? 'Timeout menghubungi Evolution API' : `Gagal menghubungi Evolution API: ${err.message}`
  );
  e.code = 'EVOLUTION_NETWORK';
  return e;
}

async function parseJsonSafely(res) {
  const rawText = await res.text();
  try {
    return { json: JSON.parse(rawText), rawText };
  } catch (err) {
    return { json: null, rawText };
  }
}

function sendFailedError(json, rawText, httpStatus) {
  const reason = (json && json.error && json.error.message)
    || (json && json.message)
    || rawText.slice(0, 200)
    || `HTTP ${httpStatus}`;
  const e = new Error(`Evolution API menolak kirim: ${reason}`);
  e.code = 'EVOLUTION_SEND_FAILED';
  e.httpStatus = httpStatus;
  return e;
}

/** @param {object|null} quoted bentuk { key:{id,remoteJid,fromMe}, message } atau null */
function withQuoted(body, quoted) {
  if (quoted && quoted.key && quoted.key.id) {
    return { ...body, quoted: { key: quoted.key, message: quoted.message || {} } };
  }
  return body;
}

/**
 * @returns {Promise<{messageId: string|null, timestamp: string, quoteApplied: boolean, key: object|null, message: object|null}>}
 */
async function sendText({ number, text, quoted = null }) {
  if (!isConfigured()) throw notConfiguredError();

  const body = withQuoted({ number: String(number), text: String(text) }, quoted);

  let res;
  try {
    res = await withTimeout((signal) => fetch(instancePath('/message/sendText'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.evolution.apiKey },
      body: JSON.stringify(body),
      signal,
    }));
  } catch (err) {
    throw networkError(err);
  }

  const { json, rawText } = await parseJsonSafely(res);
  if (!res.ok || !json || !json.key) throw sendFailedError(json, rawText, res.status);

  return {
    messageId: json.key.id || null,
    timestamp: new Date().toISOString(),
    quoteApplied: Boolean(quoted && quoted.key && quoted.key.id),
    key: json.key,
    message: json.message || null,
  };
}

/**
 * Kirim media keluar (image/document/video/audio) via multipart/form-data.
 * @param {{number:string, mediatype:'image'|'document'|'video'|'audio', buffer:Buffer, fileName?:string, mimetype?:string, caption?:string, quoted?:object|null}} args
 */
async function sendMedia({ number, mediatype, buffer, fileName, mimetype, caption = null, quoted = null }) {
  if (!isConfigured()) throw notConfiguredError();

  // Gunakan body JSON + base64, bukan multipart/form-data.
  //
  // Field multipart `quoted` masuk sebagai string pada req.body di Evolution.
  // Schema Evolution mengharapkan quoted sebagai object dan router tidak
  // melakukan JSON.parse pada field multipart tersebut. Karena itu quoted
  // media dapat ditolak sebelum mencapai Baileys.
  //
  // Evolution menerima media sebagai base64 melalui field `media`, sehingga
  // body JSON menjaga quoted tetap berupa object seperti pada sendText.
  const body = {
    number: String(number),
    mediatype: String(mediatype),
    media: buffer.toString('base64'),
    ...(mimetype ? { mimetype: String(mimetype) } : {}),
    ...(fileName ? { fileName: String(fileName) } : {}),
    ...(caption ? { caption: String(caption) } : {}),
    ...(quoted && quoted.key && quoted.key.id
      ? { quoted: { key: quoted.key, message: quoted.message || {} } }
      : {}),
  };

  let res;
  try {
    res = await withTimeout((signal) => fetch(instancePath('/message/sendMedia'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.evolution.apiKey,
      },
      body: JSON.stringify(body),
      signal,
    }));
  } catch (err) {
    throw networkError(err);
  }

  const { json, rawText } = await parseJsonSafely(res);
  if (!res.ok || !json || !json.key) throw sendFailedError(json, rawText, res.status);

  return {
    messageId: json.key.id || null,
    timestamp: new Date().toISOString(),
    mediaRef: null, // Evolution tidak memberi referensi Baileys (directPath/mediaKey)
    quoteApplied: Boolean(quoted && quoted.key && quoted.key.id),
    key: json.key,
    message: json.message || null,
  };
}

/**
 * Kirim sticker keluar (WebP) via JSON dengan `sticker` = base64.
 *
 * PENTING: Evolution v2.3.7 `mediaSticker()`
 * (`whatsapp.baileys.service.ts:2957`) memakai `data.sticker` -- BUKAN hasil
 * upload multipart `file` -- untuk konversi WebP, sehingga mengirim
 * `multipart/form-data` dengan field `file` membuat `convertToWebP(undefined)`
 * gagal dengan HTTP 500 "Invalid URL". Mengirim `sticker` sebagai base64 di
 * body JSON membuat `isBase64()` true lalu `convertToWebP()` men-decode dengan
 * benar.
 *
 * ponytail: bergantung pada `sharp` bawaan Evolution untuk (re)encode WebP dari
 * byte yang kita kirim; upgrade path: pakai `notConvertSticker` bila versi
 * Evolution mendukungnya (tidak ada di DTO v2.3.7).
 *
 * @param {{number:string, buffer:Buffer, quoted?:object|null}} args
 */
async function sendSticker({ number, buffer, quoted = null }) {
  if (!isConfigured()) throw notConfiguredError();

  const body = withQuoted({ number: String(number), sticker: buffer.toString('base64') }, quoted);

  let res;
  try {
    res = await withTimeout((signal) => fetch(instancePath('/message/sendSticker'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.evolution.apiKey },
      body: JSON.stringify(body),
      signal,
    }));
  } catch (err) {
    throw networkError(err);
  }

  const { json, rawText } = await parseJsonSafely(res);
  if (!res.ok || !json || !json.key) throw sendFailedError(json, rawText, res.status);

  return {
    messageId: json.key.id || null,
    timestamp: new Date().toISOString(),
    mediaRef: null,
    quoteApplied: Boolean(quoted && quoted.key && quoted.key.id),
    key: json.key,
    message: json.message || null,
  };
}

/**
 * POST /chat/markMessageAsRead/{instance} -- tandai pesan MASUK pelanggan
 * sebagai sudah dibaca supaya WhatsApp mengirim blue tick ke pelanggan.
 *
 * Body DIVERIFIKASI dari source v2.3.7 (`src/validate/chat.schema.ts`
 * readMessageSchema + `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts:3676`
 * markMessageAsRead -> `client.readMessages`): `{ readMessages: [{ id, fromMe, remoteJid }] }`.
 * Instance melanggan event ini tanpa setup tambahan (route chat sudah aktif).
 *
 * `fromMe:false` -- yang ditandai adalah pesan MASUK dari pelanggan.
 * Evolution hanya memakai key dengan `remoteJid` grup atau PN user
 * (`isJidGroup || isPnUser`); `@lid` di-skip oleh Evolution.
 *
 * Respons sukses HTTP 201 `{ message:'Read messages', read:'success' }`;
 * gagal -> 500. Tidak ada dedup server: mengirim ulang aman (idempoten).
 *
 * @param {{remoteJid:string, keys:string[]}} args
 * @returns {Promise<{requested:number, response:object|null}>}
 */
async function markMessageAsRead({ remoteJid, keys }) {
  if (!isConfigured()) throw notConfiguredError();

  const readMessages = (keys || [])
    .filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 255)
    .map((id) => ({ remoteJid: String(remoteJid), fromMe: false, id }));

  if (readMessages.length === 0) {
    const e = new Error('Tidak ada wa_message_id yang valid untuk ditandai dibaca.');
    e.code = 'EVOLUTION_NO_READ_KEYS';
    throw e;
  }

  let res;
  try {
    res = await withTimeout((signal) => fetch(instancePath('/chat/markMessageAsRead'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.evolution.apiKey },
      body: JSON.stringify({ readMessages }),
      signal,
    }));
  } catch (err) {
    throw networkError(err);
  }

  const { json, rawText } = await parseJsonSafely(res);
  if (!res.ok) throw sendFailedError(json, rawText, res.status);

  return { requested: readMessages.length, response: json };
}

/** GET /instance/connectionState/{instance} -> { instance: { state: open|close|connecting } } */
async function getConnectionState(timeoutMs) {
  if (!isConfigured()) throw notConfiguredError();
  const res = await withTimeout((signal) => fetch(instancePath('/instance/connectionState'), {
    method: 'GET',
    headers: { apikey: config.evolution.apiKey },
    signal,
  }), timeoutMs);
  const { json } = await parseJsonSafely(res);
  return json && json.instance ? json.instance.state : null;
}

/**
 * GET /instance/fetchInstances?instanceName={instance} -- `number`/`ownerJid`
 * instance ini, dipakai heartbeat.js untuk mengisi ulang nomor yang hilang
 * dari memori setelah adapter restart (TODO-F2): `getConnectionState()` di
 * atas TIDAK mengembalikan nomor, hanya `state`, dan nomor di memori
 * (`evolution/state.js`) cuma terisi dari webhook CONNECTION_UPDATE, yang
 * TIDAK dikirim ulang Evolution kalau state tidak berubah sejak restart.
 *
 * BELUM DIVERIFIKASI ke instance Evolution nyata (v2.3.7) -- bentuk respons
 * di sini diambil dari dokumentasi publik Evolution API, bukan source code
 * resmi seperti fungsi lain di file ini. WAJIB dicek manual ke instance
 * sungguhan sebelum dianggap final (lihat catatan di atas file ini).
 *
 * Gagal/bentuk tak terduga -> null, TIDAK throw -- dipanggil dari siklus
 * heartbeat, kegagalan di sini tidak boleh menggagalkan heartbeat itu
 * sendiri (sama seperti pola getConnectionState()).
 * @returns {Promise<string|null>} nomor polos (digit saja) atau null.
 */
async function getInstancePhone(timeoutMs) {
  if (!isConfigured()) return null;

  let res;
  try {
    res = await withTimeout((signal) => fetch(
      `${config.evolution.baseUrl}/instance/fetchInstances?instanceName=${encodeURIComponent(config.evolution.instance)}`,
      { method: 'GET', headers: { apikey: config.evolution.apiKey }, signal }
    ), timeoutMs);
  } catch (err) {
    return null;
  }

  const { json } = await parseJsonSafely(res);
  if (!json) return null;

  // Bentuk respons bisa array (daftar instance) atau objek tunggal --
  // ditangani keduanya karena belum diverifikasi ke instance nyata (lihat
  // komentar di atas).
  const entry = Array.isArray(json) ? json[0] : json;
  if (!entry || typeof entry !== 'object') return null;

  const nomor = entry.number || jidToPhone(entry.ownerJid);
  return nomor ? String(nomor).replace(/[^0-9]/g, '') || null : null;
}

/**
 * GET /group/findGroupInfos/{instance}?groupJid=<jid> -- subject grup +
 * daftar peserta. `participants[].phoneNumber` dipakai memetakan identitas
 * LID peserta -> JID nomor (WhatsApp kini banyak memakai `@lid`).
 * @returns {{subject: string|null, participants: Array<{id:string, phoneNumber:string|null}>}|null}
 */
async function getGroupInfo(groupJid) {
  if (!isConfigured()) throw notConfiguredError();
  const url = `${config.evolution.baseUrl}/group/findGroupInfos/${encodeURIComponent(config.evolution.instance)}?groupJid=${encodeURIComponent(groupJid)}`;
  let res;
  try {
    res = await withTimeout((signal) => fetch(url, {
      method: 'GET',
      headers: { apikey: config.evolution.apiKey },
      signal,
    }));
  } catch (err) {
    throw networkError(err);
  }
  const { json } = await parseJsonSafely(res);
  if (!res.ok || !json) return null;
  return {
    subject: typeof json.subject === 'string' ? json.subject : null,
    participants: Array.isArray(json.participants) ? json.participants : [],
  };
}

/**
 * POST /webhook/set/{instance} -- daftarkan URL webhook + daftar event.
 *
 * Bentuk body DIVERIFIKASI dari source v2.3.7
 * (`src/api/integrations/event/webhook/webhook.schema.ts`): body WAJIB
 * dibungkus `{ webhook: { enabled, url, headers?, byEvents?, base64?, events? } }`
 * -- bukan flat seperti contoh di dokumentasi. `enabled` & `url` wajib.
 * Nama field event-flags adalah `byEvents` (bukan `webhookByEvents`).
 */
async function setWebhook({ url, events, headers = null, base64 = false }) {
  if (!isConfigured()) throw notConfiguredError();
  const webhook = { enabled: true, url, events, base64 };
  if (headers) webhook.headers = headers;
  const body = { webhook };

  const res = await withTimeout((signal) => fetch(instancePath('/webhook/set'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: config.evolution.apiKey },
    body: JSON.stringify(body),
    signal,
  }));
  const { json, rawText } = await parseJsonSafely(res);
  if (!res.ok) throw sendFailedError(json, rawText, res.status);
  return json;
}

/**
 * POST /chat/getBase64FromMediaMessage/{instance}
 *
 * Dipakai saat `EVOLUTION_MEDIA_MODE=ondemand` (webhook TANPA base64): adapter
 * meminta Evolution mengambilkan blob satu pesan berdasarkan key-nya. Dengan
 * begitu badan webhook selalu kecil, sehingga berkas besar pun tetap terbaca
 * dan bisa diberi baris penanda (bukan ditolak 413 lalu hilang).
 *
 * Body `{ message: { key } }` -- Evolution mencari pesannya sendiri
 * (whatsapp.baileys.service.ts:3853). Balasan: `{ mediaType, fileName,
 * mimetype, base64, buffer }`.
 *
 * @param {object} key key Baileys pesan (id, remoteJid, fromMe, participant...)
 * @param {{maxBytes?:number}} [opts] pengaman: bila Content-Length balasan
 *        melebihi ini, unduhan dibatalkan (err.code = MEDIA_TOO_LARGE).
 * @returns {Promise<{base64:string, mimetype:string|null, fileName:string|null, mediaType:string|null}>}
 */
async function getMediaBase64(key, opts = {}) {
  if (!isConfigured()) throw notConfiguredError();

  let res;
  try {
    res = await withTimeout((signal) => fetch(instancePath('/chat/getBase64FromMediaMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.evolution.apiKey },
      body: JSON.stringify({ message: { key } }),
      signal,
    }), config.evolution.mediaFetchTimeoutMs);
  } catch (err) {
    throw networkError(err);
  }

  const maxBytes = Number(opts.maxBytes) || 0;
  const contentLength = Number(res.headers.get('content-length') || 0);
  if (maxBytes > 0 && contentLength > 0 && contentLength > Math.ceil((maxBytes * 4) / 3) + 65536) {
    try {
      if (res.body && typeof res.body.cancel === 'function') await res.body.cancel();
    } catch (err) { /* abaikan */ }
    const e = new Error('Media terlalu besar untuk diunduh dari Evolution');
    e.code = 'MEDIA_TOO_LARGE';
    throw e;
  }

  const { json, rawText } = await parseJsonSafely(res);
  if (!res.ok || !json || typeof json.base64 !== 'string' || !json.base64) {
    const reason = (json && (json.message || (json.error && json.error.message)))
      || rawText.slice(0, 200)
      || `HTTP ${res.status}`;
    const e = new Error(`Evolution gagal memberi media: ${reason}`);
    e.code = 'EVOLUTION_MEDIA_FAILED';
    e.httpStatus = res.status;
    throw e;
  }

  return {
    base64: json.base64,
    mimetype: typeof json.mimetype === 'string' ? json.mimetype : null,
    fileName: typeof json.fileName === 'string' ? json.fileName : null,
    mediaType: typeof json.mediaType === 'string' ? json.mediaType : null,
  };
}

module.exports = {
  isConfigured,
  sendText,
  sendMedia,
  sendSticker,
  markMessageAsRead,
  getConnectionState,
  getInstancePhone,
  getGroupInfo,
  setWebhook,
  getMediaBase64,
};
