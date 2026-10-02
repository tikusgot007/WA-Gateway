'use strict';

/**
 * setup-instance.js -- provisioning Evolution untuk adapter.
 *
 * Melakukan tiga hal secara idempoten:
 *   1. Membuat instance WhatsApp (jika belum ada) dengan nama dari .env adapter.
 *   2. Mendaftarkan webhook adapter ke Evolution.
 *   3. Restart instance supaya webhook benar-benar dipakai (catatan operasional
 *      #2 di README: webhook baru aktif setelah instance direstart).
 *
 * Pairing (scan QR) TIDAK dilakukan di sini -- itu harus dilakukan operator
 * lewat Evolution Manager, karena siapa pun yang melihat QR bisa menautkan
 * perangkat ke nomor tersebut.
 *
 * Dijalankan dengan cwd = folder adapter; konfigurasi dari .env adapter.
 */

const config = require('../src/config');
const evolutionClient = require('../src/evolution/client');

const INSTANCE = config.evolution.instance;
const BASE = config.evolution.baseUrl;
const API_KEY = config.evolution.apiKey;
const WEBHOOK_URL =
  (process.env.WEBHOOK_PUBLIC_URL || '').trim() ||
  `http://127.0.0.1:${config.port}${config.evolution.webhookPath}`;

const EVENTS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'];

function log(msg, extra) {
  const stamp = new Date().toISOString();
  console.log(extra === undefined ? `${stamp} ${msg}` : `${stamp} ${msg} ${JSON.stringify(extra)}`);
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { apikey: API_KEY, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function getState() {
  const r = await api('GET', `/instance/connectionState/${INSTANCE}`);
  if (r.status === 200 && r.json && r.json.instance) return r.json.instance.state;
  return null;
}

async function main() {
  log('=== SETUP INSTANCE ===', { base: BASE, instance: INSTANCE, webhookUrl: WEBHOOK_URL });
  if (!API_KEY) throw new Error('EVOLUTION_API_KEY kosong di .env adapter');

  let state = await getState();
  if (state) {
    log('instance sudah ada', { state });
  } else {
    log('instance belum ada -> membuat');
    const created = await api('POST', '/instance/create', {
      instanceName: INSTANCE,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
    });
    const createdInstance = created.json && created.json.instance ? created.json.instance : null;
    // Jangan log body mentah: respons create memuat qrcode.base64 / pairing code.
    log('create', {
      status: created.status,
      instance: createdInstance ? createdInstance.instanceName : null,
      state: createdInstance ? createdInstance.status : null,
    });
    if (created.status >= 400) throw new Error('gagal membuat instance');
  }

  const headers = config.evolution.webhookSecret
    ? { [config.evolution.webhookSecretHeader]: config.evolution.webhookSecret }
    : null;

  const result = await evolutionClient.setWebhook({
    url: WEBHOOK_URL,
    events: EVENTS,
    headers,
    base64: config.mediaMode === 'base64',
  });
  // Jangan log `result` mentah: memuat headers.x-adapter-webhook-secret.
  log('webhook terdaftar', {
    url: WEBHOOK_URL,
    events: EVENTS,
    enabled: result ? result.enabled : null,
    webhookId: result && result.id ? result.id : null,
  });

  const restarted = await api('POST', `/instance/restart/${INSTANCE}`);
  // Jangan log body restart: Evolution mengembalikan QR/pairing code juga.
  log('restart', { status: restarted.status });

  state = await getState();
  log('state akhir', { state });
  if (state !== 'open') {
    const managerUrl = `${BASE.replace(/\/+$/, '')}/manager`;
    log(`BELUM TERTAUT -- buka Evolution Manager lalu scan QR: ${managerUrl} (instance ${INSTANCE})`);
  }
  log('=== SELESAI ===');
}

main().catch((err) => {
  console.error(new Date().toISOString(), 'GAGAL:', err.message);
  process.exit(1);
});
