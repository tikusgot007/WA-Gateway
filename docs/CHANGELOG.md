# Changelog

Semua perubahan signifikan pada adapter `evolution-gateway` dicatat di sini.
Format bebas, kronologis terbaru di atas.

## 2026-10-07 — WhatsApp read receipt (dua arah): `/read` + event `MESSAGES_UPDATE`

- Endpoint baru `POST /read` (Bearer CI4 token): AuliaPos meminta adapter
  menandai pesan MASUK pelanggan sebagai dibaca -> Evolution
  `POST /chat/markMessageAsRead/{instance}` body
  `{ readMessages: [{ id, fromMe:false, remoteJid }] }`. `@lid`/grup ditolak
  lebih awal (Evolution tidak mendukung read untuk keduanya).
- Event `MESSAGES_UPDATE` TIDAK lagi dibuang: `messages.update`
  (`fromMe=true`, `status` `READ`/`DELIVERY_ACK`) dinormalisasi
  (`normalizeMessagesUpdate`) lalu diteruskan lewat buffer durabel ke CI4
  `POST /api/inbox/gateway/message-status`. Idempotent via `messageId` sintetis
  `status:<status>:<wa_message_id>` (INSERT OR IGNORE). Status lain, pesan
  masuk (`fromMe=false`), dan grup di-skip.
- File: `src/evolution/client.js` (`markMessageAsRead`), `src/evolution/ci4Routes.js`
  (`POST /read`), `src/evolution/normalize.js` (`normalizeMessagesUpdate`),
  `src/evolution/webhookRoutes.js` (`handleMessagesUpdate`), `src/evolution/jid.js`
  (`isLidJid`), `src/delivery/incomingDelivery.js` (`deliverStatus`).
- Test: `test/test-read-status.js` (pure). Dijalankan bersama suite `npm test`.
- Catatan: `test/simulate-evolution-adapter.js` punya kegagalan assertion
  pra-eksisting ("path webhook/set benar") yang sudah merah di HEAD sebelum
  perubahan ini.

## 2026-10-05 — TODO-F8 masuk `evolution` (dekripsi teks pesan diedit + patch LID)

- `evolution` di-fast-forward ke `integration/realtime-f8` (`ba4bcf3..e653de5`),
  yang memuat F8 **dan** kerja realtime. PR #5 (`todo-f8-capture-fixture`) merged.
- Isi F8: `src/evolution/messageEditCrypto.js` (HKDF-SHA256 + AES-256-GCM +
  decode protobuf `WAProto.Message`), `src/evolution/messageEditResolver.js`
  (kandidat `origMsgSender`/`editSender` termasuk `remoteJidLid`), dan
  pengiriman `edited_text` tervalidasi ke CI4 saat event `edited`.
- Patch deployment LID: `installer/apply-lid-preservation-patch.ps1`
  menyimpan LID asli ke `key.remoteJidLid` sebelum `remoteJid` dinormalisasi ke
  PN, dan menghapus log raw (`console.log(messageRaw)` /
  `this.logger.verbose(messageRaw)`) di jalur `MESSAGES_UPSERT`. Harus
  di-reapply tiap upgrade Evolution (pola TODO-F3).
- **Perilaku default tidak berubah**: dekripsi edit hanya aktif bila
  `EVOLUTION_DECRYPT_MESSAGE_EDIT=1`. Bila dekripsi gagal, perilaku TODO-F7
  (marker `edited` tanpa mengganti teks) tetap berjalan.
- Verifikasi: `npm test` semua suite OK (realtime websocket 30/30);
  `installer/tests/check-lid-preservation-patch.ps1` PASS; E2E nyata
  WhatsApp → Evolution (LID preserved) → gateway → POS dikonfirmasi user.
- Rollout produksi 2026-10-05 (aulia3 `D:\evolution-gateway`): build di-copy manual
  (bukan git; `npm` tidak ada → `ws@8.22.0` disalin ke `node_modules`), patch LID
  dipasang ke `D:\evolution-api-server`, Evolution + adapter di-restart, lalu
  `EVOLUTION_DECRYPT_MESSAGE_EDIT=1` diaktifkan. F7 & F8 terverifikasi nyata;
  rollback lewat backup `D:\backup\evolution-gateway-pre-f8-*` / mengosongkan flag.

## 2026-10-03 — TODO-F6: forward KELUAR tersinkron dari WA Web/HP kini ditandai "Diteruskan"

