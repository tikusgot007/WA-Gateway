'use strict';
/**
 * Skrip simulasi Grup Tahap 2 (sisi WA-Gateway):
 * `plan/plan-feature-grup-tahap2-wa-gateway-v1.0.md` TASK-003.
 *
 * Membuktikan LOGIKA Gateway untuk pesan grup MASUK:
 *   (a)  cache terisi -> payload memuat sender_jid (key.participant) + group_name;
 *   (a2) cache miss -> pesan diteruskan SEGERA tanpa group_name (fire-and-forget),
 *        pesan grup berikutnya sudah memuat group_name;
 *   (b)  pesan pribadi (pn) -> group_name tidak pernah dikirim, sender_jid tidak berubah;
 *   (c)  groupMetadata() TIDAK dipanggil ulang selama cache masih segar;
 *   (d)  groupMetadata() gagal -> group_name absen, pesan tetap diteruskan;
 *   (e)  grup keluar (fromMe) -> JID grup TIDAK dipakai sebagai sender_jid;
 *   (f)  setiap payload grup memuat `direction` yang benar (fromMe -> outgoing).
 *
 * PENTING -- KEJUJURAN: `sock.groupMetadata()` di-MOCK di sini (tidak ada
 * koneksi WhatsApp sungguhan di lingkungan ini). Test ini membuktikan LOGIKA
 * Gateway benar KETIKA groupMetadata() mengembalikan nilai tertentu -- BUKAN
 * bukti bahwa server WhatsApp asli mengembalikan `subject` seperti itu.
 * Wajib diverifikasi ulang terhadap koneksi live (TEST-003 plan).
 *
 * Semua data di folder temp (SQLITE_PATH); TIDAK PERNAH menyentuh
 * data/gateway.sqlite produksi.
 * Jalankan: node test/simulate-group-identity.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// HARUS sebelum modul src/ mana pun di-require: config dibaca sekali saat load,
// dan singleton incomingBuffer langsung membuka SQLITE_PATH saat modulnya dimuat.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-group-identity-'));
process.env.SQLITE_PATH = path.join(tmpRoot, 'gateway.sqlite');
process.env.CI4_BASE_URL = '';
process.env.CI4_GATEWAY_TOKEN = 'token-uji';

const assert = require('assert');
const logger = require('../src/logging');
const { ensureBaileysLoaded } = require('../src/whatsapp/baileysLoader');
const connectionManager = require('../src/whatsapp/connectionManager');
const incomingBuffer = require('../src/store/incomingBuffer');
const { deliverOne } = require('../src/delivery/incomingDelivery');

// Tangkap semua log (tidak dicetak) supaya peringatan "kegagalan terlihat" bisa diperiksa.
const logs = [];
for (const level of ['info', 'warn', 'error', 'debug']) {
  logger[level] = (message, meta) => logs.push({ level, message, meta });
}
const warnMatch = (re) => logs.some((l) => l.level === 'warn' && re.test(l.message));

const GROUP_A = '120363000000000001@g.us';
const GROUP_B = '120363000000000002@g.us';
const PN = '628111222333@s.whatsapp.net';
const PARTICIPANT_A = '628111111111@s.whatsapp.net';
const PARTICIPANT_B = '628222222222@s.whatsapp.net';

const metaStub = { calls: [], impl: null };
const originalStatus = connectionManager.status;
const originalSock = connectionManager.sock;
connectionManager.status = 'connected';
connectionManager.sock = {
  groupMetadata: async (jid) => {
    metaStub.calls.push(jid);
    if (metaStub.impl) return metaStub.impl(jid);
    return { subject: 'Grup Uji AuliaPos' };
  },
};

let seq = 0;
async function simulateIncoming({ remoteJid, fromMe = false, participant, withParticipant = true, text = 'halo' }) {
  seq += 1;
  const id = `SIM-GRP-${Date.now()}-${seq}`;
  const key = { remoteJid, fromMe, id };
  if (withParticipant) key.participant = participant;
  await connectionManager._handleIncomingMessage({
    key,
    pushName: 'Simulasi Pengirim',
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
  });
  return id;
}

async function fetchRow(id) {
  const row = incomingBuffer.getDueEvents(500).find((r) => r.wa_message_id === id);
  assert.ok(row, `baris antrean untuk ${id} harus ada`);
  return row;
}

async function deliverCaptured(id) {
  const row = await fetchRow(id);
  let captured = null;
  await deliverOne(row, {
    postToCI4: async (route, body) => {
      captured = { route, body };
      return { ok: true, status: 200, json: { success: true } };
    },
  });
  return { row, ...captured };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const keysOf = (obj) => Object.keys(obj);

(async () => {
  await ensureBaileysLoaded();

  // ---------------- (a2) cache MISS -> diteruskan segera tanpa group_name ----------------
  let releaseMeta;
  const metaGate = new Promise((resolve) => { releaseMeta = resolve; });
  metaStub.impl = () => metaGate; // menahan groupMetadata sampai releaseMeta()

  const id1 = await simulateIncoming({ remoteJid: GROUP_A, participant: PARTICIPANT_A });
  const sent1 = await deliverCaptured(id1);
  await flush();

  assert.strictEqual(sent1.route, '/api/inbox/gateway/messages');
  assert.strictEqual(sent1.body.jid_type, 'group');
  assert.strictEqual(sent1.body.direction, 'incoming', '(f) grup masuk -> direction incoming');
  assert.strictEqual(sent1.body.sender_jid, PARTICIPANT_A, '(a2) sender_jid = key.participant');
  assert.strictEqual(keysOf(sent1.body).includes('group_name'), false, '(a2) group_name TIDAK dikirim saat cache miss');
  assert.deepStrictEqual(metaStub.calls, [GROUP_A], '(a2) refresh fire-and-forget dipicu tepat sekali');
  console.log('OK (a2): cache miss -> dikirim segera tanpa group_name, cache diisi di latar.');

  // Selesaikan refresh di latar.
  releaseMeta({ subject: 'Grup Uji AuliaPos' });
  await flush();
  await flush();
  metaStub.impl = null; // kembalikan ke default (subject sukses)

  // ---------------- (a) cache terisi -> sender_jid + group_name ----------------
  const id2 = await simulateIncoming({ remoteJid: GROUP_A, participant: PARTICIPANT_B });
  const sent2 = await deliverCaptured(id2);
  assert.strictEqual(sent2.row.sender_jid, PARTICIPANT_B, '(a) sender_jid persist di antrean');
  assert.strictEqual(sent2.row.group_name, 'Grup Uji AuliaPos', '(a) group_name persist di antrean');
  assert.strictEqual(sent2.body.sender_jid, PARTICIPANT_B);
  assert.strictEqual(sent2.body.group_name, 'Grup Uji AuliaPos', '(a) group_name dikirim saat cache terisi');
  assert.strictEqual(sent2.body.direction, 'incoming');
  console.log('OK (a): cache terisi -> sender_jid + group_name terkirim.');

  // ---------------- (c) cache: groupMetadata() tidak dipanggil ulang ----------------
  const callsBefore = metaStub.calls.length;
  const id3 = await simulateIncoming({ remoteJid: GROUP_A, participant: PARTICIPANT_A });
  const sent3 = await deliverCaptured(id3);
  assert.strictEqual(sent3.body.group_name, 'Grup Uji AuliaPos');
  assert.strictEqual(metaStub.calls.length, callsBefore, '(c) groupMetadata() TIDAK dipanggil ulang saat cache segar');
  console.log('OK (c): cache terpakai, tanpa panggilan groupMetadata() tambahan.');

  // ---------------- (b) pesan pribadi -> group_name absen, sender_jid tidak berubah ----------------
  const id4 = await simulateIncoming({ remoteJid: PN });
  const sent4 = await deliverCaptured(id4);
  assert.strictEqual(sent4.body.jid_type, 'pn');
  assert.strictEqual(keysOf(sent4.body).includes('group_name'), false, '(b) non-grup tidak pernah membawa group_name (CON-001)');
  assert.strictEqual(sent4.body.sender_jid, PN, '(b) non-grup: sender_jid tetap sender.jid (kontrak lama tidak berubah)');
  assert.strictEqual(sent4.body.direction, 'incoming');
  console.log('OK (b): pesan pribadi tidak terpengaruh.');

  // ---------------- (d) groupMetadata() GAGAL -> group_name absen, pesan tetap terkirim ----------------
  metaStub.impl = async () => { throw new Error('simulasi timeout groupMetadata'); };
  const id5 = await simulateIncoming({ remoteJid: GROUP_B, participant: PARTICIPANT_A });
  const sent5 = await deliverCaptured(id5);
  await flush();
  await flush();
  assert.strictEqual(sent5.body.sender_jid, PARTICIPANT_A);
  assert.strictEqual(keysOf(sent5.body).includes('group_name'), false, '(d) kegagalan metadata -> group_name absen');
  assert.ok(warnMatch(/groupMetadata/), '(d) kegagalan groupMetadata() dicatat sebagai warn (bukan senyap)');
  console.log('OK (d): kegagalan metadata non-fatal, pesan tetap diteruskan tanpa group_name.');

  // ---------------- (e) grup KELUAR (fromMe) -> JID grup tidak dipakai sebagai sender_jid ----------------
  const id6 = await simulateIncoming({ remoteJid: GROUP_A, fromMe: true, participant: PARTICIPANT_A });
  const sent6 = await deliverCaptured(id6);
  assert.strictEqual(sent6.body.direction, 'outgoing', '(f) fromMe -> direction outgoing');
  assert.strictEqual(sent6.body.sender_jid, null, '(e) grup keluar: sender_jid null, BUKAN JID grup');
  assert.strictEqual(keysOf(sent6.body).includes('group_name'), false, '(e) grup keluar tidak mengirim group_name');
  console.log('OK (e): grup keluar tidak membawa JID grup sebagai sender_jid.');

  // ---------------- grup masuk TANPA participant -> sender_jid null + warn (kegagalan terlihat) ----------------
  const id7 = await simulateIncoming({ remoteJid: GROUP_A, withParticipant: false });
  const sent7 = await deliverCaptured(id7);
  assert.strictEqual(sent7.body.sender_jid, null, 'grup masuk tanpa participant -> sender_jid null (AuliaPos akan 400)');
  assert.ok(warnMatch(/tanpa key\.participant/), 'kekosongan participant dicatat jelas, bukan senyap');
  console.log('OK: participant kosong -> sender_jid null + warn eksplisit.');

  // ---------------- (f) kontrak direction pada SEMUA payload grup ----------------
  for (const [label, sent] of [['a2', sent1], ['a', sent2], ['c', sent3], ['b', sent4], ['d', sent5], ['e', sent6], ['no-participant', sent7]]) {
    assert.ok(
      sent.body.direction === 'incoming' || sent.body.direction === 'outgoing',
      `(f) [${label}] setiap payload WAJIB memuat direction yang benar`
    );
  }
  console.log('OK (f): semua payload memuat direction eksplisit (tidak pernah absen).');

  console.log('\nSEMUA SIMULASI GRUP TAHAP 2 (GATEWAY) LULUS (0 gagal).');
  console.log('CATATAN: groupMetadata() di-MOCK -- BELUM diverifikasi terhadap server WhatsApp sungguhan (TEST-003).');
})()
  .catch((err) => {
    console.error('GAGAL:', err);
    console.error('Log terakhir:', logs.slice(-8));
    process.exitCode = 1;
  })
  .finally(() => {
    connectionManager.status = originalStatus;
    connectionManager.sock = originalSock;
    try {
      incomingBuffer.close();
    } catch (err) {
      // sudah tertutup
    }
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (err) {
      console.warn(`Peringatan: folder temp tidak terhapus (${tmpRoot}): ${err.message}`);
    }
  });
