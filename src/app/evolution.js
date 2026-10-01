'use strict';

const config = require('../config');
const logger = require('../logging');
const { startServer } = require('../api/evolutionServer');
const incomingDelivery = require('../delivery/incomingDelivery');
const evolutionHeartbeat = require('../evolution/heartbeat');
const incomingBuffer = require('../store/incomingBuffer');
const outgoingOperationService = require('../delivery/outgoingOperationService');

/**
 * Entry point ADAPTER EVOLUTION (spike) -- jalur terpisah dari Gateway Baileys.
 * Jalankan: npm run start:evolution
 *
 * TIDAK memuat Baileys: tidak ada auth/QR/sesi WhatsApp lokal. Sesi dipegang
 * server Evolution API (Docker, terpisah); adapter hanya menerima webhook &
 * memanggil REST Evolution. Yang dipakai ulang dari WA-Gateway: buffer
 * durable + worker delivery ke CI4 (src/store, src/delivery) dan kontrak
 * HTTP CI4 yang sama.
 */
async function main() {
  logger.info('[EVOLUTION] adapter starting', {
    host: config.host,
    port: config.port,
    evolutionConfigured: Boolean(config.evolution.apiKey && config.evolution.instance),
    evolutionBaseUrl: config.evolution.baseUrl,
    evolutionInstance: config.evolution.instance || '(belum diisi)',
    ci4BaseUrl: config.ci4.baseUrl || '(belum diisi)',
  });

  if (!config.evolution.apiKey || !config.evolution.instance) {
    logger.warn('[EVOLUTION] EVOLUTION_API_KEY/EVOLUTION_INSTANCE belum diisi -- /send akan ditolak sampai dikonfigurasi.');
  }

  const server = startServer();

  // Worker yang sama dengan WA-Gateway: kuras buffer durable ke CI4.
  incomingDelivery.start();
  evolutionHeartbeat.start();

  incomingBuffer.logDeadLetterStartup();
  outgoingOperationService.runStartupRecovery();

  const shutdown = (signal) => {
    logger.info(`[EVOLUTION] menerima ${signal}, shutting down...`);
    incomingDelivery.stop();
    evolutionHeartbeat.stop();
    server.close(() => {
      logger.info('[EVOLUTION] shutdown selesai.');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error(`[EVOLUTION] unhandled rejection: ${reason?.message || reason}`);
  });
  process.on('uncaughtException', (err) => {
    logger.error(`[EVOLUTION] uncaught exception: ${err?.message || err}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error saat startup adapter Evolution:', err);
  process.exit(1);
});
