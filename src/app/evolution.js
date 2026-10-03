'use strict';

const config = require('../config');
const logger = require('../logging');
const { startServer } = require('../api/server');
const incomingDelivery = require('../delivery/incomingDelivery');
const evolutionHeartbeat = require('../evolution/heartbeat');
const incomingBuffer = require('../store/incomingBuffer');
const outgoingOperationService = require('../delivery/outgoingOperationService');
const mediaStore = require('../evolution/mediaStore');
const quotedStore = require('../evolution/quotedStore');

/**
 * Entry point ADAPTER EVOLUTION. Jalankan: npm start (atau node src/app/evolution.js).
 *
 * TIDAK memuat Baileys: tidak ada auth/QR/sesi WhatsApp lokal. Sesi dipegang
 * server Evolution API (Docker, terpisah); adapter hanya menerima webhook &
 * memanggil REST Evolution. Yang dipakai ulang dari WA-Gateway: buffer
 * durable + worker delivery ke CI4 (src/store, src/delivery) dan kontrak
 * HTTP CI4 yang sama.
 */
/**
 * TODO-O2: jalankan retensi yang sudah ada tapi sebelumnya tak pernah
 * dipanggil -- media (MEDIA_RETENTION_DAYS), kutipan (QUOTED_STORE_TTL_MS),
 * dan baris `completed` di incoming_queue (INCOMING_QUEUE_RETENTION_DAYS).
 * Semua fail-soft: kegagalan prune dicatat, TIDAK menghalangi start.
 */
function runMaintenancePrune() {
  try {
    const media = mediaStore.prune();
    if (media > 0) logger.info('[MAINTENANCE] media dipangkas', { removed: media });
  } catch (err) {
    logger.error('[MAINTENANCE] gagal memangkas media', { error: err.message });
  }

  try {
    const quoted = quotedStore.prune();
    if (quoted > 0) logger.info('[MAINTENANCE] kutipan dipangkas', { removed: quoted });
  } catch (err) {
    logger.error('[MAINTENANCE] gagal memangkas kutipan', { error: err.message });
  }

  try {
    const completed = incomingBuffer.pruneCompleted(
      config.incomingQueueRetentionDays * 24 * 3600 * 1000
    );
    if (completed > 0) logger.info('[MAINTENANCE] antrean completed dipangkas', { removed: completed });
  } catch (err) {
    logger.error('[MAINTENANCE] gagal memangkas antrean completed', { error: err.message });
  }
}

const MAINTENANCE_INTERVAL_MS = 24 * 3600 * 1000;

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
  runMaintenancePrune();
  setInterval(runMaintenancePrune, MAINTENANCE_INTERVAL_MS).unref();

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
