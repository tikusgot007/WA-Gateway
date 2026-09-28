'use strict';
/**
 * Skrip simulasi (BUKAN pengganti test E2E nyata) untuk kontrak KEGAGALAN
 * endpoint POST /media/download (src/api/ci4Routes.js) dan untuk mekanisme
 * batas waktu unduhan (src/whatsapp/boundedDownload.js).
 *
 * Latar belakang (plan-bugfix-inbox-media-unavailable-v1.0):
 * catch di /media/download dulu memetakan SEMUA error dari
 * downloadMediaByRef() ke 410 MEDIA_UNAVAILABLE. 410 adalah sinyal
 * PERMANEN yang dibaca CI4 -- Inbox::media() menulis
 * media_confirmed_gone_at dan semua request berikutnya di-short-circuit
 * tanpa pernah menghubungi Gateway lagi. Satu error sementara karena itu
 * bisa memblacklist foto yang utuh selamanya.
 *
 * Sinyal asli sudah DIUKUR (TASK-010, bukti build/task-010-expiry-signal-evidence.md):
 * host media membalas 403 untuk tanda tangan kedaluwarsa, tanda tangan
 * rusak, MAUPUN objek yang tidak ada -- ketiganya identik, jadi 403 tidak
 * bisa dipakai sebagai tanda "kadaluarsa". Karena itu tidak ada error yang
 * dipetakan ke 410 kecuali 410 eksplisit dari host media (belum pernah
 * teramati).
 *
 * TIDAK menghubungi server WhatsApp sungguhan: connectionManager di-stub.
 */
const assert = require('assert');
const { once } = require('node:events');

const config = require('../src/config');
const connectionManager = require('../src/whatsapp/connectionManager');
const { unduhDenganBatas } = require('../src/whatsapp/boundedDownload');
const { createServer } = require('../src/api/server');

const TOKEN = 'token-simulasi-media-download';

// requireCI4Token membaca config.ci4.gatewayToken saat request berjalan,
// jadi menyetelnya di sini cukup -- tidak perlu .env sungguhan dan
// tidak menyentuh folder auth/ sama sekali.
config.ci4.gatewayToken = TOKEN;

const downloadMediaByRefAsli = connectionManager.downloadMediaByRef.bind(connectionManager);

/** Body request yang valid (semua guard 400 di route harus lolos). */
function payload(override = {}) {
  return {
    media_type: 'image',
    direct_path: '/v/t62.7117-24/1234567890/9876543210?ccb=11-4&oh=abc&oe=def',
    media_key_base64: Buffer.from('kunci-media-simulasi-32-byte!!').toString('base64'),
    mimetype: 'image/jpeg',
    ...override,
  };
}

/**
 * Bentuk error axios NYATA dari host media -- diverifikasi 2026-09-28 lewat
 * scripts/probe-axios-error-shape.js terhadap axios yang terpasang:
 * AxiosError, code 'ERR_BAD_REQUEST', `.response.status` terisi, TANPA
 * `.output` (jadi bukan Boom).
 */
function errorAxios(status) {
  const err = new Error(`Request failed with status code ${status}`);
  err.code = 'ERR_BAD_REQUEST';
  err.status = status;
  err.response = { status, statusText: status === 403 ? 'Forbidden' : 'Unknown' };
  return err;
}

/** Error yang dilempar Baileys saat kunci dekripsi tidak cocok. */
function errorDekripsi() {
  return new Error('error:1C800064:Provider routines::bad decrypt');
}

/** Error timeout dari unduhDenganBatas()/TASK-009. */
function errorTimeout() {
  const err = new Error(`unduhan media melewati batas waktu ${config.mediaDownloadTimeoutMs}ms`);
  err.code = 'MEDIA_DOWNLOAD_TIMEOUT';
  return err;
}

/**
 * Kirim POST /media/download ke app Express yang dijalankan in-process
 * (port 0 = ephemeral, jadi tidak bentrok dengan Gateway live di 3000).
 */