- Akar: `normalize.js` `extractForwardFlag()` sudah bisa membaca
  `contextInfo.isForwarded`/`forwardingScore` untuk arah mana pun, tapi
  dibatasi `!fromMe` -- jadi staf yang meneruskan pesan langsung dari WA
  Web/HP (bukan lewat tombol "Teruskan" POS) tidak pernah ditandai
  `is_forwarded`. Bukti payload nyata: `evolution.log` 2026-10-02 baris
  7925-7969 (`fromMe:true` + `forwardingScore:1`).
- Perbaikan: buang batas `!fromMe` di `normalize.js` (variabel
  `isForwardedIncoming` -> `isForwarded`, sekarang dihitung untuk kedua
  arah). Tidak ada perubahan kontrak CI4 -- `is_forwarded` tetap field
  opsional yang sama di `POST /api/inbox/gateway/messages`.
- Tidak terdampak: forward lewat tombol "Teruskan" POS tetap ditandai dari
  jalur CI4-nya sendiri (`kirimKeConversation()` di `Inbox.php`, repo
  AuliaPos) -- itu jalur terpisah, tidak lewat webhook adapter ini. Echo
  pesan kiriman adapter sendiri tetap difilter `ownSentRegistry` sebelum
  sampai ke pengecekan forward, jadi tidak ada penandaan dobel.
- Belum diverifikasi: bentuk `contextInfo` pada forward KELUAR tersinkron di
  instance Evolution nyata (stub test memakai bentuk yang sama dengan
  payload masuk TODO-F5, yang sudah terverifikasi nyata).

## 2026-10-03 — insiden ops: Avast aulia3 mengarantina script gateway

- Gejala: adapter (port 3000) mati tanpa error di `adapter.log`; file
  `scripts\run-adapter.cmd`, `scripts\watchdog-stack.ps1`,
  `scripts\backup-stack.ps1` **hilang** dan tak bisa ditulis ulang
  ("Access denied"); task `AuliaAdapter`/`AuliaStackWatchdog`/`AuliaBackup`
  ikut lenyap -> tak ada auto-heal.
- Penyebab: **Avast Antivirus** di aulia3 mengarantina script yang menjalankan node.
- Tindakan: tambahkan pengecualian Avast (**Exceptions** + **Ransomware Shield
  allowed folder**) untuk `D:\evolution-gateway` (opsional: `D:\kilo`, `D:\node`,
  `D:\evolution-api-server`). Setelah exclusion, nama standar dipulihkan dan task
  didaftarkan ulang.
- **Penting**: exclusion Avast **tidak bisa diatur via remote/CLI** (Avast Free
  tak punya `ashCmd`; setelan hanya lewat UI). Wajib RDP/UI aulia3.
- Pemulihan sementara saat insiden: runner nama alternatif (`run-adapter2.cmd`
  dll.) karena nama lama diblokir Avast; file `*2` dihapus setelah exclusion.
- Verifikasi pasca: `D:\evolution-gateway\scripts\*` tetap ada, task lengkap,
  port 3000 listen, Evolution `open`.

## 2026-10-03 — TODO-O1: backup terjadwal (PostgreSQL + SQLite + media + .env)

**Status**: helper SQLite terverifikasi lokal; backup penuh belum dijalankan di aulia3.

- Akar: belum ada backup terjadwal untuk PostgreSQL Evolution, SQLite antrean,
  `data/media`, dan `.env`.
