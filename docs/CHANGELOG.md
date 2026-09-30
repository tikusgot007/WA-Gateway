# CHANGELOG

Perubahan perilaku / kontrak WA-Gateway (utama: kontrak CI4 ↔ Gateway).
Format: tanggal, ringkas, sebut file/commit terkait.

## 2026-09-30 — Field `session_health` pada heartbeat & status API

- Kontrak lama: heartbeat ke CI4 mengirim `status`/`phone`/`gateway_version`;
  status hanya menggambarkan socket terbuka/tertutup.
- Kontrak baru: heartbeat menambah field **aditif** `session_health`
  (`ok`/`degraded`); `GET /api/status` mengembalikan `sessionHealth`.
  Field lama tidak berubah. `degraded` berarti socket `connected` tetapi sesi
  terindikasi tidak bisa memproses pesan (banyak kegagalan dekripsi tanpa satu
  pun keberhasilan).
- Alasan: mencegah insiden 2026-09-29/30 (pesan hilang ~12 jam tanpa
  peringatan; lihat `docs/sesi/2026-09-30-commit-decrypt-tracker-dan-agents-md.md`
  dan laporan insiden lengkap di repo AuliaPos).
- Referensi: commit `4d92075` — `src/whatsapp/decryptTracker.js` (baru),
  `src/whatsapp/connectionManager.js`, `src/config/index.js`,
  `src/delivery/heartbeat.js`.
