'use strict';
/**
 * TODO-F2: nomor di `evolution/state.js` cuma terisi dari webhook
 * CONNECTION_UPDATE, yang Evolution TIDAK kirim ulang kalau state tidak
 * berubah -- setelah adapter restart dengan sesi yang sudah connected
 * sebelumnya, nomor jadi tidak pernah terisi. heartbeat.js
 * refreshStateFromEvolution() sekarang membackfill-nya dari
 * evolutionClient.getInstancePhone() HANYA saat nomor belum diketahui.
 *
 * evolution/client di-stub (tanpa jaringan), sama seperti
 * simulate-evolution-adapter.js. Jalankan: node test/simulate-evolution-phone-backfill.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// HARUS sebelum modul src/ mana pun di-require, sama seperti test lain di
// folder ini -- config dibaca sekali saat load.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-phone-backfill-'));
process.env.SQLITE_PATH = path.join(tmpRoot, 'gateway.sqlite');
process.env.MEDIA_STORE_DIR = path.join(tmpRoot, 'media');
process.env.CI4_BASE_URL = '';
process.env.CI4_GATEWAY_TOKEN = '';
process.env.EVOLUTION_API_KEY = 'apikey-uji';
process.env.EVOLUTION_INSTANCE = 'inst-uji';
process.env.EVOLUTION_BASE_URL = 'http://127.0.0.1:8080';

const assert = require('assert');
const evolutionClient = require('../src/evolution/client');
const evolutionState = require('../src/evolution/state');
const heartbeat = require('../src/evolution/heartbeat');

let failures = 0;

function section(name) {
  console.log('\n--- ' + name + ' ---');
}

function check(label, cond) {
  if (cond) {
    console.log('OK   ' + label);
  } else {
    console.log('FAIL ' + label);
    failures += 1;
  }
}

/** Simulasi "sesudah restart proses": nomor hilang dari memori, status apa adanya. */
function lupakanNomor() {
  evolutionState._internal.phone = null;
}

async function main() {
  // --- stub evolutionClient (tanpa jaringan) ---
  let connectionStateImpl = async () => 'open';
  let instancePhoneCalls = 0;
  let instancePhoneImpl = async () => '628111222333';
  evolutionClient.getConnectionState = async (...args) => connectionStateImpl(...args);
  evolutionClient.getInstancePhone = async (...args) => {
    instancePhoneCalls += 1;
    return instancePhoneImpl(...args);
  };

  section('nomor kosong (restart) + state connected -> backfill dari getInstancePhone()');
  lupakanNomor();
  instancePhoneCalls = 0;
  connectionStateImpl = async () => 'open';
  instancePhoneImpl = async () => '628111222333';
  await heartbeat.refreshStateFromEvolution();
  check('connectedNumber terisi dari backfill', evolutionState.getSnapshot().connectedNumber === '628111222333');
  check('getInstancePhone dipanggil tepat 1x', instancePhoneCalls === 1);

  section('nomor SUDAH ada -> tidak memanggil getInstancePhone(), nomor lama dipertahankan');
  instancePhoneCalls = 0;
  instancePhoneImpl = async () => '620000000000'; // andai dipanggil, harus KETAHUAN nomor berubah -- jadi tidak boleh dipanggil
  connectionStateImpl = async () => 'open';
  await heartbeat.refreshStateFromEvolution();
  check('getInstancePhone TIDAK dipanggil', instancePhoneCalls === 0);
  check('nomor lama tetap dipertahankan', evolutionState.getSnapshot().connectedNumber === '628111222333');

  section('nomor kosong + state BUKAN connected (connecting) -> tidak memanggil getInstancePhone()');
  lupakanNomor();
  instancePhoneCalls = 0;
  connectionStateImpl = async () => 'connecting';
  await heartbeat.refreshStateFromEvolution();
  check('getInstancePhone TIDAK dipanggil saat belum connected', instancePhoneCalls === 0);
  check('connectedNumber tetap null', evolutionState.getSnapshot().connectedNumber === null);

  section('nomor kosong + backfill gagal (null) -> tidak crash, status tetap diterapkan tanpa nomor');
  lupakanNomor();
  connectionStateImpl = async () => 'open';
  instancePhoneImpl = async () => null;
  await assertDoesNotThrow(() => heartbeat.refreshStateFromEvolution());
  check('status tetap connected walau nomor gagal didapat', evolutionState.getSnapshot().status === 'connected');
  check('connectedNumber tetap null (bukan regresi, bukan crash)', evolutionState.getSnapshot().connectedNumber === null);

  section('nomor kosong + getInstancePhone() reject -> tidak crash, status tetap diterapkan tanpa nomor');
  lupakanNomor();
  instancePhoneImpl = async () => { throw new Error('jaringan putus'); };
  await assertDoesNotThrow(() => heartbeat.refreshStateFromEvolution());
  check('status tetap connected walau getInstancePhone() reject', evolutionState.getSnapshot().status === 'connected');
  check('connectedNumber tetap null', evolutionState.getSnapshot().connectedNumber === null);

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch (err) { /* abaikan */ }

  if (failures > 0) {
    console.error(`\n${failures} pemeriksaan GAGAL.`);
    process.exit(1);
  }
  console.log('\nSemua pemeriksaan OK.');
}

async function assertDoesNotThrow(fn) {
  try {
    await fn();
  } catch (err) {
    assert.fail('Seharusnya tidak melempar, tapi: ' + err.message);
  }
}

main().catch((err) => {
  console.error('GAGAL tidak terduga:', err);
  process.exit(1);
});
