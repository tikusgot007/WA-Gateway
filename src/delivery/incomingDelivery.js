'use strict';

const config = require('../config');
const logger = require('../logging');
const incomingBuffer = require('../store/incomingBuffer');
const { overflowBuffer } = require('../store/overflowBuffer');
const { postToCI4 } = require('./ci4Client');

/**
 * Worker pengiriman pesan MASUK: Gateway -> CI4.
 *
 * Alur (sesuai spec): WhatsApp -> Gateway -> SQLite pending -> POST
 * HTTP ke CI4 -> CI4 simpan -> CI4 ACK -> Gateway tandai completed.
 *
 * Kalau HTTP ke CI4 gagal (network error, timeout, atau CI4 balas
 * error server), event TETAP pending di SQLite (tidak pernah
 * dihapus/hilang), attempts bertambah, dan dijadwalkan retry dengan
 * backoff (lihat incomingBuffer.markFailedAttempt). Idempotensi di
 * sisi CI4 (berdasarkan wa_message_id) menjamin retry TIDAK
 * membuat duplicate walau request yang sama terkirim berkali-kali.
 *
 * Worker ini jalan di interval tetap (config.deliveryIntervalMs),
 * bukan terus-menerus tanpa jeda -- supaya tidak membanjiri CI4
 * dengan request saat ada banyak event pending sekaligus.
 */

let timer = null;
let isRunning = false; // mencegah tick tumpang tindih kalau satu batch belum selesai

async function deliverOne(event) {
  const body = {
    wa_message_id: event.wa_message_id,
    chat_id: event.chat_id,
    jid_type: event.jid_type,
    contact_name: event.contact_name,
    phone: event.phone,
    sender_jid: event.sender_jid,
    message_type: event.message_type,
    text: event.text,
    message_timestamp: event.message_timestamp,
    direction: event.direction, // 'incoming' atau 'outgoing' (sinkron dari device lain)
    media: event.media_json ? JSON.parse(event.media_json) : null,
    // Task Group 1.5 (revisi LID-FIRST -> PN-LATER) -- metadata TAMBAHAN
    // saja (murni transport, Gateway tidak memutuskan apa pun dari ini),
    // lihat connectionManager.js _resolveLidForPhoneJid().
    identity_hint: event.identity_hint_json ? JSON.parse(event.identity_hint_json) : null,
  };

  const result = await postToCI4('/api/inbox/gateway/messages', body);

  if (result.ok) {
    incomingBuffer.markCompleted(event.id);
    logger.info('[DELIVERY] pesan masuk berhasil diteruskan ke CI4', {
      waMessageId: event.wa_message_id,
      duplicate: Boolean(result.json?.duplicate),
    });
    return;
  }

  const { delayMs } = incomingBuffer.markFailedAttempt(event.id, event.attempts, result.error);
  logger.warn('[DELIVERY] gagal meneruskan pesan masuk ke CI4, akan dicoba lagi', {
    waMessageId: event.wa_message_id,
    httpStatus: result.status,
    error: result.error,
    retryInMs: delayMs,
  });
}

async function tick() {
  if (isRunning) return; // batch sebelumnya masih jalan, lewati siklus ini
  isRunning = true;

  try {
    // M1 Wave 1 TASK-004 (REQ-011): kuras penampung sementara ke buffer utama
    // di AWAL siklus, sebelum mengambil event yang jatuh tempo. Satu percobaan
    // per event tanpa jeda; yang masih gagal tetap tertampung untuk siklus
    // berikutnya. Sengaja SEBELUM cek konfigurasi CI4 di bawah: ini hanya
    // penyimpanan lokal, tidak butuh CI4.
    overflowBuffer.drain((event) => incomingBuffer.enqueue(event));

    if (!config.ci4.baseUrl || !config.ci4.gatewayToken) {
      // Belum dikonfigurasi -- jangan spam warning tiap 5 detik, cukup
      // debug level (tetap tercatat kalau LOG_LEVEL=debug, tapi tidak
      // berisik di operasional normal jika module ini belum dipakai).
      logger.debug('[DELIVERY] CI4_BASE_URL/CI4_GATEWAY_TOKEN belum dikonfigurasi, delivery dilewati.');
      return;
    }

    const events = incomingBuffer.getDueEvents(20);
    for (const event of events) {
      await deliverOne(event);
    }
  } catch (err) {
    logger.error('[DELIVERY] error tak terduga saat memproses batch pengiriman', { error: err.message });
  } finally {
    isRunning = false;
  }
}

function start() {
  if (timer) return; // sudah jalan, jangan start dobel
  logger.info('[DELIVERY] worker pengiriman pesan masuk dimulai', {
    intervalMs: config.deliveryIntervalMs,
    ci4BaseUrl: config.ci4.baseUrl || '(belum diisi)',
  });
  timer = setInterval(tick, config.deliveryIntervalMs);
  // Jalankan sekali segera saat start, jangan tunggu interval pertama.
  tick();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// `tick` diekspos supaya test/simulate-*.js bisa memanggil satu siklus worker
// secara langsung (deterministik, tanpa menunggu timer nyata).
module.exports = { start, stop, tick };
