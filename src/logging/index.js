'use strict';

const fs = require('fs');
const pino = require('pino');
const config = require('../config');

// Field yang tidak boleh pernah muncul di log (jaga-jaga kalau ada objek besar ter-log tidak sengaja)
const REDACT_PATHS = [
  'creds',
  'authState',
  'auth',
  '*.creds',
  '*.authState',
  'req.headers.authorization',
];

let destination;
if (config.logFolder) {
  try {
    fs.mkdirSync(config.logFolder, { recursive: true });
    destination = pino.destination({
      dest: `${config.logFolder}/gateway.log`,
      mkdir: true,
      sync: false,
    });
  } catch (err) {
    // Jika gagal membuat folder log, tetap jalan dengan console saja.
    // eslint-disable-next-line no-console
    console.error('Gagal membuat folder log, fallback ke console:', err.message);
    destination = undefined;
  }
}

const baseLogger = pino(
  {
    level: config.logLevel,
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  destination
);

// In-memory ring buffer untuk event log yang ditampilkan di dashboard.
// Ini terpisah dari file log; hanya untuk kebutuhan visual di Test Dashboard.
const MAX_EVENTS = 300;
const eventBuffer = [];

function pushEvent(level, message) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
  };
  eventBuffer.push(entry);
  if (eventBuffer.length > MAX_EVENTS) {
    eventBuffer.shift();
  }
  return entry;
}

/**
 * Logger wrapper: menulis ke pino (console/file) DAN ke ring buffer untuk dashboard.
 * Gunakan ini di seluruh aplikasi, bukan pino langsung, supaya dashboard event log
 * selalu konsisten dengan log file/console.
 */
const logger = {
  info(message, meta) {
    baseLogger.info(meta || {}, message);
    pushEvent('info', message);
  },
  warn(message, meta) {
    baseLogger.warn(meta || {}, message);
    pushEvent('warn', message);
  },
  error(message, meta) {
    baseLogger.error(meta || {}, message);
    pushEvent('error', message);
  },
  debug(message, meta) {
    baseLogger.debug(meta || {}, message);
  },
  getRecentEvents() {
    return eventBuffer.slice().reverse(); // terbaru dulu
  },
  raw: baseLogger,
};

module.exports = logger;
