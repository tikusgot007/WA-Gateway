#!/usr/bin/env node
'use strict';

/**
 * Menyiapkan folder android/app/src/main/assets/nodejs-project/ -- salinan
 * dari src/, public/, package.json (+ package-lock.json) di root repo ini,
 * lengkap dengan node_modules siap pakai, untuk di-embed ke dalam APK
 * lewat Node.js runtime embedded (nodejs-mobile, lihat android/README.md).
 *
 * SENGAJA tidak disimpan sebagai salinan statis yang ikut di-commit --
 * source of truth Gateway HANYA src/ & public/ di root repo (satu source
 * code, dua target: desktop & Android). Jalankan script ini setiap kali
 * sebelum build APK, dan setiap kali source Gateway berubah:
 *
 *   node scripts/prepare-android-assets.js
 *   (atau: npm run android:prepare-assets)
 *
 * Kenapa node_modules di-install ULANG di sini (bukan disalin dari root
 * repo apa adanya): semua dependency Gateway adalah pure JavaScript
 * KECUALI `better-sqlite3` (native addon, dibutuhkan sistem operasi &
 * arsitektur CPU yang cocok saat di-compile/di-download). Karena Android
 * pakai CPU arsitektur berbeda (arm64/arm) dari mesin development
 * (biasanya x64), binary better-sqlite3 hasil install di sini TIDAK akan
 * jalan kalau ikut dibawa ke Android -- maka folder ini SENGAJA dihapus
 * setelah install (lihat di bawah), supaya `require('better-sqlite3')`
 * gagal dengan MODULE_NOT_FOUND di Android, dan Gateway otomatis pakai
 * fallback murni JavaScript (lihat src/store/incomingBuffer.js) tanpa
 * perlu konfigurasi tambahan apa pun.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const TARGET_DIR = path.join(REPO_ROOT, 'android/app/src/main/assets/nodejs-project');

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(`[prepare-android-assets] ${msg}`);
}

function copyIfExists(relSrc, relDest = relSrc) {
  const src = path.join(REPO_ROOT, relSrc);
  const dest = path.join(TARGET_DIR, relDest);
  if (!fs.existsSync(src)) {
    log(`(lewati, tidak ditemukan) ${relSrc}`);
    return;
  }
  fs.cpSync(src, dest, { recursive: true });
  log(`Disalin: ${relSrc} -> android/app/src/main/assets/nodejs-project/${relDest}`);
}

function main() {
  log(`Membersihkan ${TARGET_DIR} ...`);
  fs.rmSync(TARGET_DIR, { recursive: true, force: true });
  fs.mkdirSync(TARGET_DIR, { recursive: true });

  copyIfExists('src');
  copyIfExists('public');
  copyIfExists('package.json');
  copyIfExists('package-lock.json');

  log('Menjalankan "npm install --omit=dev --ignore-scripts" di dalam nodejs-project ...');
  execSync('npm install --omit=dev --ignore-scripts --no-audit --no-fund', {
    cwd: TARGET_DIR,
    stdio: 'inherit',
  });

  const betterSqlite3Dir = path.join(TARGET_DIR, 'node_modules/better-sqlite3');
  if (fs.existsSync(betterSqlite3Dir)) {
    fs.rmSync(betterSqlite3Dir, { recursive: true, force: true });
    log('Folder node_modules/better-sqlite3 dihapus (native addon, tidak kompatibel dengan Android -- fallback JSON otomatis dipakai, lihat src/store/incomingBuffer.js).');
  }

  // .env TIDAK ditulis di sini -- app Android menulis ulang file ini
  // sebelum tiap start (lihat NodeBridge.writeEnvFile di
  // android/app/src/main/java/com/auliapos/wagateway/NodeBridge.kt),
  // berdasarkan pengaturan yang diisi user di layar Setup.

  log('Selesai. nodejs-project siap di-bundle ke APK.');
  log('INGAT: jalankan ulang script ini setiap kali source src/ atau public/ berubah, sebelum build APK.');
}

main();