- Perbaikan:
  - `scripts/backup-sqlite.js` (baru): backup SQLite ONLINE via
    `better-sqlite3 db.backup()` (aman saat adapter hidup).
  - `scripts/backup-stack.ps1` (baru): `pg_dump -Fc` (kredensial dibaca dari
    `DATABASE_CONNECTION_URI` env Evolution), backup SQLite, zip `media`, zip
    `.env` (rahasia) ke `D:\backup\aulia3\`; retensi 30 hari; log
    `D:\kilo\backup.log`; fail-soft, exit 1 bila ada bagian gagal.
  - `register-services.ps1`: task baru `AuliaBackup` (harian 20:00, SYSTEM,
    StartWhenAvailable).
- Catatan: backup berada di disk yang SAMA (D: aulia3) -- belum melindungi dari
  kerusakan disk; salin ke share bisa ditambah kemudian.

## 2026-10-03 — TODO-O3: rotasi log otomatis saat boot + prune arsip

**Status**: logika rotate/prune/gzip terverifikasi lokal (folder temp); belum
dijalankan di aulia3.

- Akar: `adapter.log` & `evolution.log` ditulis proses lewat `>>` (file dipegang
  selama proses hidup) tanpa rotasi apa pun → tumbuh tanpa batas (~49 MB/tahun
  dan ~620 MB/tahun). Tidak ada task terjadwal untuk merawat log.
- Perbaikan:
  - `scripts/rotate-logs.ps1` (baru): pindahkan log non-kosong ke
    `logs\arsip\<nama>_<stamp>.log` (+gzip) lalu buat file kosong baru; prune
    arsip lebih tua dari `KeepDays` (default 180 hari). Mode tanpa `-LogName`
    hanya prune (tidak menyentuh log hidup).
  - `run-adapter.cmd` / `run-evolution.cmd`: panggil rotate SEBELUM node start
    (saat file belum dipegang) → karena PC gateway mati tiap malam, tiap boot
    menghasilkan rotasi praktis harian tanpa downtime tambahan.
  - `register-services.ps1`: task baru `AuliaLogRotate` (harian 09:00, SYSTEM)
    menjalankan prune arsip.
- Catatan: rotasi live saat proses hidup TIDAK mungkin di Windows (file
  dipegang), karena itu pendekatannya rotasi-saat-boot.

## 2026-10-03 — TODO-O2: aktifkan retensi (media, kutipan, antrean completed)

**Status**: terverifikasi lewat tes regresi (`npm test`, termasuk
`test/simulate-maintenance.js`); belum diuji dengan data produksi nyata.

- Akar: `mediaStore.prune()` (`src/evolution/mediaStore.js:90`) dan
  `quotedStore.prune()` (`src/evolution/quotedStore.js:80`) sudah ada tapi
  TIDAK PERNAH dipanggil, sehingga `MEDIA_RETENTION_DAYS` & `QUOTED_STORE_TTL_MS`
  tak berefek. Tabel SQLite `incoming_queue` juga tak punya prune untuk baris
  `completed` (hanya fallback JSON yang membuang completed >30 hari).
- Perbaikan:
  - `src/store/incomingBuffer.js`: `pruneCompleted(olderThanMs)` di kedua
    implementasi (SQLite `DELETE ... WHERE status='completed' AND updated_at <
    cutoff`; JSON filter + `_persist()`). `pending`/`failed`/`dead` tidak disentuh.
  - `src/config/index.js`: env baru `INCOMING_QUEUE_RETENTION_DAYS` (default 30).
  - `src/app/evolution.js`: `runMaintenancePrune()` memanggil ketiga prune,
    fail-soft (kegagalan dicatat, tak menghalangi start); dijalankan saat start
    dan tiap 24 jam (`setInterval(...).unref()`).
- Keputusan retensi media: dinaikkan ke **180 hari** (default kode & `.env.example`,
  dari sebelumnya 7) karena media store gateway adalah fallback live-fetch bila
  prefetch POS gagal -- memangkas 7 hari berisiko media lama tak bisa diunduh.
- Tes baru `test/simulate-maintenance.js` (ditambahkan ke `npm test`).

## 2026-10-02 — TODO-F5: pesan masuk yang diteruskan pelanggan kini ditandai

**Status**: terverifikasi lewat tes regresi (`npm test`); belum diuji ulang
dengan kiriman nyata pasca-fix.

- Akar: adapter tidak pernah membaca sinyal "diteruskan" dari webhook
  WhatsApp, dan rantai transport masuk (adapter -> buffer SQLite -> POST ->
  CI4) tidak punya tempat untuk field itu. Akibatnya kolom
  `messages.is_forwarded` di `aulia_inboxdb` selalu `0` untuk pesan MASUK.
  Fitur "Teruskan" untuk pesan KELUAR sudah lengkap di CI4; gap murni di sisi
  masuk. Lihat `docs/TODO.md` AuliaPos (TODO-F5).
- Sampel nyata (prasyarat investigasi, `evolution.log` 2026-10-02 16:41:37
  WIB, chat 628563324637, `messageType: 'conversation'`):
  `contextInfo: { forwardingScore: 1, isForwarded: true, forwardOrigin: 0 }`,
  SEJAJAR `message` di level `record` -- sama seperti posisi `stanzaId`
  kutipan (TODO-F4).
- Perbaikan (semua aditif, payload pesan biasa tidak berubah bentuk):
  - `src/evolution/normalize.js` `extractForwardFlag()`: baca
    `record.contextInfo.isForwarded === true` (utama) atau
    `forwardingScore > 0` (fallback kompatibilitas). Hanya berlaku untuk
    pesan MASUK (`fromMe=false`) -- forward KELUAR tersinkron di luar cakupan.
  - `src/store/incomingBuffer.js`: kolom `is_forwarded INTEGER NOT NULL
    DEFAULT 0` (migrasi `ALTER TABLE` idempoten), diisi di `enqueue()`.
  - `src/delivery/incomingDelivery.js`: kirim `is_forwarded: true` HANYA bila
    benar (pola sama dengan `quoted`/`extra`).
  - CI4 `InboxGatewayApi::messages()` membaca & menyimpan field opsional itu ke
    kolom `messages.is_forwarded` yang SUDAH ADA (reuse, tanpa migrasi baru);
    UI "Diteruskan" sudah membacanya. Perubahan CI4 terpisah (repo aulia-app).
- Tes baru di `test/simulate-evolution-adapter.js` (section "TODO-F5"):
  forward masuk ditandai, pesan biasa tidak membawa field, fallback
  `forwardingScore` saja, dan forward KELUAR tersinkron TIDAK ikut ditandai.


## 2026-10-02 — TODO-F4: kutipan balasan masuk hilang untuk balasan teks polos

**Status**: terverifikasi lewat tes regresi (`npm test`); belum diuji ulang
dengan kiriman nyata pasca-fix.

- Akar: `extractQuotedContext()` (`src/evolution/normalize.js`) hanya membaca
  `contextInfo` di DALAM sub-objek tipe pesan (`extendedTextMessage.contextInfo`,
  dst). Payload nyata Evolution untuk balasan teks polos (`message.conversation`)
  menaruh `contextInfo` SEJAJAR `message`, di `record.contextInfo` --
  terverifikasi dari `evolution.log` produksi (conv id=6, message id=190
  "Siap di goyang" seharusnya membalas sticker id=183). Akibatnya
  `quoted_wa_message_id` tersimpan `NULL`, kutipan tidak tampil di Inbox
  walau pesan sendiri tersimpan normal. Lihat `docs/TODO.md` AuliaPos (TODO-F4)
  dan `X:\handoff\analisis-akar-masalah-gateway-f4-f5.md`.
- Perbaikan:
  - `extractQuotedContext()` kini menerima `record` juga, dan mengecek
    `record.contextInfo.stanzaId` LEBIH DULU sebelum sub-objek (tidak
    mengubah pesan yang memang bukan balasan).
  - Daftar kandidat sub-objek dikembalikan ke 6 tipe (tambah `audioMessage`,
    `videoMessage`) -- paritas gateway Baileys lama (`connectionManager.js`),
    yang sebelumnya hanya 4 tipe di adapter Evolution.
  - `quoted.snippet` dipulihkan (`buildQuotedSnippet()`, reuse `extractText`/
    `detectMessageType` yang sudah ada): teks dipotong 200 karakter atau label
    `[Foto]`/`[Dokumen]`/`[Stiker]`/`[Audio]`/`[Video]`. CI4
    (`InboxGatewayApi::resolveKutipanMasuk`) sudah memvalidasi/memotong field
    ini (SEC-002/SEC-003) -- field aditif, TIDAK ada perubahan CI4.
- Tes baru di `test/simulate-evolution-adapter.js` (section "TODO-F4"): kasus
  nyata `record.contextInfo` (conversation), non-regresi path lama
  (`extendedTextMessage`), cakupan baru (`audioMessage`/`videoMessage`),
  pemotongan snippet 200 karakter, dan `quoted.snippet` ikut terkirim ke CI4.
- Belum diverifikasi (di luar cakupan fix ini, lihat dokumen analisis):
  kutipan pada pesan yang dibungkus wrapper (`ephemeralMessage`/
  `viewOnceMessage*`/`editedMessage`/`documentWithCaptionMessage`); pemetaan
  `sender_jid` kutipan berbentuk `@lid` (CI4 saat ini tidak memakai
  `quoted.sender_jid`, jadi risiko ini belum berdampak).


## 2026-10-01 — mediaMode `ondemand`: jaminan berkas besar tidak hilang senyap

**Status**: terverifikasi di aulia3 (webhook `webhookBase64:false`; pesan nyata
diunduh ulang oleh adapter).

- Masalah: pada mode `base64`, badan webhook ikut sebesar berkas (+33%). Berkas
  di atas batas badan ditolak **413 sebelum terbaca**, jadi adapter tidak tahu
  pesan/pengirimnya dan mustahil membuat baris penanda -> kasir tidak tahu ada
  yang tertolak.
- Solusi: `EVOLUTION_MEDIA_MODE=ondemand` -> `webhook:set` mendaftarkan webhook
  dengan `base64:false`. Badan webhook selalu kecil, adapter lalu:
  - memutuskan dari **metadata `fileLength`** (tanpa unduh) bila sudah melebihi
    `maxIncomingMediaBytes` -> baris penanda "Customer mengirim file besar …";
  - kalau tidak, mengunduh lewat `POST /chat/getBase64FromMediaMessage/{instance}`
    (`client.getMediaBase64`), dengan pengaman `Content-Length`;
  - unduhan gagal/timeout -> baris penanda "Customer mengirim berkas — gagal
    diambil …".
- Karena itu `EVOLUTION_WEBHOOK_BODY_LIMIT` tidak lagi menjadi penentu: tidak
  ada lagi ukuran berkas yang "terlalu besar untuk diberi tahu".
- Tambahan: `npm run webhook:info` untuk memverifikasi `webhookBase64` cocok
  dengan `mediaMode` (secret disensor).
- Mode `base64` tetap didukung (jalur lama) supaya perubahan ini aditif.
- Env baru: `EVOLUTION_MEDIA_FETCH_TIMEOUT_MS` (default 60000).


## 2026-10-01 — View-once dari pelanggan + batas ukuran media masuk

**Status**: terverifikasi lewat kiriman nyata dari HP ke Inbox produksi.

### View-once kini muncul sebagai penanda (sebelumnya hilang total)
- Akar: WhatsApp mengirim view-once ke perangkat tertaut sebagai stanza
  `<unavailable type="view_once">` — `key.isViewOnce = true`, `message` KOSONG.
  Evolution 2.3.7 membuang pesan tanpa `message` sebelum webhook dikirim
  (`whatsapp.baileys.service.ts:1166`), jadi adapter tidak pernah menerimanya.
- Perbaikan dua sisi:
  - **Patch Evolution** (1 blok, wajib diterapkan ulang saat upgrade) —
    lihat `docs/evolution-viewonce-patch.md`.
  - **Adapter** `isViewOnceMessage()`: `key.isViewOnce` atau pembungkus
    `viewOnceMessage*` -> satu baris penanda
    `[Pelanggan mengirim pesan lihat-sekali — ...]`, media TIDAK diunduh
    (paritas CON-002 gateway lama). View-once keluar diabaikan.

### Media masuk melebihi ambang tidak lagi hilang senyap
- Akar: batas badan webhook 16 MB -> berkas > ±12 MB (base64 +33%) ditolak 413
  berulang, hanya tercatat sebagai warn, pesan tidak masuk antrean. Terbukti
  dari dokumen 27 MB pelanggan yang hilang (lalu pulih setelah fix).
- Perbaikan: `maxIncomingMediaBytes` (default 64 MB) +
  `webhookJsonBodyLimit` (default 160mb, harus > base64 ambang). Media di atas
  ambang TIDAK diunduh — dikirim sebagai penanda
  `Customer mengirim file besar diatas 64mb — cek WhatsApp Web.`
- Env: `EVOLUTION_MAX_INCOMING_MEDIA_MB`, `EVOLUTION_WEBHOOK_BODY_LIMIT`.


## 2026-10-01 — Tahap 4: media/quote/forward + 3 perbaikan bug (uji nyata via UI POS)

**Status**: TERVERIFIKASI lewat UI Inbox AuliaPos (media masuk & keluar, dokumen,
sticker, quote teks, quote sticker, forward teks), tanpa mengubah kode AuliaPos.

### Perbaikan bug (ditemukan dari uji UI POS)

1. **Media KELUAR tidak tampil di Inbox ("Gambar tidak tersedia").**
   - Akar: `/send-media` mengembalikan `mediaRef: null` (Evolution tidak memberi
     directPath/mediaKey), sehingga CI4 menyimpan `media_metadata = NULL`
     (`Inbox.php:3502-3512`, `1473-1494`) dan UI menolak merender (`Inbox.php:510`).
   - Perbaikan: adapter menyimpan byte media keluar ke `mediaStore` dan
     mengembalikan `media_ref = { direct_path: 'evolution-media:<id>',
     media_key_base64: 'evolution' }` (ref yang sama seperti media masuk).
2. **Kirim STICKER selalu gagal (`500 Invalid URL`).**
   - Akar: Evolution v2.3.7 `mediaSticker()` memakai `data.sticker` (bukan upload
     multipart `file`) → `convertToWebP(undefined)` gagal.
   - Perbaikan: `client.sendSticker` mengirim JSON `{ number, sticker: <base64> }`.
3. **Quote STICKER muncul di WhatsApp Web tapi TIDAK di HP.**
   - Akar: `quoted.message` memuat field `bytes` sebagai objek JSON `{"0":..,"1":..}`;
     dikirim balik → protobuf salah decode → client HP gagal render quote sticker
     (quote teks tidak terpengaruh, karena tidak butuh field byte media).
   - Perbaikan: `resolveQuoted()` mengonversi objek byte-array → base64 (protobufjs
     menerima base64 untuk `bytes`) dan membersihkan `quoted.key` → `{ id, remoteJid,
     fromMe }` (+`participant` bila ada).
   - Bukti A/B: byte sebagai objek → quote tidak muncul di HP; byte sebagai base64
     (atau kirim `key` saja) → quote muncul. Setelah perbaikan, balas sticker via
     adapter muncul di HP.

### Fitur: dukungan GRUP (Uji 7)

- Pesan grup berjalan dua arah (masuk & keluar ke `...@g.us`).
- Ditambahkan `src/evolution/groupInfo.js`: saat pesan grup masuk, adapter mengambil
  info grup dari `GET /group/findGroupInfos` (di-cache 10 menit,
  `GROUP_INFO_CACHE_TTL_MS`), lalu:
  - mengisi `group_name` dari `subject` grup (sebelumnya NULL); dan
  - memetakan pengirim LID (`...@lid`) → JID nomor via `participants[].phoneNumber`,
    sehingga `messages.sender_jid` tersimpan sebagai nomor (mis.
    `628563324637@s.whatsapp.net`), bukan LID.
- Kegagalan pengambilan info grup bersifat NON-FATAL (pesan tetap diteruskan).

### Hasil uji (via UI Inbox POS)

- Gambar keluar (image), dokumen keluar (xlsx), media masuk (gambar + sticker).
- Quote teks dan quote sticker (keduanya tampil di HP setelah perbaikan).
- Forward teks (`↪️ Diteruskan:` prefix, `forward_marker_applied=text_fallback`).
- Grup: pesan masuk & keluar; `group_name` terisi; `sender_jid` dipetakan ke nomor.

### Catatan

- Format `media_ref` mengikuti kontrak CI4 — **AuliaPos tidak diubah**.
- Media keluar disimpan di `MEDIA_STORE_DIR` dan ikut retensi `MEDIA_RETENTION_DAYS`
  (media lama > retensi tidak bisa dimuat ulang — batasan yang sama seperti media masuk).

## 2026-10-01 — Beralih ke PostgreSQL (DB yang didukung Evolution) + uji ulang

**Status**: TERVERIFIKASI penuh di PostgreSQL (masuk, keluar, heartbeat, status kirim).

### Latar

Pada uji MariaDB, Evolution API v2.3.7 menjalankan raw SQL khusus PostgreSQL
(`updateChatUnreadMessages` dll) yang gagal (`P2010`) dan membatalkan handler
`messages.upsert` sebelum webhook dikirim. Alih-alih menambal satu per satu,
Evolution dipindah ke **PostgreSQL** (DB default yang didukung).

### Perubahan lingkungan (mesin dev)

- PostgreSQL 16.15 dipasang native; cluster di `C:\Projects\pgdata-evolution`
  (`initdb` manual, karena installer winget EDB terputus di tengah). Dijalankan
  dengan `pg_ctl -D C:\Projects\pgdata-evolution -o "-p 5432" start`.
- Database `evolution_gateway_pg`, role `evolution_gw`.
- `evolution-api-server/.env`: `DATABASE_PROVIDER=postgresql` +
  `DATABASE_CONNECTION_URI=postgresql://evolution_gw:***@127.0.0.1:5432/evolution_gateway_pg?schema=public`,
  dan `DATABASE_SAVE_DATA_NEW_MESSAGE=true` dikembalikan (workaround MySQL dihapus).
