'use strict';

const fs = require('fs');
const os = require('os');
const config = require('../config');

// baileys@6.7.24 adalah ESM-only ("type": "module"). Node modern (v20.19+/v22+)
// bisa require() modul ESM secara transparan, tapi runtime Node yang di-embed
// di Android (nodejs-mobile, masih berbasis Node 18) belum punya interop itu
// dan langsung ERR_REQUIRE_ESM kalau di-require() biasa. Solusinya: load
// SEKALI lewat dynamic import() di awal startup (lihat ensureBaileysLoaded()
// yang di-await di src/app/index.js sebelum apa pun lain jalan), baru sisanya
// di seluruh app (connectionManager.js, jidUtils.js) pakai getBaileys() yang
// sinkron -- supaya fungsi-fungsi yang memakainya (mis. classifyJid) tidak
// perlu ikut jadi async menjalar ke semua pemanggilnya.

// baileys (lewat Utils/crypto.js) langsung destructure `globalThis.crypto.subtle`
// di top-level module-nya, tanpa fallback. Di Node biasa (desktop, >= v18.20/19+)
// globalThis.crypto (Web Crypto API) sudah otomatis ada. Runtime Node yang
// di-embed nodejs-mobile (walau versinya 18.20.4, seharusnya sudah termasuk
// fitur ini) ternyata TIDAK menyediakannya -- kemungkinan besar karena build
// mobile-nya tidak menjalankan langkah bootstrap V8 yang sama seperti Node
// resmi. Node tetap punya implementasi WebCrypto yang sama persis lewat
// require('node:crypto').webcrypto, jadi cukup di-polyfill manual ke global
// SEBELUM baileys di-import, tanpa perlu ubah apa pun di sisi baileys.
if (!globalThis.crypto) {
  globalThis.crypto = require('node:crypto').webcrypto;
}

// Baileys (lib/Utils/messages-media.js) menulis file sementara ke
// os.tmpdir() untuk generate thumbnail otomatis saat kirim gambar/video/
// sticker KELUAR (dipicu karena sendMediaMessage() Gateway ini tidak
// pernah supply jpegThumbnail sendiri). Di Android, "/tmp" sistem TIDAK
// ADA/tidak writable di sandbox proses app.
//
// CATATAN KEJUJURAN -- percobaan pertama GAGAL: set env var TMPDIR lewat
// setenv() di native-lib.cpp (SEBELUM node::Start()) TERNYATA TIDAK
// CUKUP -- diverifikasi lewat testing sungguhan di HP, baris log
// "TMPDIR diset ke ..." muncul dengan path yang benar, TAPI Baileys tetap
// gagal ENOENT mencoba tulis ke "/tmp" literal. Kesimpulannya: runtime
// Node di build nodejs-mobile yang dipakai TIDAK membaca env var TMPDIR
// untuk os.tmpdir() (beda dari Node desktop biasa, sudah diverifikasi
// TMPDIR dihormati dengan benar di sana).
//
// Solusi yang TERBUKTI jalan (diuji langsung manggil prepareWAMessageMedia()
// Baileys sungguhan, bukan cuma teori): override os.tmpdir() di level
// JavaScript SECARA LANGSUNG, SEBELUM baileys di-import -- lihat
// ensureBaileysLoaded() di bawah. `import { tmpdir } from 'os'` di
// messages-media.js Baileys adalah live binding ke property `tmpdir` pada
// objek exports modul builtin 'os' -- mengubahnya lewat require('os')
// (CommonJS) di sini SEBELUM baileys pertama kali di-import tetap
// terlihat oleh Baileys, karena named export builtin ESM Node dibaca live
// dari objek CommonJS yang sama, bukan snapshot beku saat import.
//
// config.appTmpDir HANYA terisi di Android (lihat NodeBridge.writeEnvFile()
// yang menulis APP_TMP_DIR ke .env) -- di desktop, env var ini tidak
// pernah diisi, jadi override ini TIDAK PERNAH aktif & os.tmpdir() bawaan
// Node dipakai apa adanya (TIDAK ADA perubahan behavior untuk desktop).
if (config.appTmpDir) {
  fs.mkdirSync(config.appTmpDir, { recursive: true });
  os.tmpdir = () => config.appTmpDir;
}

let cachedModule = null;

async function ensureBaileysLoaded() {
  if (!cachedModule) {
    cachedModule = await import('baileys');
  }
  return cachedModule;
}

function getBaileys() {
  if (!cachedModule) {
    throw new Error(
      'Modul baileys belum di-load. Pastikan ensureBaileysLoaded() sudah di-await saat startup sebelum dipakai.'
    );
  }
  return cachedModule;
}

// Teruskan (Tahap 4): apakah versi Baileys yang terpasang mendukung penanda
// diteruskan native lewat `contextInfo` di tingkat konten?
//
// Mekanismenya sudah DIVERIFIKASI di source Baileys 6.7.24 yang ter-install
// (`lib/Utils/messages.js`): `generateWAMessageFromContent()` menggabungkan
// `contextInfo` tingkat pesan ke konten hasil, dan
// `generateForwardMessageContent()` menandai `isForwarded: true` begitu
// `contextInfo.forwardingScore > 0`. Versi yang lebih lama belum diperiksa --
// jadi Gateway tidak menebak API internal Baileys: kalau versinya di bawah
// ambang, penanda native dianggap tidak tersedia dan prefix teks yang dipakai
// (REQ-002). Ambangnya konservatif (hanya versi yang sudah diperiksa manual),
// supaya upgrade Baileys tidak diam-diam mematikan penanda native.
const FORWARD_MARKER_MIN_VERSION = [6, 7, 24];

function parseVersion(version) {
  return String(version).split('-')[0].split('.').map((part) => Number.parseInt(part, 10));
}

/** @returns {number} -1/0/1 seperti perbandingan string: a < b, a == b, a > b */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

let forwardMarkerSupported = null;

function supportsContentContextInfo() {
  if (forwardMarkerSupported !== null) return forwardMarkerSupported;
  let version = null;
  try {
    // eslint-disable-next-line global-require
    version = require('baileys/package.json').version;
  } catch (err) {
    // Versi tidak terbaca -> perlakukan sebagai tidak didukung (prefix teks),
    // supaya yang terjadi adalah degradasi yang terlihat, bukan penanda hilang
    // tanpa suara.
  }
  const parsed = version === null ? [] : parseVersion(version);
  forwardMarkerSupported = parsed.length === 3 && compareVersions(parsed, FORWARD_MARKER_MIN_VERSION) >= 0;
  return forwardMarkerSupported;
}

module.exports = { ensureBaileysLoaded, getBaileys, supportsContentContextInfo };
