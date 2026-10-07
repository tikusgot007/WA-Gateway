'use strict';

/**
 * Test WhatsApp read receipt (dua arah) -- pure, TANPA DB/network:
 *  - normalizeMessagesUpdate(): filter fromMe, mapping status, skip grup.
 *  - deliverStatus(): bentuk POST ke CI4, dead-letter, dan retry.
 *
 * Jalankan: node test/test-read-status.js
 */
const assert = require('node:assert/strict');
const { normalizeMessagesUpdate } = require('../src/evolution/normalize');
const { deliverStatus } = require('../src/delivery/incomingDelivery');

// --- normalizeMessagesUpdate -----------------------------------------------
const read = normalizeMessagesUpdate({
  data: { keyId: 'M1', remoteJid: '6281@s.whatsapp.net', fromMe: true, status: 'READ' },
});
assert.ok(read.ok, 'READ pesan keluar -> ok');
assert.equal(read.statusEvent.status, 'read');
assert.equal(read.statusEvent.waMessageId, 'M1');

const delivered = normalizeMessagesUpdate({
  data: { keyId: 'M2', remoteJid: '6281@s.whatsapp.net', fromMe: true, status: 'DELIVERY_ACK' },
});
assert.ok(delivered.ok, 'DELIVERY_ACK pesan keluar -> ok');
assert.equal(delivered.statusEvent.status, 'delivered');

// Pesan MASUK (fromMe=false) BUKAN receipt pelanggan -> skip.
assert.equal(
  normalizeMessagesUpdate({ data: { keyId: 'M3', remoteJid: '6281@s.whatsapp.net', fromMe: false, status: 'READ' } }).ok,
  false,
  'fromMe=false -> skip'
);
// Status tak dipetakan -> skip.
assert.equal(
  normalizeMessagesUpdate({ data: { keyId: 'M4', remoteJid: '6281@s.whatsapp.net', fromMe: true, status: 'SERVER_ACK' } }).ok,
  false,
  'SERVER_ACK -> skip'
);
// Grup -> skip.
assert.equal(
  normalizeMessagesUpdate({ data: { keyId: 'M5', remoteJid: '12345@g.us', fromMe: true, status: 'READ' } }).ok,
  false,
  'grup -> skip'
);
// Tanpa keyId -> skip.
assert.equal(
  normalizeMessagesUpdate({ data: { remoteJid: '6281@s.whatsapp.net', fromMe: true, status: 'READ' } }).ok,
  false,
  'tanpa keyId -> skip'
);

// --- deliverStatus ---------------------------------------------------------
function makeDeps(postImpl) {
  const calls = [];
  const effects = [];
  const buffer = {
    markCompleted: (id) => effects.push(['completed', id]),
    markPermanentDead: (id, err) => effects.push(['dead', id, err]),
    markFailedAttempt: (id) => {
      effects.push(['failed', id]);
      return { delayMs: 1000, deadLettered: false };
    },
  };
  const post = async (path, body) => {
    calls.push([path, body]);
    return postImpl();
  };
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  return { calls, effects, buffer, post, log };
}

function readEvent(overrides = {}) {
  return {
    id: 7,
    wa_message_id: 'status:read:M1',
    chat_id: '6281@s.whatsapp.net',
    message_timestamp: '2026-10-07T00:00:00.000Z',
    extra_json: JSON.stringify({
      kind: 'status',
      status: 'read',
      target_wa_message_id: 'M1',
      chat_id: '6281@s.whatsapp.net',
    }),
    ...overrides,
  };
}

(async () => {
  // Sukses -> POST benar + markCompleted.
  {
    const d = makeDeps(() => ({ ok: true, status: 200, json: { status: 'success', matched: true } }));
    await deliverStatus(readEvent(), { post: d.post, buffer: d.buffer, deliveryLogger: d.log });
    assert.equal(d.calls.length, 1, 'satu POST ke CI4');
    assert.equal(d.calls[0][0], '/api/inbox/gateway/message-status');
    assert.equal(d.calls[0][1].wa_message_id, 'M1');
    assert.equal(d.calls[0][1].status, 'read');
    assert.deepEqual(d.effects[0], ['completed', 7]);
  }

  // Extra rusak (tanpa target) -> dead permanen, tanpa POST.
  {
    const d = makeDeps(() => ({ ok: true, status: 200, json: {} }));
    await deliverStatus(readEvent({ extra_json: JSON.stringify({ kind: 'status', status: 'read' }) }), {
      post: d.post, buffer: d.buffer, deliveryLogger: d.log,
    });
    assert.equal(d.calls.length, 0, 'tidak POST untuk event rusak');
    assert.equal(d.effects[0][0], 'dead');
  }

  // CI4 400 -> dead permanen.
  {
    const d = makeDeps(() => ({ ok: false, status: 400, json: null, error: 'bad' }));
    await deliverStatus(readEvent(), { post: d.post, buffer: d.buffer, deliveryLogger: d.log });
    assert.equal(d.calls.length, 1);
    assert.equal(d.effects[0][0], 'dead');
  }

  // CI4 500 -> retry (failed), bukan dead.
  {
    const d = makeDeps(() => ({ ok: false, status: 500, json: null, error: 'boom' }));
    await deliverStatus(readEvent(), { post: d.post, buffer: d.buffer, deliveryLogger: d.log });
    assert.equal(d.calls.length, 1);
    assert.equal(d.effects[0][0], 'failed');
  }

  console.log('gateway read-status tests: OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