- Migrasi PostgreSQL (`prisma migrate deploy`) diterapkan; instance `aulia-uji`
  dibuat ulang + pairing ulang (sesi disimpan di DB).
- Redis tetap dimatikan (`CACHE_REDIS_ENABLED=false`, cache lokal).

### Hasil uji ulang

- Keluar: `POST /send` → `wa_message_id` OK.
- Masuk: `messages.upsert` → buffer → CI4 → baris `messages.direction=incoming`
  (`id=7`, "Apa 5") OK.
- `connection.update` → heartbeat `connected` OK.
- **`messages.update` (status kirim) kini diterima** — event ini gagal di
  MariaDB, sekarang normal.

### Catatan operasional tambahan

- **Jangan restart instance lalu langsung mengirim**: saat restart, socket
  menutup dan Evolution menjawab `500 Connection Closed`; adapter
  mengembalikan `504 SEND_UNRESOLVED` (`state: in_flight`). Tunggu instance
  benar-benar stabil `open` sebelum mengirim/menguji.
- DB MySQL sementara `evolution_gateway_db` (dari uji sebelumnya) kini tidak
  terpakai; boleh dihapus manual (bukan operasi yang dijalankan otomatis).

## 2026-10-01 — Tahap 2 & 3: uji nyata end-to-end dengan Evolution API v2.3.7

