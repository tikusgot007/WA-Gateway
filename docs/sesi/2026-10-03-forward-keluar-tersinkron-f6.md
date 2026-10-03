# Checkpoint Sesi

- **Tanggal**: 2026-10-03
- **Status**: selesai (kode + test lulus di sandbox; verifikasi payload nyata ke instance Evolution menunggu)
- **Repo / branch**: `WA-Gateway`, branch `claude/forward-marker-outgoing-f6` (dari `evolution`)

## Selesai

- **TODO-F6** (Opsi A, brief tim lokal): forward KELUAR tersinkron dari WA Web/HP (`fromMe:true`, BUKAN lewat tombol "Teruskan" POS) kini ditandai `is_forwarded`, konsisten dengan forward MASUK (TODO-F5) dan forward lewat POS.
  - `src/evolution/normalize.js`: buang batas `!fromMe` pada `isForwardedIncoming` (direname `isForwarded`); `extractForwardFlag()` sendiri tidak diubah (sudah benar untuk kedua arah).
  - `src/delivery/incomingDelivery.js`: komentar diperbarui (field `is_forwarded` sekarang untuk kedua arah, perilaku kirim ke CI4 tidak berubah).
  - Tidak ada perubahan kontrak CI4 maupun kode AuliaPos -- `InboxGatewayApi.php` sudah menyimpan `is_forwarded` apa adanya dari payload Gateway, untuk arah mana pun (diverifikasi, tidak diubah).
  - Test: `test/simulate-evolution-adapter.js` bagian TODO-F5 dibalik jadi TODO-F5/TODO-F6 -- kasus forward keluar tersinkron sekarang mengharapkan `is_forwarded=1`, ditambah kasus non-regresi (pesan keluar tersinkron BIASA, bukan forward, tetap `is_forwarded=0`/field tidak dikirim).

## Keputusan penting

- Opsi A dipilih (bukan Opsi B/biarkan) -- keputusan eksplisit dari user berdasarkan rekomendasi brief tim lokal.

## Tersisa

Usulkan hapus baris TODO-F6 di `AuliaPos/docs/TODO.md` setelah verifikasi payload nyata di bawah selesai (butuh persetujuan user, lihat aturan `docs/TODO.md`).

## Belum diverifikasi / risiko

- Bentuk `contextInfo` pada forward KELUAR tersinkron **nyata** di instance Evolution (bukan stub) -- brief tim lokal sendiri mencatat ini sebagai risiko ("Bila bentuk contextInfo pada forward keluar berbeda di instance nyata, verifikasi dengan payload asli sebelum menutup item"). Stub test di sini memakai bentuk field yang sama dengan payload masuk TODO-F5 yang sudah terverifikasi nyata, tapi forward KELUAR tersinkron belum pernah dicoba sungguhan.
- Label "Diteruskan" tampil benar di Inbox POS untuk kasus ini -- belum dicek di browser (hanya diverifikasi lewat kode `Inbox.php`/`inbox-thread.js` yang membaca kolom `is_forwarded`, tidak lewat UI).

## Titik masuk sesi berikutnya

- **Baca**: file ini, `src/evolution/normalize.js` (komentar di sekitar `isForwarded`), `docs/CHANGELOG.md` entri TODO-F6.
- **Jalankan**: `npm test`; untuk verifikasi nyata, minta staf meneruskan pesan dari WA Web/HP (bukan tombol POS) ke percakapan pelanggan, cek baris di Inbox POS berlabel "Diteruskan".
