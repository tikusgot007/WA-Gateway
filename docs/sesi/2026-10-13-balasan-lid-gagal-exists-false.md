# Checkpoint Sesi

- **Tanggal**: 2026-10-13
- **Status**: selesai (kode + test); backfill data produksi `conv#244` menunggu eksekusi manual
- **Repo / branch**: `evolution-gateway` @ `b18a297` (branch `evolution`), belum di-commit

## Selesai

- `src/evolution/normalize.js` — resolusi LID→PN lewat `key.remoteJidAlt` untuk chat 1:1
  (`chatId`/`sender.phone`/`sender.jid` dari PN; `identity_hint.lid` = LID asli).
- `src/evolution/ci4Routes.js` — guard `isLidJid` di `/send` & `/send-media`
  (`UNSUPPORTED_CHAT_ID`, paritas `/read`).
- Test: `test/test-lifecycle.js` +5 kasus, `test/simulate-evolution-adapter.js` +2 guard.
  `npm test` full lulus (exit 0).

## Keputusan penting

- Opsi A (minimal): akar LID→PN + guard kirim; KLASIFIKASI `exists:false → failed`
  (poin 5d laporan M.A.R.A) ditunda sebagai TODO terpisah — alasan: menyentuh kontrak
  status kirim POS↔Gateway, layak di-review terpisah.

## Tersisa

- Backfill produksi `conv#244` (lihat §Backfill di bawah) — dijalankan manual terhadap
  DB produksi `aulia_inboxdb` (tidak dapat diakses dari PC dev: root@192.168.1.120 ditolak).
- Penandaan `exists:false` sebagai GAGAL definitif (`outgoingOperationService.js:194`).

## Belum diverifikasi / risiko

- Deploy ke `aulia7` belum dilakukan; kode tersimpan lokal, belum di-commit/push.
- Backfill bisa jadi MERGE (bukan sekadar isi nomor) bila conversation PN
  `6282245422009…` sudah ada terpisah — wajib cek dulu sebelum menimpa (lihat §Backfill).
- Belum ada test end-to-end nyata (kirim balasan ke kontak LID) — hanya unit/regresi.

## Backfill — prosedur manual (dijalankan oleh user di aulia-server2 / aulia7)

> Hanya **dev/data** yang paham DB produksi yang menjalankan ini. Semua langkah
> read-only dulu, mutasi hanya setelah hasil query diverifikasi.

1. Cek data aktual (read-only):

   ```sql
   SELECT id, chat_id, jid_type, phone, manual_phone, contact_name
   FROM aulia_inboxdb.conversations WHERE id = 244;

   SELECT * FROM aulia_inboxdb.conversation_identities WHERE conversation_id = 244;

   SELECT id, chat_id, jid_type, phone
   FROM aulia_inboxdb.conversations
   WHERE chat_id IN ('6282245422009@s.whatsapp.net','182690745680043@lid')
      OR phone = '6282245422009';
   ```

2. Cabang A — **belum ada** conversation lain untuk `6282245422009`:
   cukup isi identitas PN pada `conv#244` + tambah alias di `conversation_identities`:

   ```sql
   UPDATE aulia_inboxdb.conversations
   SET chat_id='6282245422009@s.whatsapp.net', jid_type='pn', phone='6282245422009'
   WHERE id=244;

   INSERT INTO aulia_inboxdb.conversation_identities (conversation_id, chat_id, jid_type, created_at)
   VALUES (244, '6282245422009@s.whatsapp.net', 'pn', NOW());
   ```

3. Cabang B — **sudah ada** conversation PN `6282245422009` (id `X` ≠ 244):
   itu kasus duplikat; arah yang aman adalah **merge riwayat `conv#244` ke `X`**
   (pindahkan `messages.conversation_id`, `conversation_handoffs`, alias identity),
   lalu tutup `conv#244`. Jangan menimpa nomor begitu saja. Susun SQL-nya setelah
   kedua id dan isinya dikonfirmasi; amannya kerjakan dalam transaksi + backup dump
   `aulia_inboxdb` lebih dulu (`docs/deploy.md` §3).

4. Verifikasi akhir: `SELECT chat_id, jid_type, phone FROM aulia_inboxdb.conversations
   WHERE id=244;` menampilkan identitas PN; kirim balasan uji lewat Inbox.

## Titik masuk sesi berikutnya

- **Baca**: `docs/CHANGELOG.md` (entri 2026-10-13), `docs/sesi/` ini.
- **Jalankan**: `npm test` di `C:\Projects\evolution-gateway` (harus lulus).