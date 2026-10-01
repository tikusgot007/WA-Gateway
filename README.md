# evolution-gateway

Adapter Node.js yang menghubungkan **AuliaPos** (CodeIgniter 4, Shared WhatsApp
Inbox) ke WhatsApp lewat **Evolution API** (open-source, self-hosted), dengan
**mempertahankan kontrak HTTP** yang sudah dipakai AuliaPos sekarang (kontrak
"WA-Gateway") — sehingga **kode AuliaPos tidak perlu diubah**.

Cetak biru diambil dari spike terbukti `spike/fonnte` (repo `WA-Gateway`):
mesin durability (buffer SQLite, retry, dead-letter, idempotensi
`operation_id`, heartbeat) dipakai ulang; yang diganti hanya lapisan backend
WhatsApp (Fonnte → Evolution API).

Rencana eksekusi lengkap (termasuk keputusan desain, risiko, dan status
verifikasi) ada di `plan/2026-10-01-evolution-gateway-adapter.md` pada repo
`aulia-app`.

## Status implementasi

- ✅ **Tahap 1** (skeleton + kontrak CI4 + test assert-based) — **selesai**,
  semua test lulus (`npm test`).
- ✅ **Tahap 2** (integrasi Evolution nyata: kirim/terima teks) — **terverifikasi**
  pada Evolution API v2.3.7 (lihat "Hasil uji nyata").
- ✅ **Tahap 3** (sambung ke AuliaPos dev) — **terverifikasi**: pesan masuk
  muncul di Inbox, balasan dari Inbox terkirim, badge "Terhubung" aktif.
  **Tanpa mengubah kode AuliaPos** (`.env` dev yang ada sudah menunjuk
  `http://127.0.0.1:3000` + token yang sama).
- ✅ **Tahap 4** (media, quote, forward nyata) — **terverifikasi** lewat UI Inbox
  AuliaPos: media masuk (gambar/sticker), media keluar (gambar/dokumen/sticker),
  quote teks, quote sticker, dan forward teks. Tiga bug ditemukan & diperbaiki
  saat uji ini (lihat `docs/CHANGELOG.md`): media keluar `media_ref` kosong,
  kirim sticker gagal (`500 Invalid URL`), dan quote sticker tidak render di HP
  (field `bytes` terkirim sebagai objek JSON, bukan base64). **Grup** juga
  didukung (dua arah): `group_name` diisi dari `/group/findGroupInfos` (cache
  10 menit) dan pengirim LID dipetakan ke nomor (`src/evolution/groupInfo.js`).
- ⏳ **Tahap 5** (dokumentasi operasional final).

## Hasil uji nyata (2026-10-01)

Diuji di mesin dev yang sama dengan AuliaPos: Evolution API v2.3.7 (native,
Node), instance `WHATSAPP-BAILEYS` pada nomor uji terpisah. Uji awal memakai
MariaDB XAMPP, lalu **dipindah dan diverifikasi ulang di PostgreSQL 16**
(DB yang didukung Evolution) — lihat catatan operasional (3).

| Alur | Hasil |
|---|---|
| Kirim teks adapter → Evolution → WhatsApp (`POST /send`) | ✅ `wa_message_id` kembali |
| Kirim dari UI Inbox AuliaPos → adapter → Evolution | ✅ tercatat `operation_id` UUID dari CI4 |
| Pesan masuk WhatsApp → Evolution → webhook → adapter → CI4 Inbox | ✅ baris `direction=incoming` di tabel `messages` |
| Heartbeat → badge status ("Terhubung") | ✅ `gateway_status.status=connected, session_health=ok` |

Payload webhook `messages.upsert` asli sudah direkam dan **cocok** dengan
`src/evolution/normalize.js`:
`{ event:'messages.upsert', instance, data:{ key:{remoteJid,fromMe,id}, pushName, message:{conversation}, messageType, messageTimestamp }, ... }`.
Evolution mengisi `remoteJid` dengan JID nomor telepon (`...@s.whatsapp.net`),
bukan `@lid` (LID di-resolve via `remoteJidAlt`).

