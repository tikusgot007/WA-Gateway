'use strict';

/**
 * Daftarkan URL webhook adapter ke Evolution API.
 *
 * Jalankan: npm run webhook:set
 * Butuh di .env: EVOLUTION_BASE_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE,
 * dan WEBHOOK_PUBLIC_URL (URL lengkap yang bisa dijangkau SERVER Evolution,
 * mis. http://192.168.1.20:3000/evolution/webhook).
 *
 * Event yang didaftarkan: MESSAGES_UPSERT (pesan masuk/keluar),
 * MESSAGES_UPDATE (status kirim), CONNECTION_UPDATE (status koneksi),
 * QRCODE_UPDATED (QR mode Baileys).
 */
const config = require('../src/config');
const logger = require('../src/logging');
const evolutionClient = require('../src/evolution/client');

const EVENTS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'];

async function main() {
  const publicUrl = (process.env.WEBHOOK_PUBLIC_URL || '').trim();
  if (!publicUrl) {
    console.error('WEBHOOK_PUBLIC_URL belum diisi. Contoh: http://192.168.1.20:3000/evolution/webhook');
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
    base64: config.mediaMode === 'base64',
  });

  logger.info('[EVOLUTION] webhook terdaftar', { url: publicUrl, events: EVENTS, result });
  console.log('OK: webhook terdaftar di Evolution ->', publicUrl);
}

main().catch((err) => {
  console.error('Gagal mendaftarkan webhook:', err.message);
  process.exit(1);
});