**Status**: TERVERIFIKASI (teks 2 arah + heartbeat), tanpa mengubah kode
AuliaPos.

### Perbaikan kode adapter

- `setWebhook` (`src/evolution/client.js`): body dibungkus `{ webhook: {...} }`
  dan memakai field `byEvents`, sesuai schema resmi v2.3.7
  (`src/api/integrations/event/webhook/webhook.schema.ts`); contoh di
  dokumentasi (flat) ditolak server.
- `test/simulate-evolution-adapter.js`: tambah seksi yang mengunci mapping
  request klien nyata (path `/message/sendText/{instance}` & `/webhook/set/{instance}`,
  header `apikey`, body `text` flat, body webhook bersarang). Semua lulus.

### Hasil yang diverifikasi (bukti nyata)

- Kirim teks adapter → Evolution → WhatsApp: `POST /send` mengembalikan
  `wa_message_id`.
- Kirim dari UI Inbox AuliaPos: adapter menerima `operation_id` UUID dari CI4
  dan mengirim sukses.
- Pesan masuk: `messages.upsert` → buffer durable → `POST /api/inbox/gateway/messages`
  → baris `messages.direction=incoming` di `aulia_inboxdb`.
- Heartbeat: `gateway_status` = `connected` / `session_health=ok`.
- Payload webhook `messages.upsert` asli direkam; cocok dengan `normalize.js`.

