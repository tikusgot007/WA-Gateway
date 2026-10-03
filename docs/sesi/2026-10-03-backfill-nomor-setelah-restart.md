# Checkpoint Sesi

- **Tanggal**: 2026-10-03
- **Status**: selesai (kode + test lulus di sandbox; verifikasi manual ke instance Evolution nyata menunggu)
- **Repo / branch**: `WA-Gateway`, branch `claude/gateway-status-phone-f2` (dari `evolution`)

## Selesai

- **TODO-F2**: `phone` di `gateway_status` jadi `NULL` setelah adapter restart.
  - Root cause: `evolution/state.js` `internal.phone` reset ke `null` saat proses start, dan HANYA terisi dari webhook `CONNECTION_UPDATE` — yang Evolution tidak kirim ulang kalau state tidak berubah sejak restart.
  - Fix: `evolution/client.js` `getInstancePhone()` (baru, `GET /instance/fetchInstances?instanceName=`) dipanggil dari `heartbeat.js` `refreshStateFromEvolution()` HANYA saat nomor belum diketahui DAN state resolve ke `connected` — backfill sekali, bukan tiap siklus 15 detik.
  - Kontrak Gateway↔CI4 **tidak berubah** (field `phone` sama seperti sebelumnya).
  - Test baru: `test/simulate-evolution-phone-backfill.js` (5 skenario: backfill saat kosong, tidak dipanggil saat nomor sudah ada, tidak dipanggil saat belum connected, gagal/null tidak crash, reject tidak crash), terpasang di `npm test`.

## Keputusan penting

- Dipilih backfill dari Evolution langsung (bukan persist nomor lama ke disk) — alasan: persist bisa menampilkan nomor LAMA yang salah kalau WA number berganti sebelum `CONNECTION_UPDATE` baru datang; kosong jelas "belum diketahui", nomor lama salah lebih menyesatkan.
- `getInstancePhone()` dibungkus try/catch tambahan di `heartbeat.js` walau fungsinya sendiri didesain tidak pernah `throw` — pengaman kedua, ditemukan lewat test yang menguji skenario reject.

## Tersisa

Lihat `AuliaPos/docs/TODO.md` (TODO-F2) — usul dihapus setelah verifikasi manual di bawah selesai.

## Belum diverifikasi / risiko

- **Bentuk respons `GET /instance/fetchInstances`** (field `number`/`ownerJid`) diambil dari dokumentasi publik Evolution API, BUKAN source code resmi seperti fungsi lain di `client.js` — belum pernah dicoba ke instance Evolution v2.3.7 yang sebenarnya dipakai. Kalau bentuknya berbeda, `getInstancePhone()` akan mengembalikan `null` dengan aman (tidak crash), tapi backfill tidak akan bekerja — perlu dicek manual (lihat README.md catatan verifikasi klien Evolution).
- Skenario nyata "restart adapter dengan sesi sudah connected" belum dicoba di gateway produksi (aulia3) — hanya diverifikasi via stub di `test/simulate-evolution-phone-backfill.js`.

## Titik masuk sesi berikutnya

- **Baca**: file ini, `src/evolution/client.js` (komentar `getInstancePhone`), `src/evolution/heartbeat.js`.
- **Jalankan**: `npm test`; untuk verifikasi manual, restart adapter di aulia3 saat sesi WA sudah connected lama, cek `gateway_status.phone` di `aulia_inboxdb` tidak NULL dalam satu siklus heartbeat (~15 detik) setelah boot.
