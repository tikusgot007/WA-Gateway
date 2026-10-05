'use strict';

/**
 * Milestone 5A -- regression tests for the /realtime WebSocket transport.
 *
 * Menguji behavior yang SUDAH ada di production code (src/realtime/server.js):
 *   A valid ticket, B invalid ticket, C wrong signature, D expired ticket,
 *   E wrong path, F multi-client broadcast, G client cleanup, H maxPayload.
 *
 * Test-only: TIDAK menyentuh src/. Kalau ada assertion gagal, itu defect
 * production -- laporkan, jangan patch di sini.
 *
 * Jalankan: node test/test-realtime-websocket.js
 */
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');

process.env.CI4_BASE_URL = 'http://127.0.0.1:39999';
process.env.CI4_GATEWAY_TOKEN = 'realtime-ws-test-token';

const config = require('../src/config');
const { attachRealtime, broadcast } = require('../src/realtime/server');

const TOKEN = config.ci4.gatewayToken;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeTicket(sub, expOffsetSec = 60, opts = {}) {
  const key = opts.key || TOKEN;
  const payloadObj = opts.payloadObj || { sub, exp: Math.floor(Date.now() / 1000) + expOffsetSec };
  const payloadPart = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const signature = opts.signatureOverride !== undefined
    ? opts.signatureOverride
    : crypto.createHmac('sha256', key).update(payloadPart).digest('hex');
  return payloadPart + '.' + signature;
}

function urlOf(base, path, ticket) {
  return base + path + (ticket === undefined ? '' : '?ticket=' + encodeURIComponent(ticket));
}

// Menunggu connection.ready; kalau gagal -> resolve {rejected:true,...}.
function connectRealtime(base, path, ticket, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(urlOf(base, path, ticket));
    const out = { ws, ready: null, status: null, error: null, opened: false, rejected: false };
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(out); };
    const timer = setTimeout(finish, timeoutMs);
    ws.on('open', () => { out.opened = true; });
    ws.on('message', (d) => { out.ready = JSON.parse(d.toString()); clearTimeout(timer); finish(); });
    ws.on('unexpected-response', (req, res) => { out.rejected = true; out.status = res.statusCode; res.resume(); clearTimeout(timer); finish(); });
    ws.on('error', (e) => { out.error = e.message; clearTimeout(timer); finish(); });
  });
}

function trackMessages(ws) {
  const seen = [];
  ws.on('message', (d) => { try { seen.push(JSON.parse(d.toString())); } catch (_) {} });
  return seen;
}

function waitFor(fn, timeoutMs = 2000, step = 25) {
  return new Promise((resolve) => {
    const end = Date.now() + timeoutMs;
    const tick = () => { if (fn()) return resolve(true); if (Date.now() > end) return resolve(false); setTimeout(tick, step); };
    tick();
  });
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('ok   ' + name); })
    .catch((e) => { failed++; console.log('FAIL ' + name + ' :: ' + e.message); });
}

