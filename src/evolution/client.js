'use strict';

const config = require('../config');

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

async function withTimeout(fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.evolution.requestTimeoutMs);
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

  const form = new FormData();
  form.append('number', String(number));
  form.append('mediatype', String(mediatype));
  if (caption) form.append('caption', String(caption));
  if (fileName) form.append('fileName', String(fileName));
  if (quoted && quoted.key && quoted.key.id) {
    form.append('quoted', JSON.stringify({ key: quoted.key, message: quoted.message || {} }));
  }
  const blob = new Blob([buffer], mimetype ? { type: mimetype } : undefined);
  form.append('file', blob, fileName || 'file');

  let res;
  try {
    res = await withTimeout((signal) => fetch(instancePath('/message/sendMedia'), {
      method: 'POST',
      headers: { apikey: config.evolution.apiKey },
      body: form,
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

/** GET /instance/connectionState/{instance} -> { instance: { state: open|close|connecting } } */
async function getConnectionState() {
  if (!isConfigured()) throw notConfiguredError();
  const res = await withTimeout((signal) => fetch(instancePath('/instance/connectionState'), {
    method: 'GET',
    headers: { apikey: config.evolution.apiKey },
    signal,
  }));
  const { json } = await parseJsonSafely(res);
  return json && json.instance ? json.instance.state : null;
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

module.exports = {
  isConfigured,
  sendText,
  sendMedia,
  sendSticker,
  getConnectionState,
  getGroupInfo,
  setWebhook,
};
