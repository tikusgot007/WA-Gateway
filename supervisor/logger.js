'use strict';

// Logger minimal untuk Supervisor. SENGAJA terpisah dari src/logging (milik
// Gateway) -- Supervisor hanya butuh log peristiwa proses (start/stop/crash/
// unauthorized), bukan log aplikasi Gateway yang sudah lengkap sendiri.
//
// JANGAN PERNAH log token/credential di sini (lihat masing-masing pemanggil).

const MAX_EVENTS = 300;
const eventBuffer = [];

function record(level, message) {
  const entry = { time: new Date().toISOString(), level, message };
  // eslint-disable-next-line no-console
  console[level === 'error' ? 'error' : 'log'](`[supervisor] ${entry.time} ${level.toUpperCase()} ${message}`);
  eventBuffer.push(entry);
  if (eventBuffer.length > MAX_EVENTS) eventBuffer.shift();
  return entry;
}

module.exports = {
  info: (message) => record('info', message),
  warn: (message) => record('warn', message),
  error: (message) => record('error', message),
  getRecentEvents: () => eventBuffer.slice().reverse(),
};