### Temuan operasional (didokumentasikan di README)

1. **Webhook yang di-`set` setelah instance dibuat baru aktif setelah
   instance direstart** — penyebab webhook pesan masuk tidak terkirim pada
   percobaan pertama.
2. **MariaDB/MySQL: Evolution v2.3.7 menjalankan raw SQL khusus PostgreSQL**
   (`updateChatUnreadMessages`), Prisma `P2010`, membatalkan handler
   `messages.upsert` sebelum webhook dikirim. Workaround uji:
   `DATABASE_SAVE_DATA_NEW_MESSAGE=false`. Rekomendasi: PostgreSQL.
   Juga ada error non-fatal `Unknown argument 'lid'` di `onWhatsappCache`.
3. `@lid` di-resolve Evolution ke JID nomor (`@s.whatsapp.net`) pada payload
   webhook (via `remoteJidAlt`).

### Prasyarat lingkungan uji (mesin dev)

- Evolution API v2.3.7 native (Node + MariaDB XAMPP, `evolution_gateway_db`),
  port 8080; adapter port 3000; AuliaPos `http://127.0.0.1/aulia-app`.
- Migration AuliaPos `2026-09-30-000001_AddSessionHealthToGatewayStatus`
  (sudah ada di repo, aditif) diterapkan ke `aulia_inboxdb` agar heartbeat
  menerima kolom `session_health` (disetujui user).

