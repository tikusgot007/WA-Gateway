'use strict';

const config = require('../config');

/**
 * POST JSON ke endpoint CI4 (di bawah /api/inbox/gateway/), dengan
 * Bearer token dan timeout. Dipakai bersama oleh incomingDelivery.js
 * (kirim pesan masuk) dan heartbeat.js (kirim status koneksi).
 *
 * Mengembalikan { ok, status, json, error }. `ok` true HANYA kalau
 * HTTP 2xx DAN body JSON-nya punya status:'success' -- konsisten
 * dengan kontrak endpoint CI4 (lihat InboxGatewayApi.php).
 */
async function postToCI4(pathSuffix, body) {
  if (!config.ci4.baseUrl || !config.ci4.gatewayToken) {
    return { ok: false, status: 0, json: null, error: 'CI4_BASE_URL/CI4_GATEWAY_TOKEN belum dikonfigurasi' };
  }

  const url = `${config.ci4.baseUrl}${pathSuffix}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.ci4.requestTimeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ci4.gatewayToken}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const rawText = await res.text();
    let json = null;
    try {
      json = JSON.parse(rawText);
    } catch (err) {
      // Bukan JSON valid -- simpan potongan raw response supaya kelihatan
      // di log apa sebenarnya yang dibalas server (mis. HTML halaman
      // login/error, bukan JSON yang diharapkan).
    }

    const ok = res.ok && json && json.status === 'success';

    let error = null;
    if (!ok) {
      if (json?.message) {
        error = json.message;
      } else if (rawText) {
        error = `HTTP ${res.status}, respons bukan JSON yang diharapkan: ${rawText.slice(0, 200)}`;
      } else {
        error = `HTTP ${res.status}, respons kosong`;
      }
    }

    return { ok, status: res.status, json, error };
  } catch (err) {
    const message = err.name === 'AbortError' ? 'Timeout menghubungi CI4' : err.message;
    return { ok: false, status: 0, json: null, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { postToCI4 };
