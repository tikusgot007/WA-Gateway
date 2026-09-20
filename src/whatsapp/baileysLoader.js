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

module.exports = { ensureBaileysLoaded, getBaileys };