## 2026-10-01 — Tahap 1: skeleton repo + kontrak CI4 (mock Evolution)

**Status**: implementasi awal, test lulus, **belum diuji dengan Evolution API
nyata**.

### Ditambahkan

- Struktur repo baru, dibuat dari cetak biru `spike/fonnte` (repo
  `WA-Gateway`): modul durability (`src/store/*`, `src/delivery/*`,
  `src/logging/*`, `src/whatsapp/mediaPayload.js`,
  `src/whatsapp/forwardMarker.js`, `src/api/authMiddleware.js`) disalin
  apa adanya (bebas Baileys, tidak perlu diubah).
- `src/config/index.js` — blok `config.ci4` (kontrak AuliaPos) dan
  `config.evolution` (base URL, apikey, instance, webhook path/secret,
  mode media, TTL quoted store).
- `src/evolution/jid.js` — konversi nomor ↔ JID, deteksi JID grup.
- `src/evolution/state.js` — status koneksi Evolution → heartbeat CI4;
  `session_health` selalu `"ok"` (tidak ada tracker dekripsi di jalur ini).
- `src/evolution/ownSentRegistry.js` — saring echo webhook untuk pesan yang
  dikirim adapter sendiri (mencegah duplikasi di Inbox).
- `src/evolution/quotedStore.js` — simpan `key`+`message` pesan Evolution
  saat pesan masuk, di-key oleh `wa_message_id`, untuk membangun `quoted`
  Evolution saat kasir membalas. Fallback in-memory bila `better-sqlite3`
  tidak tersedia.
