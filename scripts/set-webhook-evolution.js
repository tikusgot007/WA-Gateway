'use strict';

/**
 * Daftarkan URL webhook adapter Evolution (branch spike/evolution) ke Evolution API.
 *
 * Jalankan: npm run webhook:set:evolution
 * Butuh di .env: EVOLUTION_BASE_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE,
 * dan WEBHOOK_PUBLIC_URL (URL lengkap yang bisa dijangkau SERVER Evolution,
 * mis. http://127.0.0.1:3000/evolution/webhook bila Evolution satu mesin,
 * atau http://<ip-pc-gateway>:3000/evolution/webhook bila terpisah).
 *
 * Event: MESSAGES_UPSERT, MESSAGES_UPDATE, CONNECTION_UPDATE, QRCODE_UPDATED.
 * base64=true WAJIB: adapter mengambil media masuk dari base64 di webhook.
 *
 * CATATAN: setelah set webhook, RESTART instance Evolution agar konfigurasi
 * webhook benar-benar dipakai (perilaku v2.3.7 yang terverifikasi).
 */
const config = require('../src/config');
const logger = require('../src/logging');
const evolutionClient = require('../src/evolution/client');

const EVENTS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'];

async function main() {
  const publicUrl = (process.env.WEBHOOK_PUBLIC_URL || '').trim();
  if (!publicUrl) {
    console.error('WEBHOOK_PUBLIC_URL belum diisi. Contoh: http://127.0.0.1:3000/evolution/webhook');
    process.exit(1);
  }
  if (!evolutionClient.isConfigured()) {
    console.error('EVOLUTION_API_KEY/EVOLUTION_INSTANCE belum diisi di .env.');
    process.exit(1);
  }

  const headers = config.evolution.webhookSecret
    ? { [config.evolution.webhookSecretHeader]: config.evolution.webhookSecret }
    : null;

  const result = await evolutionClient.setWebhook({
    url: publicUrl,
    events: EVENTS,
    headers,
    base64: true,
  });

  logger.info('[EVOLUTION] webhook terdaftar', { url: publicUrl, events: EVENTS, result });
  console.log('OK: webhook terdaftar di Evolution ->', publicUrl);
  console.log('PENTING: restart instance Evolution agar webhook dipakai (POST /instance/restart/{instance}).');
}

main().catch((err) => {
  console.error('Gagal mendaftarkan webhook:', err.message);
  process.exit(1);
});
