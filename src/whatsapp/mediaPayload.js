'use strict';

const http = require('http');
const https = require('https');

const config = require('../config');

/**
 * Jenis media KELUAR yang didukung untuk sekarang -- SAMA seperti media MASUK
 * yang sudah didukung di connectionManager.js (image/document). Jenis lain
 * (audio/video/sticker/lokasi/dst) sengaja di luar scope, konsisten dengan
 * keterbatasan yang sama pada arah incoming.
 */
const VALID_MEDIA_TYPES = ['image', 'document'];

// Node.js Buffer.from(str, 'base64') SANGAT permisif -- diam-diam mengabaikan
// karakter yang tidak valid alih-alih melempar error, sehingga string acak
// pun bisa "berhasil" didecode jadi buffer yang isinya sampah. Pattern ini
// yang menjamin validasi sungguhan sebelum buffer sampah itu diteruskan ke
// Baileys/WhatsApp.
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode konten media berupa base64 menjadi Buffer, dengan validasi ukuran
 * maksimum (config.maxMediaUploadBytes) SEBELUM benar-benar mengalokasikan
 * buffer penuh -- supaya payload yang sudah kepanjangan langsung ditolak
 * tanpa perlu decode base64 raksasa dulu.
 *
 * File hasil decode ini HANYA dipegang di memory oleh pemanggil selama proses
 * kirim ke Baileys, TIDAK PERNAH ditulis ke disk di mana pun di modul ini.
 *
 * @param {unknown} base64
 * @returns {{ ok: true, buffer: Buffer } | { ok: false, reason: string }}
 */
function decodeBase64Media(base64) {
  if (typeof base64 !== 'string' || base64.trim().length === 0) {
    return { ok: false, reason: 'Konten media (base64) tidak boleh kosong' };
  }

  const cleaned = base64.replace(/\s/g, '');

  if (!BASE64_PATTERN.test(cleaned)) {
    return { ok: false, reason: 'Konten media (base64) mengandung karakter yang tidak valid' };
  }

  const padding = cleaned.endsWith('==') ? 2 : cleaned.endsWith('=') ? 1 : 0;
  const estimatedBytes = Math.floor((cleaned.length * 3) / 4) - padding;
  const maxMb = Math.round(config.maxMediaUploadBytes / 1024 / 1024);

  if (estimatedBytes > config.maxMediaUploadBytes) {
    return { ok: false, reason: `Ukuran media melebihi batas maksimum (${maxMb}MB)` };
  }

  let buffer;
  try {
    buffer = Buffer.from(cleaned, 'base64');
  } catch (err) {
    return { ok: false, reason: 'Konten media (base64) tidak valid' };
  }

  if (buffer.length === 0) {
    return { ok: false, reason: 'Konten media (base64) tidak valid/kosong setelah didecode' };
  }
  if (buffer.length > config.maxMediaUploadBytes) {
    return { ok: false, reason: `Ukuran media melebihi batas maksimum (${maxMb}MB)` };
  }

  return { ok: true, buffer };
}

/**
 * Ambil media dari sebuah URL http/https, dengan batas ukuran (dicek dari
 * header Content-Length kalau ada, DAN tetap dijaga saat streaming karena
 * Content-Length bisa tidak ada/tidak akurat) serta timeout.
 *
 * HANYA dipakai oleh endpoint test dashboard (/api/*) untuk kemudahan uji
 * manual (tinggal tempel link gambar). Endpoint machine-to-machine untuk CI4
 * (/send-media) SENGAJA TIDAK memakai ini -- CI4 selalu mengirim base64
 * langsung, supaya Gateway tidak perlu mempercayai/mengambil URL sembarangan
 * dari sistem lain.
 *
 * @param {string} url
 * @returns {Promise<{ ok: true, buffer: Buffer, mimetype: string | null } | { ok: false, reason: string }>}
 */
function fetchMediaFromUrl(url) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      resolve({ ok: false, reason: 'URL media tidak valid' });
      return;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      resolve({ ok: false, reason: 'URL media harus diawali http:// atau https://' });
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const maxBytes = config.maxMediaUploadBytes;
    const maxMb = Math.round(maxBytes / 1024 / 1024);
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = client.get(parsed, { timeout: config.mediaFetchTimeoutMs }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        finish({ ok: false, reason: `URL media membalas status HTTP ${res.statusCode}` });
        return;
      }

      const contentLength = parseInt(res.headers['content-length'], 10);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        res.destroy();
        finish({ ok: false, reason: `Ukuran media dari URL melebihi batas maksimum (${maxMb}MB)` });
        return;
      }

      const chunks = [];
      let total = 0;

      res.on('data', (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          res.destroy();
          finish({ ok: false, reason: `Ukuran media dari URL melebihi batas maksimum (${maxMb}MB)` });
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        finish({ ok: true, buffer: Buffer.concat(chunks), mimetype: res.headers['content-type'] || null });
      });

      res.on('error', (err) => {
        finish({ ok: false, reason: `Gagal mengunduh media dari URL: ${err.message}` });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Timeout mengunduh media dari URL'));
    });

    req.on('error', (err) => {
      finish({ ok: false, reason: `Gagal mengunduh media dari URL: ${err.message}` });
    });
  });
}

module.exports = { VALID_MEDIA_TYPES, decodeBase64Media, fetchMediaFromUrl };
