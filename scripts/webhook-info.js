'use strict';

/**
 * Tampilkan konfigurasi webhook Evolution untuk instance yang dikonfigurasi
 * (read-only). Dipakai untuk MEMASTIKAN `webhookBase64` sesuai `mediaMode`:
 *  - mediaMode 'base64'   -> webhookBase64 harus true
 *  - mediaMode 'ondemand' -> webhookBase64 harus FALSE (adapter mengunduh sendiri)
 *
 * Jalankan DARI folder repo (butuh .env):
 *   npm run webhook:info     atau     node scripts/webhook-info.js
 *
 * Header rahasia (x-adapter-webhook-secret) SENGAJA disensor di keluaran.
 */
const config = require('../src/config');

function sensorHeaders(json) {
  if (json && json.headers && typeof json.headers === 'object') {
    return { ...json, headers: { '<disembunyikan>': '...' } };
  }
  return json;
}

async function main() {
  const base = config.evolution.baseUrl;
  const instance = config.evolution.instance;
  if (!instance) {
    console.error('EVOLUTION_INSTANCE belum diisi di .env.');
    process.exit(1);
  }

  const url = `${base}/webhook/find/${encodeURIComponent(instance)}`;
  const res = await fetch(url, { headers: { apikey: config.evolution.apiKey } });
  const raw = await res.text();

  console.log(`mediaMode (adapter)   : ${config.mediaMode}`);
  console.log(`instance              : ${instance}`);
  console.log(`GET ${url} -> HTTP ${res.status}`);

  let json = null;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    console.log(raw.slice(0, 500));
    process.exit(res.ok ? 0 : 1);
  }

  const aman = sensorHeaders(json);
  console.log(JSON.stringify(aman, null, 2));

  const base64Aktif = Boolean(json && json.webhookBase64);
  const sesuai = config.mediaMode === 'base64' ? base64Aktif : !base64Aktif;
  console.log(`\nwebhookBase64=${base64Aktif} -> ${sesuai ? 'SESUAI' : 'TIDAK SESUAI'} dengan mediaMode=${config.mediaMode}`);
  if (!sesuai) {
    console.log('Perbaiki dengan: npm run webhook:set (butuh WEBHOOK_PUBLIC_URL di .env).');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Gagal membaca info webhook:', err.message);
  process.exit(1);
});
