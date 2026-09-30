# Sesi 2026-09-30 — Commit kode pencegahan sesi degraded + AGENTS.md

Status: selesai

Repo / branch: `WA-Gateway`, branch `master`.

## Selesai

- 4 file pencegahan degraded-session yang sudah berjalan langsung di
  produksi (`aulia3`, pid `13572`) sejak insiden 2026-09-29/30, tapi belum
  pernah masuk git, di-audit (diff isi per file terhadap `origin/master`),
  lalu di-commit dan di-push — commit `4d92075`:
  - `src/whatsapp/decryptTracker.js` (baru) — proxy transparan logger
    Baileys, menghitung `SessionError`/`MessageCounterError`/`Bad MAC`.
  - `src/whatsapp/connectionManager.js` — state `sessionHealth`
    (`ok`/`degraded`), `_recordDecryptFailure()`, `_recordMessageProcessed()`,
    `_sendDegradedAlert()`.
  - `src/config/index.js` — `DECRYPT_FAILURE_THRESHOLD`,
    `DECRYPT_FAILURE_WINDOW_MS`, `ADMIN_ALERT_PHONE`.
  - `src/delivery/heartbeat.js` — field `session_health` (aditif) ke CI4.
- `AGENTS.md` (731 baris, draft milik user) diverifikasi terhadap kode
  (semua referensi file/fungsi dicek langsung), 2 koreksi kecil diterapkan
  di contoh ilustratif §5, lalu di-commit `8d6bc6b` dan di-push.
- Branch lama `claude/agents-md-project-dev-0zlyvj` (AGENTS.md versi usang,
  93 baris, sepenuhnya tergantikan) dihapus dari GitHub.
- `\\aulia3\D\WA-Gateway` diinisialisasi sebagai git repo (sebelumnya bukan
  repo — akar penyebab drift yang membuat commit di atas nyaris tidak
  pernah tersimpan). Sekarang identik dengan `origin/master`.
- `docs/sesi/`, `docs/CHANGELOG.md` dibuat sebagai konvensi checkpoint
  lintas-sesi.

## Keputusan penting

- Kode di `aulia3` adalah sumber kebenaran untuk diff (bukan sebaliknya) —
  karena sudah berjalan dan terbukti di produksi sejak insiden.
- File scratch/ops lokal di `aulia3` (`_checkfw*.ps1`, dll.) sengaja TIDAK
  ikut commit — dikecualikan lewat `.git/info/exclude` lokal di `aulia3`
  saja, bukan `.gitignore` yang di-commit.

## Tersisa / TODO

- [ ] Belum ada `test/simulate-*.js` yang mengunci logika
      `_recordDecryptFailure`/`_recordMessageProcessed` — risiko regresi
      diam-diam.
- [ ] Sesi WhatsApp Gateway saat ini belum login (menunggu scan QR ulang) —
      fitur degraded-session belum teruji end-to-end pasca-perubahan ini.

## Belum diverifikasi / risiko

- Perilaku `_sendDegradedAlert()` (notifikasi WA 1x ke admin) belum diuji
  dengan sesi WhatsApp nyata sejak commit ini di-push.

## Titik masuk sesi berikutnya

- **Baca**: `AGENTS.md` §1.3 (invariant), lalu file ini, lalu
  `docs/CHANGELOG.md` untuk kontrak `session_health`.
- **Jalankan**: `git -C C:\Projects\WA-Gateway status` dan
  `git -C \\aulia3\D\WA-Gateway status` — pastikan keduanya bersih dan
  sinkron sebelum mengubah kode gateway lagi.
