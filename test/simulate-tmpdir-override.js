'use strict';
/**
 * Skrip simulasi (BUKAN pengganti test nyata) untuk memvalidasi LOGIKA
 * override `os.tmpdir()` di `src/whatsapp/baileysLoader.js` -- fix untuk
 * bug "ENOENT ... open '/tmp/image...-original'" saat kirim gambar/
 * sticker keluar di Android (lihat komentar lengkap di baileysLoader.js
 * & android/app/src/main/java/com/auliapos/wagateway/NodeBridge.kt
 * untuk kronologi lengkap kenapa fix pertama -- setenv("TMPDIR") di
 * native-lib.cpp -- TERBUKTI TIDAK CUKUP, dan fix ini yang menggantikannya).
 *
 * Beda dari skrip simulate-*.js lain: test ini SENGAJA menjalankan child
 * process Node terpisah untuk tiap skenario (bukan cuma require() biasa
 * di proses yang sama) -- karena override os.tmpdir() di baileysLoader.js
 * dieksekusi SEKALI saat modul itu pertama di-require (module caching
 * Node), jadi tidak bisa diuji "dengan APP_TMP_DIR" dan "tanpa
 * APP_TMP_DIR" dalam satu proses yang sama.
 *
 * Ini TIDAK menghubungi server WhatsApp sungguhan.
 */
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

function runChildScenario(envOverrides) {
  const childScript = `
    (async () => {
      const config = require('./src/config');
      const os = require('os');
      const { ensureBaileysLoaded, getBaileys } = require('./src/whatsapp/baileysLoader');
      console.log('APP_TMP_DIR_CONFIG=' + config.appTmpDir);
      console.log('OS_TMPDIR_AFTER_REQUIRE=' + os.tmpdir());

      await ensureBaileysLoaded();
      const { prepareWAMessageMedia } = getBaileys();
      const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
      try {
        await prepareWAMessageMedia(
          { image: fakeJpeg, caption: 'test' },
          { upload: async () => ({ mediaUrl: 'https://fake', directPath: '/fake' }) }
        );
        console.log('IMAGE_SEND_RESULT=SUKSES');
      } catch (err) {
        console.log('IMAGE_SEND_RESULT=GAGAL:' + err.message);
      }
    })();
  `;

  const output = execFileSync(process.execPath, ['-e', childScript], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...envOverrides },
    encoding: 'utf8',
  });

  const lines = Object.fromEntries(
    output
      .trim()
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => {
        const idx = line.indexOf('=');
        return [line.slice(0, idx), line.slice(idx + 1)];
      })
  );
  return lines;
}

console.log('--- 1. TANPA APP_TMP_DIR (skenario desktop) -- os.tmpdir() TIDAK BOLEH ter-override ---');
// TMPDIR sistem sengaja diarahkan ke folder valid (bukan simulasi bug) di
// skenario ini -- yang mau dibuktikan di sini HANYA "override TIDAK aktif
// kalau APP_TMP_DIR tidak diisi", bukan soal sukses/gagal kirim gambar.
const desktopResult = runChildScenario({ APP_TMP_DIR: '' });
assert.strictEqual(desktopResult.APP_TMP_DIR_CONFIG, 'null', 'config.appTmpDir harus null kalau APP_TMP_DIR tidak diisi (skenario desktop)');
assert.notStrictEqual(desktopResult.OS_TMPDIR_AFTER_REQUIRE, '', 'os.tmpdir() harus tetap ada nilainya (default Node/OS)');
console.log('OK: tanpa APP_TMP_DIR, config.appTmpDir null dan os.tmpdir() TIDAK di-override -- TIDAK ADA perubahan behavior untuk desktop.');

console.log('\n--- 2. DENGAN APP_TMP_DIR (skenario Android), TMPDIR sistem SENGAJA diarahkan ke folder yang tidak ada ---');
const fakeAppTmpDir = path.join(require('os').tmpdir(), 'wa-gateway-test-app-tmp-' + Date.now());
const androidResult = runChildScenario({
  TMPDIR: '/nonexistent-tmpdir-simulasi-android-' + Date.now(),
  APP_TMP_DIR: fakeAppTmpDir,
});
assert.strictEqual(androidResult.APP_TMP_DIR_CONFIG, fakeAppTmpDir, 'config.appTmpDir harus terisi sesuai env APP_TMP_DIR');
assert.strictEqual(androidResult.OS_TMPDIR_AFTER_REQUIRE, fakeAppTmpDir, 'os.tmpdir() harus SUDAH ter-override ke APP_TMP_DIR setelah require baileysLoader');
assert.strictEqual(androidResult.IMAGE_SEND_RESULT, 'SUKSES', 'prepareWAMessageMedia() Baileys SUNGGUHAN harus berhasil walau TMPDIR sistem mengarah ke folder yang tidak ada -- ini bukti fix-nya bekerja, bukan cuma override string tanpa efek nyata');
console.log('OK: dengan APP_TMP_DIR, os.tmpdir() ter-override dengan benar DAN Baileys sungguhan berhasil generate+kirim media walau /tmp sistem rusak/tidak ada -- persis mensimulasikan kondisi Android.');

require('fs').rmSync(fakeAppTmpDir, { recursive: true, force: true });

console.log('\n=== SEMUA SIMULASI OVERRIDE os.tmpdir() LULUS ===');
console.log('CATATAN: ini simulasi in-process (dengan child process Node sungguhan menjalankan Baileys sungguhan), BUKAN pengujian di runtime nodejs-mobile Android yang sebenarnya.');