- `src/evolution/mediaStore.js` — simpan media masuk secara lokal
  (keputusan §6.2 opsi A pada rencana), menyerahkan ref opaque
  `evolution-media:<id>` sebagai `direct_path` untuk `/media/download`.
- `src/evolution/client.js` — klien REST Evolution API v2.3.7
  (`sendText`, `sendMedia`, `sendSticker`, `getConnectionState`,
  `setWebhook`), header `apikey` (bukan Bearer). Bentuk payload
  diverifikasi dari docs resmi + source code `evolution-foundation/evolution-api`.
- `src/evolution/normalize.js` — normalisasi webhook `MESSAGES_UPSERT` dan
  `CONNECTION_UPDATE` → event buffer internal. **Ditulis defensif**:
  bentuk payload nyata belum direkam (lihat README "Yang belum
  terverifikasi").
- `src/evolution/ci4Routes.js` — endpoint kontrak CI4 (`/send`,
  `/send-media`, `/media/download`) dengan validasi identik WA-Gateway,
  idempotensi `operation_id` (reuse `outgoingOperationService`), forward
  via prefix teks, quote via `quotedStore`.
- `src/evolution/webhookRoutes.js` — receiver webhook Evolution
  (`/evolution/webhook`), termasuk filter echo kiriman sendiri, filter
  pesan non-teks (ditunda ke Tahap 4), dan penanganan `CONNECTION_UPDATE`.
- `src/evolution/heartbeat.js` — heartbeat periodik ke
  `/api/inbox/gateway/status`.
- `src/api/server.js`, `src/app/evolution.js` — server HTTP + entry point.
- `scripts/set-webhook.js` — pendaftaran webhook ke Evolution
  (`POST /webhook/set/{instance}`).
- `test/simulate-evolution-adapter.js` — 15 skenario assert-based (auth,
  validasi payload, idempotensi, forward, quote, webhook idempoten, filter
  grup/non-teks/echo, heartbeat, kebocoran log). **Semua lulus.**
- `test/simulate-evolution-boot.js` — smoke boot entry point di child
  process. **Lulus.**
- `.env.example`, `.gitignore`, `README.md`.

### Diverifikasi (bukti nyata)

- `npm test` → 15/15 skenario assert lulus + boot smoke lulus, dijalankan
  di lingkungan dev (Node v22.23.2, Windows).
- Isolasi test: `SQLITE_PATH`/`MEDIA_STORE_DIR` memakai folder temp OS,
  tidak menyentuh `data/evolution-gateway.sqlite` produksi.

### BELUM diverifikasi (lihat README untuk detail)

- Belum ada instance Evolution API nyata yang dijalankan (Docker tidak
  tersedia di mesin dev ini; akan disiapkan di PC gateway per keputusan
  user).
- Bentuk field `sendText` (`text` flat vs `textMessage.text`) — ada
  perbedaan antara satu halaman OpenAPI docs dan schema validasi resmi;
  klien memakai bentuk schema (flat), wajib dikonfirmasi ulang ke instance
  nyata.
- Bentuk payload webhook `MESSAGES_UPSERT` nyata.
- Pemetaan `connectionState` ke `logged_out`.
- Uji end-to-end teks masuk/keluar (Tahap 2), sambungan ke AuliaPos
  (Tahap 3), media/quote/forward nyata (Tahap 4).

### Tidak diubah

- **Repo `aulia-app` tidak disentuh sama sekali** (tidak ada file yang
  diubah, tidak ada `.env` produksi yang diarahkan ke adapter ini).
- Tidak ada proses adapter Fonnte (`spike/fonnte`) yang dihentikan atau
  diubah.