### Catatan operasional penting (dari uji nyata)

1. **Body `POST /webhook/set/{instance}` harus dibungkus**: `{ webhook: { enabled, url, events, headers?, byEvents?, base64? } }`. Field-nya `byEvents` (bukan `webhookByEvents` seperti di contoh dokumentasi). Sudah diterapkan di `client.setWebhook`.
2. **Webhook yang di-`set` setelah instance dibuat baru aktif setelah instance direstart.** Setelah `npm run webhook:set`, restart instance (`POST /instance/restart/{instance}` atau restart server Evolution) agar webhook dipakai. Ini penyebab pesan masuk pertama tidak terkirim saat uji.
3. **Gunakan PostgreSQL untuk Evolution, bukan MySQL/MariaDB.** Evolution v2.3.7 mengandung raw SQL khusus PostgreSQL (`::int`, `"key"->>'remoteJid'`, `::boolean`, `to_jsonb`) di beberapa fungsi. Di MySQL/MariaDB ini gagal (Prisma `P2010`, dan `Unknown argument 'lid'`), dan **membatalkan handler `messages.upsert` sebelum webhook dikirim** sehingga pesan masuk hilang. Setelah beralih ke **PostgreSQL 16**, seluruh alur terverifikasi (masuk, keluar, `connection.update`, `messages.update`). Jangan menambal; pakai PostgreSQL.
4. **Urutan pemasangan webhook**: `webhook/set` dulu, lalu restart instance agar webhook dimuat (lihat poin 2). Setelah restart, **tunggu instance benar-benar `open`** sebelum mengirim/menguji — mengirim saat socket masih menutup membuat Evolution menjawab `500 Connection Closed` (adapter membalas `504 SEND_UNRESOLVED`, `state: in_flight`).
5. **Filter pesan kiriman sendiri** bergantung pada `ownSentRegistry` in-memory (TTL 10 menit). Bila adapter restart tepat setelah kirim, echo webhook bisa lolos sebagai pesan `outgoing` ganda (sama seperti perilaku WA-Gateway).
6. Pesan masuk yang tiba saat uji di MariaDB (sebelum beralih ke PostgreSQL) tidak sampai ke Inbox (mis. "Apa"/"Apa 2"); setelah pindah ke PostgreSQL semua pesan normal.

## Arsitektur singkat

```
AuliaPos (CI4)  <--HTTP, Bearer token-->  evolution-gateway  <--REST, apikey-->  Evolution API
     (server POS)                         (PC gateway)                          (Docker, PC gateway)
                                                                                       |
                                                                                  WhatsApp (mode Baileys, QR)
```

- **AuliaPos → adapter**: `POST /send`, `/send-media`, `/media/download`
  (Bearer token = `inbox.gatewayToken` di `.env` AuliaPos).
- **Adapter → AuliaPos**: `POST /api/inbox/gateway/messages`,
  `/api/inbox/gateway/status` (heartbeat).
- **Evolution → adapter**: webhook `POST /evolution/webhook` (event
  `MESSAGES_UPSERT`, `CONNECTION_UPDATE`, dll — didaftarkan lewat
  `POST /webhook/set/{instance}`).
- **Adapter → Evolution**: `POST /message/sendText|sendMedia|sendSticker/{instance}`
  (header `apikey`).

## Menjalankan

```bash
npm install
cp .env.example .env
# isi CI4_BASE_URL, CI4_GATEWAY_TOKEN, EVOLUTION_BASE_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE
npm start
```

Daftarkan webhook ke Evolution (setelah instance `open`):

```bash
WEBHOOK_PUBLIC_URL=http://<ip-pc-gateway>:3000/evolution/webhook npm run webhook:set
```

## Test

```bash
npm test
```

Menjalankan dua skrip assert-based (pola sama dengan `spike/fonnte`):

