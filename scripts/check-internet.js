'use strict';

/**
 * check-internet.js -- uji akses internet OUTBOUND dari aulia3.
 *
 * Penautan WhatsApp (dan heartbeat/whatsapp socket) butuh klien bisa
 * menghubungi server WhatsApp. Kalau tidak ada internet, QR tetap muncul
 * (dibuat lokal) tetapi penautan SELALU gagal di HP.
 *
 * Dijalankan lewat D:\kilo\check-internet.cmd
 */

const dns = require('dns');
const https = require('https');
const net = require('net');

const TARGETS_DNS = ['web.whatsapp.com', 'g.whatsapp.net', 'mmg.whatsapp.net', 'www.google.com'];
const TARGETS_HTTPS = ['https://web.whatsapp.com/', 'https://www.google.com/'];
const TARGETS_TCP = [
  ['web.whatsapp.com', 443],
  ['g.whatsapp.net', 443],
  ['1.1.1.1', 443],
];

function log(msg) {
  console.log(new Date().toISOString(), msg);
}

function lookup(host) {
  return new Promise((resolve) => {
    dns.lookup(host, { all: true }, (err, addrs) => {
      if (err) resolve(`GAGAL (${err.code || err.message})`);
      else resolve(addrs.map((a) => a.address).join(', '));
    });
  });
}

function head(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      res.resume();
      resolve(`HTTP ${res.statusCode}`);
    });
    req.on('timeout', () => { req.destroy(new Error('timeout 8s')); });
    req.on('error', (e) => resolve(`GAGAL (${e.code || e.message})`));
  });
}

function tcp(host, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (msg) => { sock.destroy(); resolve(msg); };
    sock.setTimeout(6000);
    sock.on('connect', () => done('OK'));
    sock.on('timeout', () => done('TIMEOUT 6s'));
    sock.on('error', (e) => done(`GAGAL (${e.code || e.message})`));
  });
}

(async () => {
  log('=== CHECK INTERNET AULIA3 ===');
  for (const h of TARGETS_DNS) log(`dns   ${h} -> ${await lookup(h)}`);
  for (const [h, p] of TARGETS_TCP) log(`tcp   ${h}:${p} -> ${await tcp(h, p)}`);
  for (const u of TARGETS_HTTPS) log(`https ${u} -> ${await head(u)}`);
  log('=== SELESAI ===');
})();
