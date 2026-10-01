'use strict';

/**
 * check-state.js -- laporkan state koneksi instance Evolution saat ini
 * (dipakai untuk membuktikan sesi WhatsApp selamat setelah reboot).
 *
 * Output: D:\kilo\logs\check-state.log
 */

const config = require('../src/config');

const BASE = config.evolution.baseUrl;
const INSTANCE = config.evolution.instance;

(async () => {
  console.log(new Date().toISOString(), '=== CHECK STATE ===');
  const res = await fetch(`${BASE}/instance/connectionState/${encodeURIComponent(INSTANCE)}`, {
    headers: { apikey: config.evolution.apiKey },
  });
  const text = await res.text();
  console.log(new Date().toISOString(), `GET /instance/connectionState -> HTTP ${res.status}`);
  console.log(new Date().toISOString(), 'body: ' + text.slice(0, 300));
  console.log(new Date().toISOString(), '=== SELESAI ===');
})().catch((err) => {
  console.error('GAGAL:', err.message);
  process.exit(1);
});
