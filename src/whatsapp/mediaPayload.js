'use strict';

const http = require('http');
const https = require('https');

const config = require('../config');

/**
 * Jenis media KELUAR yang didukung untuk sekarang -- SAMA seperti media MASUK
 * yang sudah didukung di connectionManager.js (image/document/sticker).
 * Jenis lain (audio/video/lokasi/dst) sengaja di luar scope, konsisten
 * dengan keterbatasan yang sama pada arah incoming.
 */
const VALID_MEDIA_TYPES = ['image', 'document', 'sticker'];

// Magic bytes RIFF....WEBP -- lihat https://developers.google.com/speed/webp/docs/riff_container
// Byte 0-3: "RIFF", byte 8-11: "WEBP" (byte 4-7 = ukuran file, diabaikan).
const WEBP_RIFF_MAGIC = Buffer.from('RIFF', 'ascii');
const WEBP_FORMAT_MAGIC = Buffer.from('WEBP', 'ascii');

/**
 * Validasi MINIMAL bahwa sebuah buffer benar-benar file WebP (dicek dari
 * magic bytes container RIFF, BUKAN dari field `mimetype` yang dikirim
 * client -- field itu gampang salah/dipalsukan). Sengaja TIDAK memvalidasi
 * struktur WebP lebih dalam (ukuran dimensi, VP8/VP8L/VP8X chunk, dst) --
 * WhatsApp/Baileys sendiri yang akan menolak kalau isinya tetap tidak valid
 * setelah lolos cek dasar ini, cukup untuk menyaring kesalahan paling umum
 * (kasir kelupaan konversi, upload JPEG/PNG mentah sebagai "sticker").
 *
 * Gateway SENGAJA TIDAK melakukan konversi otomatis dari format lain
 * (JPEG/PNG/dll) ke WebP -- tidak ada dependency konversi gambar di
 * project ini (`sharp` yang muncul di node_modules HANYALAH optional
 * peer dependency milik `baileys` sendiri, BUKAN dependency project ini
 * -- lihat node_modules/baileys/package.json `peerDependencies.sharp`),
 * dan menambahkannya HANYA untuk fitur ini berarti mengulang masalah yang
 * sama seperti `better-sqlite3` untuk build Android (native addon, lihat
 * android/README.md). Kasir/POS bertanggung jawab mengirim file WebP
 * yang sudah valid.
 *
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isValidWebp(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  return (
    buffer.subarray(0, 4).equals(WEBP_RIFF_MAGIC) &&
    buffer.subarray(8, 12).equals(WEBP_FORMAT_MAGIC)
  );
}

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

module.exports = { VALID_MEDIA_TYPES, decodeBase64Media, fetchMediaFromUrl, isValidWebp };
