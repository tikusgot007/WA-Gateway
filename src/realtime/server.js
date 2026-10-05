'use strict';

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const config = require('../config');
const logger = require('../logging');

const clients = new Set();

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
    if (ws.readyState === ws.OPEN) ws.send(message);
  }
}

function attachRealtime(server) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
  });

  server.on('upgrade', (request, socket, head) => {
    let url;

    try {
      url = new URL(request.url, 'http://localhost');
    } catch (_) {
      socket.destroy();
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
  });

  wss.on('connection', (ws, request, auth) => {
    clients.add(ws);

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

  return {
    close: () => wss.close(),
    broadcast,
    clientCount: () => clients.size,
  };
}

module.exports = { attachRealtime, broadcast };