async function callDownload(baseUrl, body) {
  const response = await fetch(`${baseUrl}/media/download`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  let json = null;

  try {
    json = JSON.parse(buffer.toString('utf8'));
  } catch (err) {
    // body binary (kasus sukses) -- json sengaja tetap null
  }

  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    contentLength: response.headers.get('content-length'),
    buffer,
    json,
  };
}

/** Bentuk respons kegagalan yang dibaca CI4 (lihat Inbox::media()). */
function assertBentukKegagalan(hasil, konteks) {
  assert.ok(hasil.json !== null, `${konteks}: body gagal harus JSON, bukan binary/random`);
  assert.strictEqual(hasil.json.success, false, `${konteks}: success harus false`);
  assert.strictEqual(typeof hasil.json.error_code, 'string', `${konteks}: error_code harus string`);
  assert.ok(hasil.json.error_code.length > 0, `${konteks}: error_code tidak boleh kosong (CI4 membacanya)`);
  assert.ok(
    typeof hasil.json.message === 'string' && hasil.json.message.length > 0,
    `${konteks}: message harus string non-kosong`
  );
}

// ===================================================================
// Bagian B -- mekanisme batas waktu unduhan (TASK-009)
// ===================================================================

/** Stream async-iterable yang tidak pernah selesai sampai dihancurkan. */
function streamMenggantung() {
  const status = { destroyed: false };
  return {
    status,
    stream: {
      destroy() {
        status.destroyed = true;
      },
      [Symbol.asyncIterator]() {
        return { next: () => new Promise(() => {}) };
      },
    },
  };
}

/** Stream async-iterable sederhana yang langsung memberi isi. */
function streamDari(chunks) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next() {
          if (i >= chunks.length) return Promise.resolve({ done: true, value: undefined });
          return Promise.resolve({ done: false, value: chunks[i++] });
        },
      };
    },
  };
}

async function jalankanUjiMekanisme() {
  const hasil = {};

  async function kasus(nama, fn) {
    try {
      await fn();
      console.log(`LULUS  ${nama}`);
      hasil[nama] = true;
    } catch (err) {
      console.log(`GAGAL  ${nama}`);
      console.log(`       alasan: ${err.message}`);
      hasil[nama] = false;
    }
  }

  await kasus('TASK-009a: stream selesai normal -> Buffer utuh', async () => {
    const isi = [Buffer.from('halo '), Buffer.from('media')];
    const out = await unduhDenganBatas(() => Promise.resolve(streamDari(isi)), 1000);
    assert.ok(out.equals(Buffer.from('halo media')), 'isi buffer harus gabungan utuh');
  });

  await kasus('TASK-009b: stream menggantung -> tolak MEDIA_DOWNLOAD_TIMEOUT + stream dihancurkan', async () => {
    const { stream, status } = streamMenggantung();
    const mulai = Date.now();
    let ditolak = null;

    try {
      await unduhDenganBatas(() => Promise.resolve(stream), 80);
    } catch (err) {
      ditolak = err;
    }

    const lewat = Date.now() - mulai;

    assert.ok(ditolak !== null, 'harus menolak, bukan menggantung selamanya');
    assert.strictEqual(ditolak.code, 'MEDIA_DOWNLOAD_TIMEOUT', 'kode error harus MEDIA_DOWNLOAD_TIMEOUT');
    assert.ok(lewat >= 60, `harus menunggu sekitar batas waktu, dapat ${lewat}ms`);
    assert.strictEqual(status.destroyed, true, 'stream WAJIB dihancurkan supaya transfer tidak lanjut di latar');
  });

  await kasus('TASK-009c: pembuatan stream lebih lambat dari batas -> tetap ditolak timeout', async () => {
    const { stream } = streamMenggantung();
    let ditolak = null;

    try {
      await unduhDenganBatas(
        () => new Promise((resolve) => setTimeout(() => resolve(stream), 300)),
        60
      );
    } catch (err) {
      ditolak = err;
    }

    assert.ok(ditolak !== null, 'waktu tunggu pembuatan stream juga harus ikut dibatasi');
    assert.strictEqual(ditolak.code, 'MEDIA_DOWNLOAD_TIMEOUT');
  });

  await kasus('TASK-009d: error asli dari host diteruskan apa adanya (tidak jadi timeout)', async () => {
    const asli = errorAxios(403);
    let ditolak = null;

    try {
      await unduhDenganBatas(() => Promise.reject(asli), 500);
    } catch (err) {
      ditolak = err;
    }

    assert.strictEqual(ditolak, asli, 'objek error asli harus diteruskan, bukan dibungkus');
    assert.strictEqual(ditolak.response.status, 403, 'status host harus tetap terbaca pemanggil');
  });

  return hasil;
}

