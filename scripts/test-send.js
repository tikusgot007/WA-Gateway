'use strict';

/**
 * test-send.js -- kirim satu pesan uji lewat kontrak adapter (/send) untuk
 * memastikan jalur keluar + validasi secret webhook tetap sehat.
 *
 * Memakai token CI4 dari .env adapter sendiri dan TIDAK mencetak tokennya.
 * Output: D:\kilo\logs\test-send.log
 */

const crypto = require('crypto');
const config = require('../src/config');

const PORT = config.port;
const TARGET = process.argv[2] || '628563324637@s.whatsapp.net';
const TEXT = process.argv[3] || 'uji adapter pasca-aktivasi secret webhook';

function log(msg) {
  console.log(new Date().toISOString(), msg);
}

(async () => {
  log('=== TEST SEND ===');
  if (!config.ci4.gatewayToken) { log('GAGAL: CI4_GATEWAY_TOKEN kosong'); process.exit(1); }

  const body = JSON.stringify({
    operation_id: crypto.randomBytes(16).toString('hex'),
    chat_id: TARGET,
    text: TEXT,
  });

  const res = await fetch(`http://127.0.0.1:${PORT}/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.ci4.gatewayToken}`,
    },
    body,
  });
  const text = await res.text();
  log(`POST /send -> HTTP ${res.status}`);
  log('respons: ' + text.slice(0, 400));
  log('=== SELESAI ===');
})().catch((err) => {
  console.error('GAGAL:', err.message);
  process.exit(1);
});
