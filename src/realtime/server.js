'use strict';

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const config = require('../config');
const logger = require('../logging');

const clients = new Set();

// Heartbeat protocol-level (bukan JSON application message): server ping,
// browser/`ws` auto-balas pong. Tanpa pong pada cycle berikutnya -> terminate.
const HEARTBEAT_INTERVAL_MS = 30000;

function base64UrlDecode(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function verifyTicket(ticket) {
  if (!ticket || !config.ci4.gatewayToken) return null;

  const parts = String(ticket).split('.');
  if (parts.length !== 2) return null;

  const payloadPart = parts[0];
  const signaturePart = parts[1];

  const expected = crypto
    .createHmac('sha256', config.ci4.gatewayToken)
    .update(payloadPart)
    .digest('hex');

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(signaturePart, 'utf8');

  if (
    expectedBuffer.length !== actualBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadPart).toString('utf8'));
  } catch (_) {
    return null;
  }

  const userId = Number(payload.sub);
  const exp = Number(payload.exp);

  if (!Number.isInteger(userId) || userId < 1) return null;
  if (!Number.isInteger(exp) || exp <= Math.floor(Date.now() / 1000)) return null;

  return { userId, exp };
}

function sendJson(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState !== ws.OPEN) continue;

    try {
      ws.send(message);
    } catch (err) {
      // Satu client yang rusak tidak boleh memutus fan-out ke client lain.
      // Hapus dari registry segera; event close juga akan membersihkan jika
      // transport masih hidup, dan terminate memastikan socket yang gagal
      // tidak terus menjadi target broadcast berikutnya.
      clients.delete(ws);
      try {
        ws.terminate();
      } catch (_) {
        // Ignore cleanup failure; broadcast ke client lain tetap berjalan.
      }

      logger.warn('[REALTIME] broadcast send failed; client removed', {
        error: err.message,
        clients: clients.size,
      });
    }
  }
}

function attachRealtime(server, options = {}) {
  const heartbeatIntervalMs = Number.isFinite(options.heartbeatIntervalMs) && options.heartbeatIntervalMs > 0
    ? options.heartbeatIntervalMs
    : HEARTBEAT_INTERVAL_MS;

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
  });

  let closed = false;

  function handleUpgrade(request, socket, head) {
    let url;

    try {
      url = new URL(request.url, 'http://localhost');
    } catch (_) {
      socket.destroy();
      return;
    }

    if (closed) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }

    if (url.pathname !== '/realtime') {
      socket.destroy();
      return;
    }

    const auth = verifyTicket(url.searchParams.get('ticket'));
    if (!auth) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, auth);
    });
  }

  server.on('upgrade', handleUpgrade);

  wss.on('connection', (ws, request, auth) => {
    clients.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    logger.info('[REALTIME] browser connected', {
      userId: auth.userId,
      clients: clients.size,
    });

    sendJson(ws, {
      type: 'connection.ready',
      version: 1,
      user_id: auth.userId,
      server_time: new Date().toISOString(),
    });

    ws.on('close', () => {
      clients.delete(ws);
      logger.info('[REALTIME] browser disconnected', {
        userId: auth.userId,
        clients: clients.size,
      });
    });

    ws.on('error', (err) => {
      logger.warn('[REALTIME] websocket error', {
        userId: auth.userId,
        error: err.message,
      });
    });

    ws.on('message', () => {
      // Spike Milestone 1: browser -> server messages belum digunakan.
    });
  });

  function heartbeatTick() {
    for (const ws of clients) {
      if (ws.readyState !== ws.OPEN) continue;

      if (ws.isAlive === false) {
        // Tidak ada pong pada cycle sebelumnya -> anggap koneksi half-open/mati.
        clients.delete(ws);
        try {
          ws.terminate();
        } catch (_) {
          // Abaikan; client lain tetap diproses.
        }
        logger.warn('[REALTIME] heartbeat timeout; client terminated', {
          clients: clients.size,
        });
        continue;
      }

      ws.isAlive = false;
      try {
        ws.ping();
      } catch (err) {
        // ping() juga operasi jaringan; perlakukan sama seperti send failure 5B.
        clients.delete(ws);
        try {
          ws.terminate();
        } catch (_) {
          // Abaikan; client lain tetap diproses.
        }
        logger.warn('[REALTIME] heartbeat ping failed; client removed', {
          error: err.message,
          clients: clients.size,
        });
      }
    }
  }

  const heartbeatInterval = setInterval(heartbeatTick, heartbeatIntervalMs);
  // Jangan biarkan timer heartbeat menahan event loop hidup saat shutdown.
  if (typeof heartbeatInterval.unref === 'function') heartbeatInterval.unref();

  return {
    close: () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeatInterval);
      server.removeListener('upgrade', handleUpgrade);

      for (const ws of clients) {
        clients.delete(ws);
        try {
          ws.terminate();
        } catch (_) {
          // Abaikan kegagalan cleanup; registry tetap dibersihkan.
        }
      }

      wss.close();
    },
    broadcast,
    clientCount: () => clients.size,
    heartbeatTick,
  };
}

module.exports = { attachRealtime, broadcast };
