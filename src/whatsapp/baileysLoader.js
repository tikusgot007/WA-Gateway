'use strict';

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