async function main() {
  const app = createServer();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  console.log(`App Express test berjalan di ${baseUrl}`);
  console.log('(tidak menghubungi server WhatsApp sungguhan -- downloadMediaByRef di-stub)\n');

  console.log('--- Bagian A: kontrak respons /media/download ---');
  const hasil = {};

  async function jalankan(nama, stub, asserti) {
    connectionManager.downloadMediaByRef = stub;
    const respons = await callDownload(baseUrl, payload());

    try {
      asserti(respons);
      console.log(`LULUS  ${nama}`);
      return { ok: true, respons };
    } catch (err) {
      console.log(`GAGAL  ${nama}`);
      console.log(`       alasan: ${err.message}`);
      console.log(`       aktual: HTTP ${respons.status} ${JSON.stringify(respons.json)}`);
      return { ok: false, respons };
    }
  }

  // --- TASK-002a (REQ-001): error sementara tanpa respons HTTP -> 503 -----
  // Bentuk "socket not open": tidak ada host yang menjawab, murni gangguan
  // koneksi. Media utuh, hanya Gateway yang sedang bermasalah.
  hasil.transienTanpaRespons = await jalankan(
    'TASK-002a: error sementara (socket not open) -> 503',
    async () => {
      throw new Error('socket not open');
    },
    (respons) => {
      assert.strictEqual(respons.status, 503, 'error sementara harus 503 (bisa dicoba ulang), bukan 410');
      assertBentukKegagalan(respons, 'error sementara');
      assert.notStrictEqual(
        respons.json.error_code,
        'MEDIA_UNAVAILABLE',
        'error sementara TIDAK BOLEH memakai kode permanen -- CI4 menulis media_confirmed_gone_at untuk itu'
      );
    }
  );

  // --- TASK-002b (REQ-001): tolakan NYATA host media (403) -> 503 --------
  // Inilah sinyal yang benar-benar terukur di TASK-010 (tanda tangan
  // kedaluwarsa/rusak/objek tidak ada, ketiganya 403). Kalau ini dipetakan
  // ke 410, foto yang tanda tangannya cuma basi akan dihapus permanen.
  hasil.transienTolakanHost = await jalankan(
    'TASK-002b: host media menolak 403 -> 503 (bukan permanen)',
    async () => {
      throw errorAxios(403);
    },
    (respons) => {
      assert.strictEqual(respons.status, 503, 'tolakan host yang ambigu harus 503, bukan 410');
      assertBentukKegagalan(respons, 'tolakan host 403');
      assert.notStrictEqual(respons.json.error_code, 'MEDIA_UNAVAILABLE', '403 tidak boleh jadi permanen');
    }
  );

  // --- TASK-002c (REQ-001): kegagalan dekripsi -> 503 --------------------
  hasil.gagalDekripsi = await jalankan(
    'TASK-002c: kunci dekripsi salah (bad decrypt) -> 503',
    async () => {
      throw errorDekripsi();
    },
    (respons) => {
      assert.strictEqual(respons.status, 503, 'kegagalan dekripsi juga sementara sampai terbukti sebaliknya');
      assertBentukKegagalan(respons, 'kegagalan dekripsi');
      assert.notStrictEqual(respons.json.error_code, 'MEDIA_UNAVAILABLE');
    }
  );

  // --- TASK-003 (CON-006): jalur 410 eksplisit tetap ada & bentuknya utuh -
  // Pemicu di sini adalah error dengan `.response.status = 410` -- bentuk
  // yang SAMA dengan error axios nyata yang sudah diverifikasi
  // (scripts/probe-axios-error-shape.js), hanya statusnya 410.
  //
  // CATATAN KETERBATASAN: status 410 dari host media BELUM PERNAH teramati
  // (yang terukur selalu 403/404). Jadi test ini mengunci KONTRAK respons
  // 410 yang dibaca CI4, bukan membuktikan WhatsApp pernah mengirimnya.
  hasil.kadaluarsa = await jalankan(
    'TASK-003: host menyatakan 410 -> kontrak MEDIA_UNAVAILABLE utuh (CON-006)',
    async () => {
      throw errorAxios(410);
    },
    (respons) => {
      assert.strictEqual(respons.status, 410, 'jalur 410 eksplisit harus diteruskan apa adanya');
      assertBentukKegagalan(respons, 'jalur 410');
      assert.strictEqual(
        respons.json.error_code,
        'MEDIA_UNAVAILABLE',
        'CI4 hanya membedakan permanen lewat HTTP 410; error_code tidak boleh diubah diam-diam'
      );
    }
  );

  // --- TASK-004 (REQ-005): timeout -> 504 + error_code sendiri ----------
  hasil.timeout = await jalankan(
    'TASK-004: timeout download -> 504 dengan error_code sendiri',
    async () => {
      throw errorTimeout();
    },
    (respons) => {
      assert.strictEqual(respons.status, 504, 'timeout harus 504 (batas waktu Gateway), bukan 410/503');
      assertBentukKegagalan(respons, 'timeout');
      assert.notStrictEqual(
        respons.json.error_code,
        'MEDIA_UNAVAILABLE',
        'timeout tidak boleh memakai kode kadaluarsa'
      );
      assert.notStrictEqual(
        respons.json.error_code,
        hasil.transienTanpaRespons.respons.json.error_code,
        'timeout harus punya error_code BERBEDA dari error sementara'
      );
    }
  );

  // --- TASK-005 (CON-001): sukses -> binary apa adanya ------------------
  const isiBuffer = Buffer.from('data-gambar-palsu-untuk-simulasi-media-download');
  hasil.sukses = await jalankan(
    'TASK-005: sukses -> 200 + byte utuh + Content-Type dari request',
    async () => isiBuffer,
    (respons) => {
      assert.strictEqual(respons.status, 200, 'sukses harus 200');
      assert.ok(
        respons.buffer.equals(isiBuffer),
        'body harus binary hasil dekripsi apa adanya, tanpa diubah/tidak jadi JSON'
      );
      assert.ok(
        String(respons.contentType).startsWith('image/jpeg'),
        `Content-Type harus mengikuti mimetype dari request, dapat: ${respons.contentType}`
      );
      assert.strictEqual(
        respons.contentLength,
        String(isiBuffer.length),
        'Content-Length harus mencocoki jumlah byte'
      );
    }
  );

  server.close();
  await once(server, 'close');
  connectionManager.downloadMediaByRef = downloadMediaByRefAsli;

  console.log('\n--- Bagian B: mekanisme batas waktu unduhan ---');
  const hasilMekanisme = await jalankanUjiMekanisme();

  const semua = { ...hasil, ...hasilMekanisme };
  const gagal = Object.entries(semua).filter(([, ok]) => !ok).map(([k]) => k);
  const total = Object.keys(semua).length;

  console.log('');
  if (gagal.length) {
    console.log(`=== ${gagal.length} DARI ${total} KASUS GAGAL: ${gagal.join(', ')} ===`);
    process.exitCode = 1;
    return;
  }

  console.log(`=== SEMUA ${total} KASUS LULUS ===`);
}

main().catch((err) => {
  console.error('FATAL: simulasi tidak bisa dijalankan:', err.message);
  process.exitCode = 1;
});