- `test/simulate-evolution-adapter.js` — auth, validasi payload
  (`/send`, `/send-media`, `/media/download`), idempotensi `operation_id`,
  forward → prefix teks, quote via `quotedStore`, normalisasi webhook
  (termasuk grup tanpa `participant`, pesan non-teks, echo kiriman sendiri),
  `CONNECTION_UPDATE` → heartbeat, dan jaminan isi pesan tidak bocor ke log.
  Semua data di `SQLITE_PATH`/`MEDIA_STORE_DIR` temp — **tidak menyentuh**
  `data/evolution-gateway.sqlite` produksi.
- `test/simulate-evolution-boot.js` — smoke boot entry point
  (`src/app/evolution.js`) di child process, menangkap error `require`/path
  yang tidak terlihat oleh test router biasa.

## Kontrak CI4 yang dipertahankan (tidak berubah)

| Arah | Endpoint | Catatan |
|---|---|---|
| Gateway → CI4 | `POST {CI4_BASE_URL}/api/inbox/gateway/messages` | payload pesan masuk |
| Gateway → CI4 | `POST {CI4_BASE_URL}/api/inbox/gateway/status` | heartbeat: `status`, `phone`, `gateway_version`, `session_health` |
| CI4 → Gateway | `POST /send` | teks, opsional `quoted`/`forward`/`operation_id` |
| CI4 → Gateway | `POST /send-media` | media base64 (image/document/sticker) |
| CI4 → Gateway | `POST /media/download` | ambil media masuk (binary) |

Semua endpoint CI4→adapter memakai `Authorization: Bearer <inbox.gatewayToken>`.

## Perbedaan penting dari WA-Gateway (Baileys lokal)

1. **Sesi WhatsApp dipegang server Evolution**, bukan proses adapter ini.
   Adapter tidak punya QR/auth folder sendiri.
2. **`session_health` selalu `"ok"`.** Tidak ada tracker dekripsi Signal
   (`decryptTracker`) di jalur ini karena adapter tidak mengelola sesi
   Signal — deteksi "connected tapi diam-diam gagal dekripsi semua pesan"
   (insiden yang memicu migrasi dari Baileys) **tidak ada** di jalur Evolution.
3. **`@lid` tidak muncul** karena Evolution memetakan identitas lewat
   `key.remoteJid`/`key.participant` — tapi ini **bukan** jaminan resmi;
   mode `WHATSAPP-BAILEYS` tetap **unofficial** (risiko ban tetap ada).
4. **Media masuk disimpan lokal** (`src/evolution/mediaStore.js`), bukan
   didekripsi ulang on-demand dari server WhatsApp seperti Baileys
   (`direct_path`/`media_key_base64` asli). Lihat bagian "Media & retensi".

## Media & retensi (keputusan §6.2 rencana)

CI4 menyimpan `media.direct_path` + `media.media_key_base64` dan memanggil
`/media/download` **on-demand**, bisa tertunda. Evolution API tidak memberi
referensi Baileys (directPath+mediaKey) yang sama, dan retensi media di sisi
Evolution belum terverifikasi. **Keputusan: adapter menyimpan blob media
secara lokal** di `MEDIA_STORE_DIR`, dengan `direct_path` berupa ref opaque
`evolution-media:<id>` (`media_key_base64` diisi placeholder dan diabaikan).

- `MEDIA_RETENTION_DAYS` (bawaan 7 hari) — media yang lebih tua **dan belum
  pernah diunduh** akan terhapus oleh proses prune (belum dijadwalkan
  otomatis di Tahap 1; jalankan `mediaStore.prune()` secara berkala, atau
  jadwalkan lewat cron/scheduler OS sampai auto-prune ditambahkan).
- **Risiko**: bila kasir membuka pesan lama setelah retensi lewat, media
  tidak bisa diunduh lagi (`410 MEDIA_UNAVAILABLE`). Naikkan
  `MEDIA_RETENTION_DAYS` bila operasional butuh jendela lebih panjang.

## Balas / Quote (keputusan §6.1 rencana)

