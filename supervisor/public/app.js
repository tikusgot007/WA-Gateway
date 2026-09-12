(function () {
  'use strict';

  const TOKEN_KEY = 'supervisor_token';
  const tokenInput = document.getElementById('tokenInput');
  const saveTokenBtn = document.getElementById('saveTokenBtn');

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  tokenInput.value = getToken();
  saveTokenBtn.addEventListener('click', () => {
    localStorage.setItem(TOKEN_KEY, tokenInput.value.trim());
    // BUG FIX: sebelumnya hanya refresh() (status+logs) yang dipanggil ulang
    // setelah token disimpan -- loadConnectionInfo() tidak pernah di-retry,
    // jadi kalau token belum ada saat page pertama dibuka (fetch awal gagal
    // 401), field Gateway URL/Token tetap kosong selamanya walau token
    // sudah benar. Panggil ulang refreshAll() (termasuk connection info) di sini.
    refreshAll();
  });

  async function api(path, opts) {
    const res = await fetch(path, {
      ...opts,
      headers: { Authorization: `Bearer ${getToken()}`, ...(opts && opts.headers) },
    });
    if (!res.ok && res.status === 401) {
      setLogs([{ time: new Date().toISOString(), level: 'error', message: 'Token salah/belum diisi.' }]);
    }
    return res.json();
  }

  function fmtUptime(ms) {
    if (!ms || ms <= 0) return '-';
    const s = Math.floor(ms / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function applyButtonState(state) {
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const restartBtn = document.getElementById('restartBtn');
    const running = state === 'RUNNING';
    const transitioning = state === 'STARTING' || state === 'STOPPING';
    startBtn.disabled = running || transitioning;
    stopBtn.disabled = !running || transitioning;
    restartBtn.disabled = !running || transitioning;
  }

  function setLogs(events) {
    const el = document.getElementById('logs');
    el.textContent = events
      .slice(0, 100)
      .reverse()
      .map((e) => `[${e.time}] ${e.level.toUpperCase()} ${e.message}`)
      .join('\n');
    el.scrollTop = el.scrollHeight;
  }

  async function refreshStatus() {
    const resp = await api('/control/status');
    if (!resp || !resp.ok) return;
    const data = resp.data;
    const badge = document.getElementById('stateBadge');
    badge.textContent = data.state;
    badge.className = `badge ${data.state}`;
    document.getElementById('pidVal').textContent = data.pid || '-';
    document.getElementById('uptimeVal').textContent = fmtUptime(data.uptimeMs);
    applyButtonState(data.state);

    const gw = data.gateway || {};
    document.getElementById('waStatus').textContent = gw.reachable ? gw.status : 'unreachable';
    document.getElementById('waNumber').textContent = gw.connectedNumber || '-';
  }

  async function refreshLogs() {
    const resp = await api('/control/logs');
    if (resp && resp.ok) setLogs(resp.data);
  }

  async function refresh() {
    await refreshStatus();
    await refreshLogs();
  }

  async function loadConnectionInfo() {
    const resp = await api('/control/connection-info');
    if (!resp || !resp.ok) return;
    document.getElementById('gwUrl').value = resp.data.gatewayUrl || '';
    document.getElementById('gwToken').value = resp.data.gatewayApiToken || '';
  }

  document.getElementById('startBtn').addEventListener('click', async () => {
    await api('/control/start', { method: 'POST' });
    refresh();
  });
  document.getElementById('stopBtn').addEventListener('click', async () => {
    await api('/control/stop', { method: 'POST' });
    refresh();
  });
  document.getElementById('restartBtn').addEventListener('click', async () => {
    await api('/control/restart', { method: 'POST' });
    refresh();
  });

  document.getElementById('toggleTokenBtn').addEventListener('click', () => {
    const input = document.getElementById('gwToken');
    const btn = document.getElementById('toggleTokenBtn');
    if (input.type === 'password') {
      input.type = 'text';
      btn.textContent = 'Hide';
    } else {
      input.type = 'password';
      btn.textContent = 'Show';
    }
  });

  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.getAttribute('data-copy'));
      navigator.clipboard.writeText(input.value).catch(() => {});
    });
  });

  // Urutan load yang jelas: status -> connection info -> (keduanya sudah
  // render field masing-masing begitu response datang). Dipanggil bersamaan
  // juga di interval polling supaya Connection Info ikut pulih otomatis
  // kalau sempat gagal (mis. token baru saja diisi, request awal 401).
  async function refreshAll() {
    await refreshStatus();
    await refreshLogs();
    await loadConnectionInfo();
  }

  refreshAll();
  setInterval(refreshAll, 3000);
})();