(async () => {
  const server = http.createServer((req, res) => { res.statusCode = 200; res.end('alive'); });
  const realtime = attachRealtime(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  try {
    let a;
    await check('A valid ticket -> connection.ready + user_id', async () => {
      a = await connectRealtime(base, '/realtime', makeTicket(7));
      assert.ok(a.ready, 'harus menerima connection.ready, dapat: ' + JSON.stringify({ status: a.status, error: a.error, opened: a.opened }));
      assert.strictEqual(a.ready.type, 'connection.ready');
      assert.strictEqual(a.ready.user_id, 7);
      assert.strictEqual(realtime.clientCount(), 1);
      a.ws.close();
      await waitFor(() => realtime.clientCount() === 0);
    });

    await check('B invalid tickets -> 401 (empty/malformed/no-dot/not-JSON)', async () => {
      const badJsonPayload = Buffer.from('bukan json').toString('base64url');
      const badJsonSig = crypto.createHmac('sha256', TOKEN).update(badJsonPayload).digest('hex');
      const cases = [
        ['empty', ''],
        ['malformed', 'malformed'],
        ['no-dot', 'abcdef123456'],
        ['payload-not-json', badJsonPayload + '.' + badJsonSig],
      ];
      for (const [label, ticket] of cases) {
        const r = await connectRealtime(base, '/realtime', ticket);
        assert.strictEqual(r.status, 401, label + ' harus 401, dapat ' + JSON.stringify({ status: r.status, error: r.error, opened: r.opened }));
        assert.strictEqual(r.opened, false, label + ' tidak boleh open');
        r.ws.terminate();
      }
      assert.strictEqual(realtime.clientCount(), 0, 'tidak ada client yang boleh masuk registry');
    });

    await check('C wrong signature -> 401 dan tidak masuk clients', async () => {
      const ticket = makeTicket(7, 60, { signatureOverride: 'a'.repeat(64) });
      const r = await connectRealtime(base, '/realtime', ticket);
      assert.strictEqual(r.status, 401, 'harus 401, dapat ' + JSON.stringify({ status: r.status, error: r.error, opened: r.opened }));
      assert.strictEqual(realtime.clientCount(), 0);
      r.ws.terminate();
    });

    await check('D expired ticket -> 401', async () => {
      const r = await connectRealtime(base, '/realtime', makeTicket(7, -1));
      assert.strictEqual(r.status, 401, 'harus 401, dapat ' + JSON.stringify({ status: r.status, error: r.error, opened: r.opened }));
      r.ws.terminate();
    });

    await check('E wrong path -> rejected, HTTP server tetap hidup', async () => {
      const r = await connectRealtime(base, '/realtime-wrong', makeTicket(7));
      assert.strictEqual(r.opened, false, 'path salah tidak boleh open');
      assert.ok(r.error || r.status === undefined || !r.ready, 'harus ditolak (socket destroyed)');
      r.ws.terminate();
      const ok = await connectRealtime(base, '/realtime', makeTicket(7));
      assert.ok(ok.ready, 'server tetap hidup: koneksi valid sesudahnya harus sukses');
      assert.strictEqual(ok.ready.type, 'connection.ready');
      ok.ws.close();
      await waitFor(() => realtime.clientCount() === 0);
    });

    await check('F multi-client broadcast -> masing-masing tepat 1 event', async () => {
      const ca = await connectRealtime(base, '/realtime', makeTicket(11));
      const cb = await connectRealtime(base, '/realtime', makeTicket(12));
      assert.ok(ca.ready && cb.ready);
      const ta = trackMessages(ca.ws);
      const tb = trackMessages(cb.ws);
      assert.strictEqual(realtime.clientCount(), 2);
      broadcast({ type: 'message.created', version: 1, conversation_id: 5, wa_message_id: 'T-F', direction: 'incoming', message_type: 'text', duplicate: false, server_time: new Date().toISOString() });
      await sleep(200);
      assert.strictEqual(ta.length, 1, 'client A harus 1 event, dapat ' + ta.length);
      assert.strictEqual(tb.length, 1, 'client B harus 1 event, dapat ' + tb.length);
      ca.ws.close(); cb.ws.close();
      await waitFor(() => realtime.clientCount() === 0);
    });

    await check('G client cleanup -> A 0 event, B 1 event', async () => {
      const ca = await connectRealtime(base, '/realtime', makeTicket(21));
      const cb = await connectRealtime(base, '/realtime', makeTicket(22));
      assert.ok(ca.ready && cb.ready);
      const ta = trackMessages(ca.ws);
      const tb = trackMessages(cb.ws);
      ca.ws.close();
      const cleaned = await waitFor(() => realtime.clientCount() === 1, 2000);
      assert.ok(cleaned, 'client A harus dibuang dari registry; clientCount=' + realtime.clientCount());
      broadcast({ type: 'message.created', version: 1, conversation_id: 6, wa_message_id: 'T-G', direction: 'incoming', message_type: 'text', duplicate: false, server_time: new Date().toISOString() });
      await sleep(200);
      assert.strictEqual(ta.length, 0, 'client A (closed) harus 0 event, dapat ' + ta.length);
      assert.strictEqual(tb.length, 1, 'client B harus 1 event, dapat ' + tb.length);
      cb.ws.close();
      await waitFor(() => realtime.clientCount() === 0);
    });

    await check('H payload >16KB -> koneksi ditutup server, server tetap hidup', async () => {
      const c = await connectRealtime(base, '/realtime', makeTicket(31));
      assert.ok(c.ready, 'client harus terhubung dulu');
      const closed = new Promise((resolve) => {
        c.ws.on('close', (code) => resolve(code));
        c.ws.on('error', () => resolve('error'));
      });
      c.ws.send('x'.repeat(20 * 1024));
      const outcome = await Promise.race([closed, sleep(2500).then(() => 'timeout')]);
      assert.notStrictEqual(outcome, 'timeout', 'koneksi harus ditutup oleh limit maxPayload');
      await waitFor(() => realtime.clientCount() === 0, 2000);
      const ok = await connectRealtime(base, '/realtime', makeTicket(32));
      assert.ok(ok.ready, 'server harus tetap hidup setelah payload besar');
      ok.ws.close();
      await waitFor(() => realtime.clientCount() === 0);
    });
  } finally {
    await new Promise((r) => server.close(r));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