CI4 mengirim `quoted: { wa_message_id, ... }`. Evolution membutuhkan
`quoted: { key: { id, remoteJid, fromMe }, message: {...} }`. Adapter
menyimpan `key`+`message` pesan Evolution setiap kali pesan masuk
(`src/evolution/quotedStore.js`), di-key oleh `wa_message_id` yang sama yang
dilaporkan ke CI4.

- TTL `QUOTED_STORE_TTL_MS` (bawaan 7 hari). Balasan ke pesan yang lebih tua
  dari TTL, atau yang baris kutipannya tidak ditemukan, **didegradasi**
  menjadi pesan biasa (`quote_applied: false`) — bukan error, konsisten
  dengan pola degradasi di adapter Fonnte.

## Yang BELUM terverifikasi (jujur, lihat plan §7 untuk detail)

1. ~~Bentuk field `sendText`~~ — **terverifikasi**: schema resmi v2.3.7
   (`src/validate/message.schema.ts`) memakai bentuk flat `{ number, text }`;
   klien sudah benar dan terbukti mengirim nyata. (Catatan: satu halaman
   OpenAPI docs menampilkan `textMessage.text` yang berbeda — docs tidak
   akurat untuk versi ini.)
2. ~~Bentuk payload webhook `MESSAGES_UPSERT`~~ — **terverifikasi** (lihat
   "Hasil uji nyata"); `normalize.js` cocok dengan payload asli.
3. **Enum `connectionState` → `logged_out`**: `open`/`connecting`/`close`
   sudah terverifikasi lewat webhook `connection.update`. Pemetaan beda
   `logged_out` vs `close` **belum** terpicu dalam uji (tidak ada logout).
4. **Retensi media di sisi Evolution** (opsi §6.2 B, tidak dipakai) belum
   diketahui — bukan masalah karena adapter memakai opsi A (simpan lokal).
5. **Mode `WHATSAPP-BAILEYS` tetap unofficial** — risiko ban WhatsApp tetap
   ada; ini bukan solusi yang menghilangkan risiko itu (lihat riset
   `docs/riset-alternatif-baileys.md` di repo `aulia-app`).
6. `better-sqlite3` adalah native addon — perlu Node version yang cocok di
   PC gateway (build tools atau prebuilt binary yang sesuai arsitektur).

## Struktur direktori

```
src/
├─ app/evolution.js          # entry point
├─ api/
│  ├─ server.js              # mount webhook + kontrak CI4
│  └─ authMiddleware.js       # (reuse WA-Gateway) Bearer token guard
├─ config/index.js            # config.ci4 + config.evolution + durabilitas
├─ evolution/
│  ├─ client.js               # klien REST Evolution (sendText/sendMedia/sendSticker/webhook/connectionState)
│  ├─ normalize.js            # webhook Evolution -> event buffer internal
│  ├─ state.js                # status koneksi -> heartbeat
│  ├─ jid.js                  # nomor <-> JID @s.whatsapp.net
│  ├─ quotedStore.js          # simpan key+message pesan masuk utk balas
│  ├─ mediaStore.js           # simpan media masuk lokal + ref opaque
│  ├─ ownSentRegistry.js      # saring echo pesan kiriman sendiri
│  ├─ ci4Routes.js            # /send, /send-media, /media/download (kontrak CI4)
│  ├─ webhookRoutes.js        # /evolution/webhook
│  └─ heartbeat.js            # POST /api/inbox/gateway/status
├─ store/                     # (reuse) buffer SQLite + retry + dead-letter + operasi
├─ delivery/                  # (reuse) worker incoming + idempotensi keluar
├─ logging/                   # (reuse) pino + ring buffer
└─ whatsapp/                  # (reuse) mediaPayload.js, forwardMarker.js
test/
├─ simulate-evolution-adapter.js
└─ simulate-evolution-boot.js
scripts/set-webhook.js        # daftarkan webhook ke Evolution
```

## Lisensi / kepemilikan

Internal AuliaPos — tidak dipublikasikan.
