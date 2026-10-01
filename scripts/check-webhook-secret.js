'use strict';

/**
 * check-webhook-secret.js -- bandingkan secret yang dipegang adapter dengan
 * header yang benar-benar didaftarkan ke Evolution. TIDAK mencetak nilainya.
 *
 * Output: D:\kilo\logs\check-webhook-secret.log
 */

const config = require('../src/config');

const BASE = config.evolution.baseUrl;
const INSTANCE = config.evolution.instance;
const API_KEY = config.evolution.apiKey;

function log(msg) {
  console.log(new Date().toISOString(), msg);
}

(async () => {
  log('=== CHECK WEBHOOK SECRET ===');
  log(`adapter: secretTerisi=${Boolean(config.evolution.webhookSecret)} panjang=${config.evolution.webhookSecret.length} header=${config.evolution.webhookSecretHeader}`);

  const res = await fetch(`${BASE}/webhook/find/${encodeURIComponent(INSTANCE)}`, {
    headers: { apikey: API_KEY },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* biarkan null */ }
  log(`GET /webhook/find -> HTTP ${res.status}`);
  if (!json) { log('respons tidak bisa diparse'); return; }

  const url = json.url || (json.webhook && json.webhook.url);
  const headers = json.headers || (json.webhook && json.webhook.headers) || {};
  const names = Object.keys(headers);
  log(`url terdaftar: ${url}`);
  log(`nama header terdaftar: ${names.join(', ') || '(tidak ada)'}`);

  const target = config.evolution.webhookSecretHeader.toLowerCase();
  const found = names.find((n) => n.toLowerCase() === target);
  if (!found) {
    log('HASIL: header secret TIDAK terdaftar di Evolution -> semua webhook akan ditolak');
    return;
  }
  const match = headers[found] === config.evolution.webhookSecret;
  log(`HASIL: header '${found}' terdaftar=${Boolean(found)} nilaiCocok=${match}`);
  if (!match) log('HASIL: nilai header berbeda dari secret adapter -> webhook akan ditolak');
  log('=== SELESAI ===');
})().catch((err) => {
  console.error('GAGAL:', err.message);
  process.exit(1);
});
