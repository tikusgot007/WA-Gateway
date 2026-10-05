'use strict';

/**
 * Regression test Milestone 2: CI4 ACK -> message.created WebSocket broadcast.
 * Tidak memanggil Evolution/CI4 sungguhan; hanya menguji delivery worker +
 * realtime transport dalam satu proses.
 */
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');

process.env.CI4_BASE_URL = 'http://127.0.0.1:39999';
process.env.CI4_GATEWAY_TOKEN = 'token-realtime-test';

const config = require('../src/config');
const { attachRealtime } = require('../src/realtime/server');
const { deliverOne } = require('../src/delivery/incomingDelivery');

function makeTicket(userId = 3) {
  const payload = Buffer.from(JSON.stringify({
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + 60,
  })).toString('base64url');
  // Sama dengan AuliaPos (hash_hmac default) dan verifyTicket gateway: HEX,
  // bukan base64url -- kalau tidak, gateway membalas 401.
  const signature = crypto
    .createHmac('sha256', config.ci4.gatewayToken)
    .update(payload)
    .digest('hex');
  return `${payload}.${signature}`;
}

function waitForMessage(ws, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout menunggu WebSocket message')), timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(raw.toString()));
    });
  });
}

async function openRealtime(baseUrl) {
  const ws = new WebSocket(`${baseUrl}/realtime?ticket=${encodeURIComponent(makeTicket())}`);
  const ready = await waitForMessage(ws);
  assert.strictEqual(ready.type, 'connection.ready');
  return ws;
}

(async () => {
  const server = http.createServer();
  attachRealtime(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    console.log('--- M2 regression: success -> ACK -> broadcast ---');
    const ws = await openRealtime(baseUrl);

    let completed = false;
    const event = {
      id: 101,
      wa_message_id: 'M2-REGRESSION-1',
      chat_id: '628111222333@s.whatsapp.net',
      jid_type: 'pn',
      message_type: 'text',
      text: 'pesan regression',
      message_timestamp: '2026-10-05T01:00:00.000Z',
      direction: 'incoming',
      attempts: 0,
      media_json: null,
      identity_hint_json: null,
    };

    const receivedPromise = waitForMessage(ws);
    await deliverOne(event, {
      incomingBuffer: {
        markCompleted(id) {
          assert.strictEqual(id, 101);
          completed = true;
        },
      },
      postToCI4: async (path, body) => {
        assert.strictEqual(path, '/api/inbox/gateway/messages');
        assert.strictEqual(body.wa_message_id, event.wa_message_id);
        return {
          ok: true,
          status: 200,
          json: {
            status: 'success',
            duplicate: false,
            conversation_id: 22,
          },
        };
      },
    });

    const message = await receivedPromise;
    assert.strictEqual(completed, true, 'buffer harus completed sebelum broadcast diterima');
    assert.deepStrictEqual(
      {
        type: message.type,
        version: message.version,
        conversation_id: message.conversation_id,
        wa_message_id: message.wa_message_id,
        direction: message.direction,
        message_type: message.message_type,
        duplicate: message.duplicate,
      },
      {
        type: 'message.created',
        version: 1,
        conversation_id: 22,
        wa_message_id: event.wa_message_id,
        direction: 'incoming',
        message_type: 'text',
        duplicate: false,
      }
    );
    ws.close();

    console.log('OK');

    console.log('--- M2 regression: CI4 failure -> no broadcast ---');
    const wsFailure = await openRealtime(baseUrl);
    let failed = false;
    let broadcasted = false;
    const failureEvent = { ...event, id: 102, wa_message_id: 'M2-REGRESSION-FAIL' };

    wsFailure.on('message', (raw) => {
      const payload = JSON.parse(raw.toString());
      if (payload.type === 'message.created') broadcasted = true;
    });

    await deliverOne(failureEvent, {
      incomingBuffer: {
        markFailedAttempt(id, attempts, error) {
          assert.strictEqual(id, 102);
          assert.strictEqual(attempts, 0);
          assert.ok(error);
          failed = true;
          return { delayMs: 1000, deadLettered: false };
        },
      },
      postToCI4: async () => ({
        ok: false,
        status: 500,
        error: 'CI4 test failure',
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(failed, true);
    assert.strictEqual(broadcasted, false, 'CI4 failure tidak boleh broadcast message.created');
    wsFailure.close();

    console.log('OK');
    console.log('--- M2 regression: duplicate ACK -> duplicate:true + conversation_id ---');
    const duplicateWs = await openRealtime(baseUrl);
    const duplicateEvent = { ...event, id: 103, wa_message_id: 'M2-REGRESSION-DUP' };
    const duplicateReceived = waitForMessage(duplicateWs);
    await deliverOne(duplicateEvent, {
      incomingBuffer: {
        markCompleted(id) { assert.strictEqual(id, 103); },
      },
      postToCI4: async () => ({
        ok: true,
        status: 200,
        json: {
          status: 'success',
          duplicate: true,
          conversation_id: 22,
        },
      }),
    });
    const duplicateMessage = await duplicateReceived;
    assert.strictEqual(duplicateMessage.type, 'message.created');
    assert.strictEqual(duplicateMessage.conversation_id, 22);
    assert.strictEqual(duplicateMessage.duplicate, true);
    duplicateWs.close();
    console.log('OK');

    console.log('PASS: Milestone 2 realtime delivery regression');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
