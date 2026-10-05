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
const { WebSocketServer } = require('ws');

// Milestone 5B: test-level hook untuk menangkap instance ws sisi-server, supaya
// SATU client bisa dibuat gagal secara deterministik tanpa mengubah src/.
const serverSockets = [];
const _origHandleUpgrade = WebSocketServer.prototype.handleUpgrade;
WebSocketServer.prototype.handleUpgrade = function (req, socket, head, cb) {
  return _origHandleUpgrade.call(this, req, socket, head, function (wsInstance, req2) {
    serverSockets.push(wsInstance);
    return cb(wsInstance, req2);
  });
};

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

    // ================================================================
    // Milestone 5B -- broadcast failure isolation
    // ================================================================
    const sockBase = serverSockets.length;
    const ca = await connectRealtime(base, '/realtime', makeTicket(41));
    const cb2 = await connectRealtime(base, '/realtime', makeTicket(42));
    const cc = await connectRealtime(base, '/realtime', makeTicket(43));
    assert.ok(ca.ready && cb2.ready && cc.ready, '5B: 3 client harus terhubung');
    const sa = serverSockets[sockBase];
    const sb = serverSockets[sockBase + 1];
    const sc = serverSockets[sockBase + 2];
    assert.ok(sa && sb && sc, '5B: server-side sockets harus ter-capture');
    const ta = trackMessages(ca.ws);
    const tb2 = trackMessages(cb2.ws);
    const tc = trackMessages(cc.ws);
    // terminate() sisi-server bisa memunculkan 'error' di client A; jangan
    // biarkan menjadi unhandled error pada proses test.
    [ca, cb2, cc].forEach((c) => c.ws.on('error', () => {}));
    const payload5B = (id) => ({ type: 'message.created', version: 1, conversation_id: 9, wa_message_id: id, direction: 'incoming', message_type: 'text', duplicate: false, server_time: new Date().toISOString() });

    await check('5B-A normal broadcast -> A=1 B=1 C=1', async () => {
      ta.length = 0; tb2.length = 0; tc.length = 0;
      broadcast(payload5B('5B-A'));
      await sleep(150);
      assert.strictEqual(ta.length, 1, 'A');
      assert.strictEqual(tb2.length, 1, 'B');
      assert.strictEqual(tc.length, 1, 'C');
    });

    await check('5B-B satu client gagal send -> B/C tetap menerima, server hidup', async () => {
      ta.length = 0; tb2.length = 0; tc.length = 0;
      const realSend = sa.send;
      sa.send = function () { throw new Error('synthetic send failure'); };
      let threw = null;
      try { broadcast(payload5B('5B-B')); } catch (e) { threw = e; }
      await sleep(150);
      sa.send = realSend;
      assert.ok(
        threw === null && tb2.length === 1 && tc.length === 1 && ta.length === 0 && realtime.clientCount() === 2,
        'expected: throw=null, A=0, B=1, C=1, clientCount=2 | actual: throw=' + (threw && threw.message) + ', A=' + ta.length + ', B=' + tb2.length + ', C=' + tc.length + ', clientCount=' + realtime.clientCount()
      );
    });

    await check('5B-C broadcast kedua setelah failure -> B/C tetap menerima', async () => {
      tb2.length = 0; tc.length = 0;
      const realSend = sa.send;
      sa.send = function () { throw new Error('synthetic send failure'); };
      let threw = null;
      try { broadcast(payload5B('5B-C')); } catch (e) { threw = e; }
      await sleep(150);
      sa.send = realSend;
      assert.ok(
        threw === null && tb2.length === 1 && tc.length === 1,
        'expected: throw=null, B=1, C=1 | actual: throw=' + (threw && threw.message) + ', B=' + tb2.length + ', C=' + tc.length
      );
    });

    await check('5B-D client closing race -> di-skip, healthy client menerima', async () => {
      tb2.length = 0;
      sa.close(); // server-side A -> CLOSING
      let threw = null;
      try { broadcast(payload5B('5B-D')); } catch (e) { threw = e; }
      await sleep(150);
      assert.strictEqual(threw, null, 'broadcast tidak boleh throw saat ada client closing');
      assert.strictEqual(tb2.length, 1, 'B harus menerima');
    });

    await check('5B-E cleanup regression -> A=0, B=1', async () => {
      await waitFor(() => realtime.clientCount() <= 2, 2000);
      ta.length = 0; tb2.length = 0;
      broadcast(payload5B('5B-E'));
      await sleep(150);
      assert.strictEqual(ta.length, 0, 'A harus 0 event');
      assert.strictEqual(tb2.length, 1, 'B harus 1 event');
    });

    // Tutup semua client 5B supaya server.close() tidak menggantung.
    ca.ws.terminate();
    cb2.ws.close();
    cc.ws.close();
    await waitFor(() => realtime.clientCount() === 0, 2000);

    // ================================================================
    // Milestone 5C -- heartbeat / stale connection (evaluasi, test-only)
    // ================================================================
    // 5C-B: apakah library `ws` otomatis membalas protocol ping dengan pong?
    await check('5C-B protocol ping -> server auto-pong (library ws)', async () => {
      const c = await connectRealtime(base, '/realtime', makeTicket(51));
      assert.ok(c.ready, 'harus terhubung');
      const gotPong = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 1500);
        c.ws.once('pong', () => { clearTimeout(t); resolve(true); });
        c.ws.ping();
      });
      assert.ok(gotPong, 'server harus auto-balas pong (library ws)');
      c.ws.close();
      await waitFor(() => realtime.clientCount() === 0, 2000);
    });

    // 5C-D: surrogate "stale" -- readyState OPEN, send() tidak throw, tapi peer
    // tidak menerima apa pun. Ini BUKAN half-open OS-level (tidak bisa
    // direproduksi deterministik in-process tanpa manipulasi OS/network); ini
    // test-level surrogate untuk mengukur dampak registry.
    const dBase = serverSockets.length;
    const da = await connectRealtime(base, '/realtime', makeTicket(52));
    const db = await connectRealtime(base, '/realtime', makeTicket(53));
    const sa2 = serverSockets[dBase];
    const daMsgs = trackMessages(da.ws);
    const dbMsgs = trackMessages(db.ws);
    [da, db].forEach((c) => c.ws.on('error', () => {}));

    await check('5C-D stale surrogate (OPEN, send no-op) -> B menerima, A tetap di registry', async () => {
      daMsgs.length = 0; dbMsgs.length = 0;
      const before = realtime.clientCount();
      const realSend = sa2.send;
      sa2.send = function () {}; // peer tidak menerima, TAPI tidak throw
      let threw = null;
      try { broadcast(payload5B('5C-D')); } catch (e) { threw = e; }
      await sleep(150);
      const after = realtime.clientCount();
      sa2.send = realSend;
      assert.strictEqual(threw, null, 'broadcast tidak boleh throw');
      assert.strictEqual(dbMsgs.length, 1, 'healthy B harus menerima');
      assert.strictEqual(daMsgs.length, 0, 'stale A tidak menerima (surrogate)');
      assert.strictEqual(after, before, 'stale A TETAP di registry (tak terdeteksi tanpa heartbeat): before=' + before + ' after=' + after);
    });

    da.ws.terminate();
    db.ws.close();
    await waitFor(() => realtime.clientCount() === 0, 2000);

    // ================================================================
    // Milestone 5D -- server WebSocket heartbeat
    // Kontrol deterministik lewat realtime.heartbeatTick(); interval default
    // (30 dtk) tidak menyala selama test, jadi tidak mengganggu.
    // ================================================================
    await check('5D-A healthy heartbeat -> ping terkirim, pong, client tetap', async () => {
      const c = await connectRealtime(base, '/realtime', makeTicket(61));
      assert.ok(c.ready, 'harus connection.ready');
      let pings = 0;
      c.ws.on('ping', () => { pings++; });
      realtime.heartbeatTick();
      assert.ok(await waitFor(() => pings >= 1, 1000), 'server harus mengirim ping');
      await sleep(100);
      assert.strictEqual(realtime.clientCount(), 1, 'client tetap di registry (pong diterima)');
      c.ws.close();
      await waitFor(() => realtime.clientCount() === 0, 2000);
    });

    await check('5D-B 3 client x 2 cycle -> tetap connected, clientCount=3', async () => {
      const a = await connectRealtime(base, '/realtime', makeTicket(62));
      const b = await connectRealtime(base, '/realtime', makeTicket(63));
      const c = await connectRealtime(base, '/realtime', makeTicket(64));
      assert.ok(a.ready && b.ready && c.ready);
      assert.strictEqual(realtime.clientCount(), 3);
      realtime.heartbeatTick(); await sleep(80);
      realtime.heartbeatTick(); await sleep(80);
      assert.strictEqual(realtime.clientCount(), 3, 'semua tetap connected');
      a.ws.close(); b.ws.close(); c.ws.close();
      await waitFor(() => realtime.clientCount() === 0, 2000);
    });

    await check('5D-C stale (isAlive=false) -> terminate, removed; B/C tetap', async () => {
      const sBase = serverSockets.length;
      const a = await connectRealtime(base, '/realtime', makeTicket(65));
      const b = await connectRealtime(base, '/realtime', makeTicket(66));
      const c = await connectRealtime(base, '/realtime', makeTicket(67));
      const sa = serverSockets[sBase];
      assert.ok(a.ready && b.ready && c.ready);
      await waitFor(() => realtime.clientCount() === 3, 2000);
      sa.isAlive = false;
      realtime.heartbeatTick();
      assert.ok(await waitFor(() => realtime.clientCount() === 2, 1000), 'A harus dibuang, B/C tetap');
      a.ws.terminate(); b.ws.close(); c.ws.close();
      await waitFor(() => realtime.clientCount() === 0, 2000);
    });

    await check('5D-D pong memperbarui isAlive -> cycle berikutnya tidak terminate', async () => {
      const sBase = serverSockets.length;
      const a = await connectRealtime(base, '/realtime', makeTicket(68));
      const sa = serverSockets[sBase];
      assert.strictEqual(sa.isAlive, true, 'connection baru harus isAlive=true');
      realtime.heartbeatTick();
      assert.strictEqual(sa.isAlive, false, 'setelah cycle, isAlive=false sampai pong');
      assert.ok(await waitFor(() => sa.isAlive === true, 1000), 'pong harus set isAlive=true');
      realtime.heartbeatTick();
      await sleep(60);
      assert.strictEqual(realtime.clientCount(), 1, 'client TIDAK diterminasi pada cycle berikutnya');
      a.ws.close();
      await waitFor(() => realtime.clientCount() === 0, 2000);
    });

    await check('5D-E no pong -> terminate; healthy client tetap', async () => {
      const sBase = serverSockets.length;
      const a = await connectRealtime(base, '/realtime', makeTicket(69));
      const b = await connectRealtime(base, '/realtime', makeTicket(70));
      const sa = serverSockets[sBase];
      await waitFor(() => realtime.clientCount() === 2, 2000);
      realtime.heartbeatTick();          // cycle N: A & B -> isAlive=false + ping
      await sleep(100);                  // biarkan pong B tiba; A kita paksa tanpa pong
      sa.isAlive = false;                // simulasi A tidak mengirim pong
      realtime.heartbeatTick();          // cycle N+1: A isAlive=false -> terminate
      assert.ok(await waitFor(() => realtime.clientCount() === 1, 1000), 'A diterminasi, B tetap');
      a.ws.terminate(); b.ws.close();
      await waitFor(() => realtime.clientCount() === 0, 2000);
    });

    await check('5D-F heartbeat + broadcast -> A/C menerima, stale B tidak, server hidup', async () => {
      const sBase = serverSockets.length;
      const a = await connectRealtime(base, '/realtime', makeTicket(71));
      const b = await connectRealtime(base, '/realtime', makeTicket(72));
      const c = await connectRealtime(base, '/realtime', makeTicket(73));
      const sb = serverSockets[sBase + 1];
      const ma = trackMessages(a.ws);
      const mc = trackMessages(c.ws);
      await waitFor(() => realtime.clientCount() === 3, 2000);
      sb.isAlive = false;
      realtime.heartbeatTick();
      await waitFor(() => realtime.clientCount() === 2, 1000);
      broadcast({ type: 'message.created', version: 1, conversation_id: 7, wa_message_id: '5D-F', direction: 'incoming', message_type: 'text', duplicate: false, server_time: new Date().toISOString() });
      await sleep(150);
      assert.strictEqual(ma.length, 1, 'A menerima');
      assert.strictEqual(mc.length, 1, 'C menerima');
      assert.strictEqual(realtime.clientCount(), 2, 'B sudah keluar; A/C tetap');
      a.ws.close(); b.ws.terminate(); c.ws.close();
      await waitFor(() => realtime.clientCount() === 0, 2000);
    });

    await check('5D-G reconnect: koneksi baru setelah terminate -> connection.ready', async () => {
      const a = await connectRealtime(base, '/realtime', makeTicket(74));
      a.ws.close();
      await waitFor(() => realtime.clientCount() === 0, 2000);
      const a2 = await connectRealtime(base, '/realtime', makeTicket(74));
      assert.ok(a2.ready && a2.ready.type === 'connection.ready', 'koneksi baru harus connection.ready');
      a2.ws.close();
      await waitFor(() => realtime.clientCount() === 0, 2000);
    });

    await check('5D-H close() menghentikan heartbeat interval (proses tidak menggantung)', async () => {
      const s = http.createServer((req, res) => { res.statusCode = 200; res.end('x'); });
      const r = attachRealtime(s, { heartbeatIntervalMs: 20 });
      await new Promise((res) => s.listen(0, '127.0.0.1', res));
      const b = 'http://127.0.0.1:' + s.address().port;
      const c = await connectRealtime(b, '/realtime', makeTicket(75));
      assert.ok(c.ready);
      await sleep(80); // biarkan beberapa cycle interval nyata berjalan
      assert.strictEqual(r.clientCount(), 1, 'client harus tetap hidup (pong otomatis)');
      c.ws.close();
      await waitFor(() => r.clientCount() === 0, 2000);
      r.close(); // harus clearInterval; kalau tidak, proses test akan menggantung
      await new Promise((res) => s.close(res));
    });
  } finally {
    WebSocketServer.prototype.handleUpgrade = _origHandleUpgrade;
    realtime.close();
    await new Promise((r) => server.close(r));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
