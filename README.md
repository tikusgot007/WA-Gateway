# WA Gateway (v1.0)

> **Kompatibilitas versi**: WA Gateway `v1.0` ini adalah pasangan
> yang dibutuhkan **AuliaPos `v3.0`** (module Shared WhatsApp Inbox).
> AuliaPos `v2.x` tidak membutuhkan/tidak terhubung ke Gateway ini
> sama sekali.
>
> **Catatan**: paragraf "Tujuan POC" & "POC ini TIDAK berisi" di
> bawah ini adalah deskripsi AWAL sebelum integrasi ke AuliaPos
> dikerjakan -- sudah **tidak akurat lagi** (integrasi shared inbox,
> incoming/outgoing, dan media SUDAH dikerjakan, lihat
> `docs/aturan-bisnis-CHAT.md` di sisi AuliaPos v3.0 untuk dokumentasi
> lengkap & terkini). Dibiarkan apa adanya di sini sebagai catatan
> sejarah, bukan rujukan status terkini.

Proof-of-concept WhatsApp Gateway berbasis [Baileys](https://github.com/WhiskeySockets/Baileys), berjalan di Windows, dengan Test Dashboard sederhana.

**Tujuan POC ini HANYA membuktikan**: Gateway bisa login ke WhatsApp, session persisten, menerima pesan, mengirim pesan, reconnect otomatis, dan status dapat dipantau — semuanya lewat dashboard web sederhana.

**POC ini TIDAK berisi**: shared inbox kasir, assignment chat, login kasir, database pelanggan/transaksi, integrasi AuliaPos, CRM, chatbot/AI, broadcast/bulk messaging. Fitur-fitur itu sengaja belum dibangun — akan menjadi bagian dari Server Inbox terpisah di tahap berikutnya.

---

## 1. Struktur Project

```
gateway/
├── src/
│   ├── whatsapp/
│   │   ├── connectionManager.js   # Lifecycle koneksi Baileys: connect, QR, reconnect, logout
│   │   ├── messageStore.js        # Penyimpanan pesan masuk sementara (in-memory)
│   │   └── normalize.js           # Normalisasi nomor -> JID, ekstrak nomor dari JID
│   ├── api/
│   │   ├── server.js              # Setup Express (static dashboard + API + error handler)
│   │   └── routes.js              # Semua endpoint /api/*
│   ├── config/
│   │   └── index.js               # Baca konfigurasi dari .env
│   ├── logging/
│   │   └── index.js               # Logger (pino) + ring buffer event untuk dashboard
│   └── app/
│       └── index.js               # Entry point aplikasi
├── public/                        # Test Dashboard (HTML/CSS/JS statis, tanpa build step)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── auth/                          # Session WhatsApp tersimpan di sini (dibuat otomatis, JANGAN di-commit/share)
├── .env.example
├── package.json
└── README.md
```

Catatan: folder `src/dashboard` yang disebut di brief awal digabung menjadi folder `public/` di root, karena dashboard ini adalah static file (HTML/CSS/JS) yang di-serve langsung oleh Express — tidak perlu build step tambahan untuk POC.

---

## 2. Teknologi & Dependency

| Package  | Versi   | Fungsi |
|----------|---------|--------|
| `baileys` | 6.7.24 | Library WhatsApp Web API (dipakai versi stabil terbaru, BUKAN versi `7.0.0-rc*` yang masih rilis kandidat/belum stabil) |
| `express` | ^4.19.x | HTTP API + static file server untuk dashboard |
| `qrcode`  | ^1.5.x | Konversi QR string dari Baileys menjadi gambar (data URL) untuk ditampilkan di dashboard |
| `pino`    | ^9.6.x | Logging terstruktur (dipakai juga oleh Baileys secara internal) |
| `@hapi/boom` | ^9.1.x | Untuk membaca kode error disconnect dari Baileys |
| `dotenv`  | ^16.4.x | Baca konfigurasi dari file `.env` |

Node.js minimum: **v20** (persyaratan dari `baileys`). Sudah diuji dengan Node v22.

**Keputusan teknis: kenapa Baileys 6.7.24, bukan versi terbaru?**
Saat POC ini dibuat, versi terbaru yang terpublikasi di npm adalah `7.0.0-rc14` (release candidate, belum stabil/final). Karena tujuan POC adalah pembuktian yang bisa diandalkan untuk uji coba nyata, dipilih versi stabil terakhir (`6.7.24`) agar tidak terpengaruh potensi bug dari rilis kandidat yang belum matang. Jika nanti versi 7.x sudah rilis stabil, upgrade cukup mengubah versi di `package.json` — arsitektur Gateway ini tidak bergantung pada API internal yang sifatnya sementara.

---

## 3. Cara Menjalankan di Windows

### 3.1 Prerequisite

1. Install **Node.js versi 20 LTS atau lebih baru** dari https://nodejs.org (pilih installer Windows, jalankan, next-next selesai).
2. Pastikan komputer terhubung ke **LAN toko** dan **internet** (WhatsApp Web butuh koneksi internet aktif).
3. Siapkan HP dengan WhatsApp aktif untuk proses scan QR.

Cek instalasi Node.js dengan membuka **Command Prompt** atau **PowerShell**, lalu ketik:

```
node -v
npm -v
```

Jika muncul versi Node (contoh `v20.x.x`) dan npm, instalasi berhasil.

### 3.2 Install Dependency

1. Ekstrak/salin folder `gateway` ke komputer Windows, misalnya ke `C:\wa-gateway`.
2. Buka Command Prompt/PowerShell, masuk ke folder tersebut:
   ```
   cd C:\wa-gateway
   ```
3. Install dependency:
   ```
   npm install
   ```

### 3.3 Konfigurasi Environment

1. Salin file `.env.example` menjadi `.env`:
   ```
   copy .env.example .env
   ```
2. Buka `.env` dengan text editor (Notepad cukup), sesuaikan bila perlu. Untuk mulai, nilai default sudah aman (`HOST=127.0.0.1`, hanya bisa diakses dari komputer itu sendiri).

### 3.4 Menjalankan Gateway

```
npm start
```

Jika berhasil, akan muncul log seperti:
```
Gateway starting
HTTP API + Dashboard berjalan di http://127.0.0.1:3000
```

Biarkan jendela terminal ini tetap terbuka selama Gateway digunakan. Untuk menghentikan, tekan `Ctrl + C`.

### 3.5 Membuka Dashboard

Buka browser di komputer yang sama, akses:

```
http://127.0.0.1:3000
```

---

## 4. First Login (Scan QR)

1. Jalankan Gateway (`npm start`) dan buka dashboard.
2. Karena belum pernah login, dashboard akan menampilkan **QR Code** di bagian "Connection Status" (muncul dalam beberapa detik setelah status `connecting`).
3. Di HP, buka WhatsApp → **Setelan/Settings** → **Perangkat Tertaut/Linked Devices** → **Tautkan Perangkat/Link a Device**.
4. Scan QR yang tampil di dashboard.
5. Setelah berhasil, status di dashboard akan berubah menjadi `connected` dan nomor WhatsApp yang terhubung akan ditampilkan.
6. Session tersimpan otomatis di folder `auth/`. Selama folder ini tidak dihapus dan belum logout dari HP, Gateway **tidak perlu scan QR lagi** meski aplikasi direstart.

---

## 5. Endpoint API

Semua response berbentuk JSON dengan format `{ ok: boolean, data?: ..., error?: string }`.

| Method | Endpoint | Fungsi |
|--------|----------|--------|
| GET  | `/api/status` | Status koneksi saat ini (status, nomor, waktu connect/disconnect, alasan disconnect terakhir) |
| GET  | `/api/qr` | QR code terbaru (sebagai data URL gambar), jika sedang tersedia |
| POST | `/api/pairing-code` | Alternatif login selain scan QR (lihat §15/Android) — minta pairing code untuk sebuah nomor. Body: `{ "phone": "62812xxxxxxx" }` (format internasional, tanpa `+`/spasi/0 di depan). Hanya bisa diminta SEBELUM device pernah login (belum `registered`) |
| GET  | `/api/messages?limit=50` | Daftar pesan masuk terbaru (dari memory, default 50) |
| POST | `/api/messages/send` | Kirim pesan teks. Body: `{ "to": "628xxxxxxxxxx", "text": "..." }` |
| POST | `/api/reconnect` | Memicu reconnect manual |
| POST | `/api/logout` | Logout dari WhatsApp + hapus session, sehingga QR baru diminta |
| GET  | `/api/events` | Log event terbaru (dipakai dashboard untuk panel Event/Log) — endpoint tambahan di luar daftar minimal, dibuat sesederhana mungkin untuk kebutuhan panel log realtime |
| GET  | `/api/chats` | Daftar conversation, dikelompokkan berdasarkan `chatId` (JID asli — bisa `@s.whatsapp.net` atau `@lid`). Lihat §12. |
| GET  | `/api/chats/:chatId/messages` | Pesan milik satu conversation saja. `chatId` harus di-`encodeURIComponent()` oleh client (mis. `255490491736112%40lid`). |
| POST | `/api/chats/:chatId/reply` | Balas satu conversation. `chatId` dari URL dipakai **langsung** sebagai target kirim ke Baileys — tidak pernah dikonversi ke nomor telepon. Body: `{ "text": "..." }` |
| POST | `/api/chats/:chatId/reply-media` | Balas satu conversation dengan **media** (gambar/dokumen/sticker). Body: `{ "mediaType": "image"|"document"|"sticker", "mediaBase64": "...", "mediaUrl": "...", "caption": "...", "fileName": "...", "mimetype": "...", "isAnimated": false }` — isi salah satu dari `mediaBase64` (konten file, base64) atau `mediaUrl` (Gateway mengunduh sendiri; **hanya untuk kemudahan uji manual**, lihat §5.1). `fileName` wajib untuk `mediaType: "document"`. Untuk `mediaType: "sticker"`, file **wajib WebP valid** (tidak ada konversi otomatis dari JPEG/PNG), `caption` diabaikan (WhatsApp tidak mengizinkan caption di sticker). Lihat §14/§16. |

Contoh kirim pesan dengan `curl`:

```
curl -X POST http://127.0.0.1:3000/api/messages/send ^
  -H "Content-Type: application/json" ^
  -d "{\"to\":\"628123456789\",\"text\":\"Pesan test\"}"
```

### 5.1 Endpoint machine-to-machine untuk CI4 (AuliaPos)

Endpoint di bawah ini dipasang di path **root** (bukan `/api/*`) dan **wajib**
header `Authorization: Bearer <CI4_GATEWAY_TOKEN>` (lihat `.env`). Dipakai
oleh AuliaPos CI4 (modul Shared WhatsApp Inbox), bukan oleh dashboard test.
Response berbentuk `{ success: boolean, ... }`, berbeda dari format `/api/*`.

| Method | Endpoint | Fungsi |
|--------|----------|--------|
| POST | `/send` | Kirim balasan teks dari POS. Body: `{ "chat_id": "...", "text": "..." }` |
| POST | `/send-media` | Kirim balasan **media** (gambar/dokumen/sticker) dari POS. Body: `{ "chat_id": "...", "media_type": "image"|"document"|"sticker", "media_base64": "...", "mimetype": "...", "file_name": "...", "caption": "...", "is_animated": false }`. **Hanya menerima base64** (bukan URL) — kasir upload file baru dari komputernya, jadi tidak ada referensi WhatsApp yang bisa dipakai ulang seperti `/media/download`. `file_name` wajib untuk `media_type: "document"`. Untuk `media_type: "sticker"`, file **wajib WebP valid** (ditolak `400 INVALID_STICKER_FORMAT` kalau bukan), tidak ada konversi otomatis dari format lain, dan `caption` diabaikan. Lihat §14/§16. |
| POST | `/media/download` | Ambil+dekripsi 1 file media **masuk** (gambar/dokumen/sticker) dari server WhatsApp, berdasarkan referensi (`direct_path` + `media_key_base64` + `media_type`) yang tersimpan CI4. Mengembalikan file BINARY langsung (bukan JSON) jika sukses. |

Prinsip yang sama untuk seluruh endpoint media (masuk maupun keluar): Gateway
**tidak pernah** menyimpan file media ke disk — hanya dipegang di memory
selama proses kirim/ambil, lalu dibuang.

### Peringatan Security jika API dibuka ke LAN

Secara default, `HOST=127.0.0.1` sehingga API **hanya bisa diakses dari komputer itu sendiri**. Jika diubah menjadi `HOST=0.0.0.0` agar bisa diakses dari komputer lain di LAN toko (mis. untuk keperluan pengembangan Server Inbox berikutnya):

- **API ini belum memiliki authentication apa pun.** Siapa pun yang terhubung ke jaringan LAN yang sama dapat membaca pesan masuk, mengirim pesan atas nama nomor toko, memicu reconnect, atau melakukan logout/reset session.
- Jangan pernah expose ke internet (jangan forward port ini di router/firewall).
- Untuk penggunaan lebih dari sekadar POC internal, tambahkan authentication (API key sederhana atau JWT) sebelum membuka ke LAN secara luas.

---

## 6. Dashboard

Dashboard (`http://127.0.0.1:3000`) memiliki 4 bagian:

1. **Connection Status** — status realtime (polling tiap 2 detik), nomor WhatsApp terhubung, waktu connect/disconnect terakhir, alasan disconnect terakhir, tombol **Reconnect** dan **Logout/Reset Session**. QR code otomatis tampil di sini ketika belum login.
2. **Send Test Message** — form nomor tujuan + teks pesan, tombol KIRIM. Menampilkan hasil sukses (dengan message ID) atau pesan error.
3. **Incoming Messages** — daftar pesan masuk terbaru (nama pengirim, nomor, isi pesan, waktu, message ID), diperbarui otomatis tanpa reload halaman (polling tiap 3 detik).
4. **Event / Log** — daftar event penting (startup, connecting, QR generated, connected, incoming/outgoing message, disconnect, reconnect, dst).

Dashboard menggunakan polling sederhana (bukan WebSocket) sesuai instruksi POC — cukup untuk kebutuhan pembuktian, tanpa kompleksitas tambahan.

---

## 7. Testing Checklist

| # | Test | Langkah | Kriteria Sukses |
|---|------|---------|------------------|
| 1 | First Login | Start Gateway → buka dashboard → scan QR | Status berubah menjadi `connected`, nomor WhatsApp tampil |
| 2 | Incoming Message | Kirim WhatsApp dari nomor lain ke nomor Gateway | Pesan muncul di panel "Incoming Messages" tanpa reload |
| 3 | Outgoing Message | Isi form Send Test Message → KIRIM | Pesan sampai ke WhatsApp tujuan, dashboard menampilkan message ID |
| 4 | Restart | Gateway connected → stop (`Ctrl+C`) → `npm start` lagi | Status kembali `connected` tanpa perlu scan QR ulang |
| 5 | Reconnect | Putuskan koneksi internet komputer sebentar → sambungkan lagi | Status berubah `reconnecting` lalu kembali `connected` otomatis |
| 6 | Logout | Klik tombol Logout/Reset Session di dashboard | Status `disconnected` lalu QR baru muncul kembali |
| 7 | Gateway Mati (Reconciliation) | Matikan Gateway → kirim pesan dari nomor lain → nyalakan Gateway lagi | Lihat bagian §9 "Keterbatasan" — hasil test ini **tidak bisa dijamin**, lihat penjelasan |

Jalankan checklist ini di lingkungan Windows nyata dengan koneksi internet dan nomor WhatsApp aktif, karena Test 1–7 semuanya bergantung pada koneksi nyata ke server WhatsApp.

---

## 8. Hasil Test yang Sudah Dilakukan di Lingkungan Development

Implementasi ini dikembangkan dan diverifikasi sebagian di lingkungan sandbox Linux (bukan Windows) yang **tidak memiliki akses jaringan ke server WhatsApp** (`web.whatsapp.com` dan sejenisnya diblokir oleh firewall sandbox). Berikut yang **sudah** dan **belum** bisa diverifikasi di lingkungan tersebut:

**Sudah diverifikasi (tidak butuh koneksi ke WhatsApp):**
- Aplikasi start tanpa error, HTTP server berjalan di host/port sesuai `.env`.
- Endpoint `/api/status`, `/api/qr`, `/api/messages`, `/api/events` merespons format JSON yang benar.
- Validasi input `/api/messages/send`: nomor tidak valid, teks kosong, dan teks terlalu panjang ditolak dengan pesan error yang jelas.
- Mengirim pesan ketika status belum `connected` ditolak dengan error `WhatsApp belum connected` (tidak mencoba mengirim ke Baileys).
- Folder `auth/` (session) **tidak dapat diakses lewat HTTP** (hanya folder `public/` yang di-serve sebagai static file) — dicoba akses langsung dan mengembalikan `404`.
- Graceful shutdown (`SIGTERM`/`SIGINT`) menutup socket Baileys dan HTTP server dengan bersih, log shutdown tercatat.
- Proses fetch versi WhatsApp Web terbaru (`fetchLatestBaileysVersion`) berhasil dijalankan tanpa error.
- Dashboard (HTML/CSS/JS) ter-load dan bisa memanggil semua endpoint di atas.

**BELUM bisa diverifikasi di lingkungan development** (butuh koneksi nyata ke WhatsApp + nomor HP aktif untuk scan QR), **harus diuji ulang di Windows oleh Anda sebelum dianggap "lulus POC"**:
- Test 1 (First Login / scan QR sungguhan)
- Test 2 (Incoming Message sungguhan)
- Test 3 (Outgoing Message sungguhan ke nomor tujuan asli)
- Test 4 (Restart + validasi session tetap valid dari sisi WhatsApp)
- Test 5 (Reconnect sungguhan setelah internet terputus)
- Test 6 (Logout sungguhan dari sisi WhatsApp)
- Test 7 (Reconciliation pesan saat Gateway mati)

Silakan jalankan checklist di §7 langsung di Windows dengan nomor WhatsApp uji coba, dan laporkan hasilnya — kode ini siap diuji tetapi **klaim "berhasil" untuk ketujuh test di atas belum bisa saya buktikan sendiri** karena keterbatasan jaringan di lingkungan tempat saya membangun POC ini.

---

## 9. Keterbatasan POC

1. **Reconciliation pesan saat Gateway mati (Test 7) tidak dapat dijamin.** Baileys/WhatsApp Web multi-device pada dasarnya adalah *client* yang menerima pesan secara real-time melalui koneksi socket yang aktif. Ketika Gateway (dan socket-nya) mati, tidak ada mekanisme resmi dan terdokumentasi di Baileys untuk "menarik ulang" seluruh pesan yang terlewat dari server WhatsApp persis seperti membaca inbox email. Yang mungkin terjadi (tergantung durasi mati dan perilaku WhatsApp multi-device saat ini):
   - Sebagian pesan bisa muncul kembali sesaat setelah reconnect jika WhatsApp mengirim ulang event yang belum di-ack, **atau**
   - Pesan tersebut tetap tersimpan di riwayat chat HP utama (karena WhatsApp multi-device menyinkronkan dari HP), tetapi tidak otomatis "didorong ulang" sebagai event baru ke Gateway.
   - Ini harus diuji langsung (Test 7) dan hasilnya harus didokumentasikan apa adanya — **jangan mengasumsikan pesan yang terlewat pasti bisa diambil ulang**. Jika toko butuh jaminan tidak ada pesan yang hilang, Gateway idealnya dijalankan tanpa henti selama jam operasional, bukan mengandalkan reconciliation setelah mati.
2. **Pesan hanya disimpan di memory**, akan hilang setiap Gateway direstart. Ini sesuai instruksi POC (tidak perlu database bisnis).
3. **Mendukung teks, gambar, dan dokumen** untuk pesan masuk maupun keluar (lihat §14). Jenis media lain (audio, video, sticker, lokasi, kontak) belum ditangani — dilewati & di-log debug saat masuk, dan tidak bisa dikirim keluar (di luar scope POC).
4. **API belum memiliki authentication.** Aman selama `HOST=127.0.0.1` (default). Jika dibuka ke LAN, lihat peringatan security di §5.
5. **Bukan Windows Service.** Untuk POC, Gateway dijalankan manual dari terminal. Struktur kode (pemisahan `config`, `logging`, `whatsapp`, `api`, `app`) sudah dirancang agar mudah dibungkus menjadi Windows Service/autostart nantinya (mis. dengan `node-windows` atau `pm2-windows-service`), tapi itu belum diimplementasikan di POC ini.
6. **Satu nomor WhatsApp per Gateway.** POC ini tidak mendukung multi-akun WhatsApp dalam satu instance.
7. **Belum diuji di Windows sungguhan** oleh proses otomatis ini — lihat §8. Kode sudah diverifikasi berjalan tanpa error di Node.js v20+ di Linux; perilaku Windows (path folder, `npm install`, dsb.) mengikuti konvensi Node.js standar yang sama di kedua OS, tetapi tetap perlu dikonfirmasi langsung.

---

## 10. Logout / Reset Session (untuk kebutuhan testing)

Dua cara:

- **Dari dashboard**: klik tombol "Logout / Reset Session" di panel Connection Status.
- **Manual via API**: `POST /api/logout`
- **Manual via filesystem** (jika Gateway sedang tidak berjalan): hentikan aplikasi, hapus folder `auth/` secara manual, lalu jalankan `npm start` lagi — QR baru akan diminta.

---

## 11. Troubleshooting Umum

| Gejala | Kemungkinan Penyebab | Solusi |
|--------|----------------------|--------|
| QR tidak muncul-muncul | Tidak ada koneksi internet, atau firewall Windows/antivirus memblokir koneksi keluar Node.js | Pastikan internet aktif; izinkan Node.js pada firewall/antivirus |
| Status stuck di `connecting` | Koneksi ke server WhatsApp lambat/terblokir | Tunggu beberapa saat; jika lebih dari 1-2 menit, klik Reconnect atau restart Gateway |
| Setelah restart, diminta scan QR lagi padahal sebelumnya sudah login | Folder `auth/` terhapus/berpindah, atau sudah logout dari HP (Linked Devices) | Cek folder `auth/` ada dan tidak kosong; cek di HP apakah device masih tertaut |
| Status `logged_out` terus, tidak auto-reconnect | Ini disengaja — setelah logout dari sisi WhatsApp, Gateway tidak auto-reconnect agar tidak loop error. Perlu reset session | Klik "Logout / Reset Session" di dashboard, lalu scan QR baru |
| Error `EADDRINUSE` saat start | Port 3000 sudah dipakai aplikasi lain | Ubah `PORT` di `.env`, atau hentikan aplikasi lain yang memakai port tersebut |
| Pesan keluar gagal terkirim | WhatsApp belum `connected`, atau nomor tujuan format salah | Cek status di dashboard; pastikan nomor tujuan format `628xxxxxxxxxx` |
| Dashboard tidak bisa dibuka dari komputer lain di LAN | `HOST` masih `127.0.0.1` (default, sengaja hanya localhost) | Ubah `HOST=0.0.0.0` di `.env` — **baca peringatan security di §5 dulu** |
| `npm install` gagal di Windows karena native build tool | Beberapa dependency transititif kadang butuh build tools | Install "Visual Studio Build Tools" (opsional) atau gunakan Node.js versi LTS terbaru yang biasanya sudah menyediakan prebuilt binary |

---

## 12. Validasi Identitas Chat (`@lid`) — Update

Tahap ini menambahkan validasi bahwa chat dengan `remoteJid` berformat `xxx@lid` (LID/Linked Identity — lihat penjelasan di bawah) tetap dapat diperlakukan sebagai satu conversation yang konsisten, **tanpa pernah memaksa angka LID menjadi nomor telepon**.

### 12.1 File yang diubah/ditambahkan

| File | Perubahan |
|------|-----------|
| `src/whatsapp/jidUtils.js` (baru) | Wrapper tipis di atas util resmi Baileys (`isJidUser`, `isLidUser`, `isJidGroup`, `jidDecode`) untuk klasifikasi JID (`pn`/`lid`/`group`/`unknown`) dan ekstraksi nomor telepon **hanya** jika JID memang `@s.whatsapp.net`. |
| `src/whatsapp/messageStore.js` | Ditambahkan `getByChatId(chatId)` (filter exact-match berdasarkan chatId) dan `listConversations()` (kelompokkan pesan jadi daftar chat). Tidak menghapus method lama. |
| `src/whatsapp/connectionManager.js` | `_handleIncomingMessage` sekarang menghitung `jidType` dan **tidak lagi** mengisi `sender.phone` dari angka LID (dulu bug ini yang menyebabkan `255490491736112@lid` tampil seperti nomor Tanzania). Ditambahkan method baru `sendReply(chatId, text)` yang mengirim **langsung** ke `chatId` apa adanya (tanpa normalisasi), plus log diagnostik `[CHAT]`/`[SEND]`. |
| `src/api/routes.js` | Endpoint baru: `GET /api/chats`, `GET /api/chats/:chatId/messages`, `POST /api/chats/:chatId/reply`. Endpoint lama (`/api/messages`, `/api/messages/send`, dll) **tidak diubah/dihapus**. |
| `public/index.html`, `public/app.js`, `public/style.css` | Panel dashboard baru "Conversations": daftar chat, tampilan per-conversation, tombol "Balas". Panel lama tetap ada. |
| `test/simulate-lid-conversation.js` (baru) | Skrip simulasi in-process (bukan test end-to-end nyata) untuk validasi logika klasifikasi JID, isolasi antar-chat, dan penolakan `sendReply` pada input tidak valid. |

### 12.2 Bagaimana identity conversation ditentukan

`chatId` = `remoteJid` **asli** dari event Baileys, disimpan string-for-string tanpa modifikasi. Dua pesan dianggap satu conversation jika dan hanya jika `chatId`-nya identik secara exact-string-match. Tidak ada normalisasi, tidak ada mapping LID→nomor telepon di jalur ini.

`jidType` (`pn` / `lid` / `group` / `unknown`) dihitung dari akhiran domain JID (`@s.whatsapp.net`, `@lid`, `@g.us`) menggunakan fungsi resmi Baileys (`isJidUser`, `isLidUser`, `isJidGroup`) — bukan implementasi tebak-tebakan sendiri.

### 12.3 Bagaimana mekanisme reply menentukan target

`POST /api/chats/:chatId/reply` mengambil `chatId` langsung dari URL (JID asli conversation yang sedang dibuka di dashboard) dan meneruskannya **tanpa perubahan** ke `connectionManager.sendReply(chatId, text)`, yang pada akhirnya memanggil `sock.sendMessage(chatId, { text })` milik Baileys. Tidak ada pemanggilan `normalizeToJid()` atau `jidToPhone()` di jalur pengiriman ini. Endpoint lama `/api/messages/send` (untuk kirim ke nomor telepon bebas) tetap memakai `normalizeToJid()` seperti sebelumnya — jalur ini sengaja dipisah dan tidak digabung.

### 12.4 Apakah `@lid` berhasil dibalas secara teknis?

**Ditemukan dukungan resmi di Baileys 6.7.24**: pada `node_modules/baileys/lib/Socket/messages-send.js`, fungsi `relayMessage` memiliki cabang eksplisit `const isLid = server === 'lid'` dan membentuk `destinationJid` dengan mempertahankan server `lid` apa adanya — ini bukan side-effect, melainkan jalur resmi yang memang disediakan Baileys untuk mengirim ke JID ber-server `lid`. `sock.sendMessage(lidJid, { text })` karena itu adalah mekanisme resmi, bukan workaround buatan sendiri.

**Namun** — ini penting — dukungan di level kode Baileys hanya membuktikan bahwa *jalur pengirimannya ada dan valid secara desain*. Apakah pesan **benar-benar sampai** ke pelanggan saat dikirim ke `@lid` sungguhan, itu baru bisa dibuktikan lewat **TEST B** dengan koneksi WhatsApp nyata (lihat §12.6) — dan itu **belum bisa saya lakukan sendiri** karena lingkungan tempat saya membangun ini tidak punya akses jaringan ke server WhatsApp (lihat §8 dokumen sebelumnya). Silakan jalankan TEST B di Windows dan laporkan hasilnya.

### 12.5 Yang sudah diverifikasi lewat simulasi (`node test/simulate-lid-conversation.js`)

Simulasi ini menjalankan kode asli `connectionManager._handleIncomingMessage`, `messageStore`, dan `jidUtils` secara in-process (tanpa socket WhatsApp sungguhan) dengan payload event palsu yang meniru struktur asli Baileys. Hasilnya — **semua PASS**:

1. `classifyJid` mengklasifikasikan `@s.whatsapp.net` → `pn`, `@lid` → `lid`, `@g.us` → `group`, string sembarang → `unknown`.
2. `extractPhoneIfAvailable('255490491736112@lid')` mengembalikan `null` (bukan `255490491736112`) — bug yang Anda temukan sebelumnya sudah tidak terjadi lagi.
3. Simulasi 1 pesan PN + 2 pesan dari LID yang sama + 1 pesan dari LID lain → menghasilkan **3 conversation terpisah** yang benar (bukan 4 pesan tercampur jadi satu, bukan juga PN dan LID pertama tertukar).
4. `getByChatId()` untuk dua LID berbeda (`A` dan `B`) mengembalikan pesan yang benar-benar terpisah — tidak ada kebocoran pesan A ke B atau sebaliknya (memvalidasi logika TEST C).
5. Conversation dengan `phone: null` (kasus LID tanpa mapping nomor) tetap bisa dibaca dan berisi pesan (memvalidasi logika TEST D).
6. `isDecodableJid()` menolak string yang bukan JID valid.
7. `sendReply()` menolak dengan `NOT_CONNECTED` saat belum ada koneksi WhatsApp aktif, dan menolak dengan `INVALID_CHAT_ID` saat `chatId` tidak valid — **sebelum** sempat mencoba mengirim apa pun.

Endpoint HTTP baru juga sudah dicoba langsung dengan `curl` terhadap server yang benar-benar berjalan (`GET /api/chats`, `GET /api/chats/:chatId/messages`, `POST /api/chats/:chatId/reply`) dan merespons sesuai desain.

### 12.6 TEST A/B/C/D — status: BELUM DIJALANKAN dengan koneksi WhatsApp nyata

Sama seperti pada tahap POC sebelumnya, lingkungan development saya **tidak memiliki akses jaringan ke server WhatsApp**, sehingga saya tidak bisa membuktikan sendiri bahwa pesan benar-benar terkirim/diterima oleh HP asli. Yang bisa saya laporkan hanya hasil simulasi logika di atas (§12.5), bukan pengiriman nyata. Status keempat test wajib:

| Test | Status | Catatan |
|------|--------|---------|
| TEST A — PN | **Belum dijalankan dengan WhatsApp nyata** | Logika penyimpanan & isolasi sudah diverifikasi lewat simulasi; pengiriman/penerimaan nyata perlu diuji di Windows. |
| TEST B — LID | **Belum dijalankan dengan WhatsApp nyata** | Dukungan resmi di Baileys sudah dikonfirmasi dari source code (§12.4); apakah benar-benar sampai ke HP pelanggan **wajib** diuji langsung. |
| TEST C — Isolasi Chat | **Logika PASS lewat simulasi**, belum lewat WhatsApp nyata | Lihat §12.5 poin 4. |
| TEST D — No Phone | **Logika PASS lewat simulasi**, belum lewat WhatsApp nyata | Lihat §12.5 poin 5. |

**Mohon jalankan keempat test ini di Windows** dengan minimal 2 nomor/akun WhatsApp berbeda (satu di antaranya idealnya akun yang memang bermigrasi ke `@lid` — lihat catatan di §12.7 soal cara memicu kondisi ini), lalu amati:
- Apakah field `chatId` yang tersimpan benar-benar `xxx@lid` (cek lewat `GET /api/chats`).
- Apakah setelah klik "Balas", pelanggan benar-benar menerima pesan di HP-nya.
- Apakah balasan pelanggan berikutnya masuk ke conversation yang sama (bukan bikin entry baru di `GET /api/chats`).

Jika ada langkah yang gagal, laporkan **pesan error asli** dari panel "Event / Log" di dashboard (atau `logs/gateway.log`) — jangan hanya "gagal", karena error asli dari Baileys/WhatsApp akan menentukan apakah ini keterbatasan protokol atau bug di kode.

### 12.7 Catatan tentang kapan `@lid` muncul

`@lid` bukan sesuatu yang bisa dipicu manual dari sisi Gateway — itu keputusan WhatsApp per-akun/per-kontak sebagai bagian dari migrasi bertahap ke sistem "Linked Identity" untuk privasi (nomor telepon disembunyikan dari pihak lain). Berdasarkan riset komunitas Baileys (banyak dilaporkan di [issue tracker resminya](https://github.com/WhiskeySockets/Baileys/issues/1718)), migrasi ini berjalan bertahap dan tidak seragam — sebagian kontak Anda mungkin sudah `@lid`, sebagian masih `@s.whatsapp.net`. Untuk TEST B, gunakan nomor pelanggan yang saat ini memang muncul sebagai `@lid` di dashboard (seperti pada screenshot yang Anda kirim sebelumnya) — jangan mencoba memaksa/mensimulasikan LID secara manual.

### 12.8 Yang masih perlu divalidasi sebelum jadi backend shared inbox

1. **Pemetaan LID ↔ riwayat chat lama.** Jika toko sudah punya riwayat percakapan dengan pelanggan sebelum migrasi ke LID, WhatsApp/Baileys **tidak menjamin** bisa menyambungkan riwayat lama (`@s.whatsapp.net`) dengan identitas baru (`@lid`) milik kontak yang sama — ini dikonfirmasi sebagai keterbatasan terbuka di Baileys ([issue #2551](https://github.com/WhiskeySockets/Baileys/discussions/2551)), bukan sesuatu yang bisa diperbaiki dari sisi Gateway ini.
2. **Konsistensi `@lid` vs `@s.whatsapp.net` untuk satu kontak yang sama** dari sisi Gateway vs sisi HP utama pemilik akun — pernah dilaporkan Baileys menerima pesan masuk sebagai `@lid` tapi pesan keluar dari HP (device lain yang tertaut) tercatat sebagai `@s.whatsapp.net` untuk kontak yang identik ([issue #1832](https://github.com/WhiskeySockets/Baileys/issues/1832)). Ini berarti *dua chatId berbeda* bisa merujuk ke *satu pelanggan yang sama* — sebelum dipakai sebagai backend shared inbox sungguhan, ini perlu ditelusuri lebih jauh apakah terjadi juga di akun toko Anda.
3. **Grup (`@g.us`)** belum diuji sama sekali di tahap ini (fokus POC ini sengaja hanya PN vs LID untuk chat personal).
4. **Volume/skala**: `messageStore` masih in-memory tanpa batas per-chat (hanya batas total pesan lewat `MAX_MESSAGES_IN_MEMORY`) — untuk shared inbox sungguhan, dengan banyak conversation aktif sekaligus, pesan lama di satu chat bisa "terdesak keluar" oleh pesan baru di chat lain. Ini perlu didesain ulang (bukan sekadar dinaikkan angkanya) sebelum production.
5. Semua keterbatasan yang sudah didokumentasikan di §9 — reconciliation pesan saat Gateway mati, tanpa authentication pada endpoint `/api/*`, satu nomor per Gateway, dll — masih berlaku dan belum berubah.

---

## 13. Yang Sengaja TIDAK Dibangun di POC Ini

Sesuai batasan scope yang diminta, POC ini **tidak** memiliki: shared inbox kasir, sistem assignment/"ambil chat", user/login kasir, database pelanggan, integrasi AuliaPos, database transaksi, CRM, chatbot/AI chatbot, broadcast/bulk messaging, atau fitur marketing. Semua itu berada di luar scope dan akan menjadi bagian dari Server Inbox terpisah pada tahap berikutnya, setelah POC Gateway ini terbukti berjalan baik.

---

## 14. Kirim Media (Gambar/Dokumen) Keluar

Sebelumnya, arah **keluar** (kasir/POS kirim gambar/dokumen) belum dibangun —
hanya arah masuk (customer kirim gambar/dokumen ke toko) yang sudah didukung.
Bagian ini menutup gap tersebut: kasir/POS sekarang juga bisa **mengirim**
gambar/dokumen, bukan cuma menerima.

### 14.1 Keputusan desain

- **Konsisten dengan prinsip media masuk**: Gateway **tidak pernah** menyimpan
  file media ke disk untuk arah manapun. Untuk media keluar, `buffer` file
  hanya dipegang di memory selama proses kirim ke Baileys (`sock.sendMessage()`),
  lalu dibuang begitu request selesai.
- **Sumber file berbeda dari media masuk**: media masuk cukup disimpan sebagai
  *referensi* WhatsApp (`direct_path` + `media_key`) karena filenya memang
  sudah ada di server WhatsApp. Media keluar **tidak punya referensi seperti
  itu** — ini file baru yang diupload kasir dari komputernya sendiri — jadi
  Gateway harus menerima **konten filenya langsung**, bukan referensi.
- **Endpoint CI4 (`POST /send-media`) hanya menerima base64**, bukan URL.
  CI4 sudah punya bytes file (dari upload kasir) di memory PHP-nya sendiri,
  jadi tidak ada alasan Gateway perlu mempercayai/mengambil URL sembarangan
  dari sistem lain. Endpoint dashboard test (`POST /api/chats/:chatId/reply-media`)
  juga menerima `mediaUrl` sebagai tambahan — **khusus untuk kemudahan uji
  manual** (tinggal tempel link gambar tanpa perlu encode base64 manual),
  bukan pola yang dipakai integrasi CI4.
- **Jenis media yang didukung**: `image` dan `document`, sama seperti media
  masuk. Jenis lain (audio/video/lokasi/kontak) di luar scope. (Update:
  `sticker` ditambahkan belakangan, lihat §16.)
- **Ukuran maksimum**: dikontrol lewat env `MAX_MEDIA_UPLOAD_MB` (default
  20MB). Body request JSON untuk endpoint media memakai body-parser dengan
  limit lebih besar dari endpoint lain (dihitung otomatis dari
  `MAX_MEDIA_UPLOAD_MB`, memperhitungkan overhead ~33% dari encoding base64)
  — endpoint teks biasa (`/send`, `/api/messages/send`, dst) tetap memakai
  limit kecil (256kb) seperti sebelumnya, tidak ikut diperbesar.

### 14.2 File yang diubah/ditambahkan

| File | Perubahan |
|------|-----------|
| `src/whatsapp/mediaPayload.js` | **Baru.** `decodeBase64Media()` (validasi format + batas ukuran SEBELUM alokasi buffer penuh) dan `fetchMediaFromUrl()` (khusus dashboard test, dengan batas ukuran & timeout). |
| `src/whatsapp/connectionManager.js` | Method baru `sendMediaMessage(jid, mediaType, buffer, options)` (versi media dari `sendTextMessage()`) dan `sendMediaReply(chatId, mediaType, buffer, options)` (versi media dari `sendReply()`, termasuk catat ke `messageStore` tanpa menyimpan file-nya). |
| `src/api/routes.js` | Endpoint baru `POST /api/chats/:chatId/reply-media` (tanpa auth, untuk dashboard test). Body-parser JSON kini dipasang per-route (`jsonSmall`/`jsonMedia`), bukan lagi satu parser global. |
| `src/api/ci4Routes.js` | Endpoint baru `POST /send-media` (Bearer token, sama seperti `/send`). |
| `src/api/server.js` | Body-parser JSON global dihapus (dipindah ke masing-masing router agar limit ukuran bisa berbeda per endpoint) + error handler kini membalas `413` yang benar untuk body yang kelewat besar (sebelumnya selalu dibalas sebagai `500` generik). |
| `src/config/index.js` | `maxMediaUploadBytes`, `mediaFetchTimeoutMs`, `mediaJsonBodyLimitBytes` (env baru: `MAX_MEDIA_UPLOAD_MB`, `MEDIA_FETCH_TIMEOUT_MS`). |
| `public/index.html`, `public/app.js`, `public/style.css` | Form "Balas dengan media" di panel Conversations — pilih gambar/dokumen, pilih file dari komputer (dibaca sebagai base64 di browser), caption opsional. Daftar pesan juga menampilkan label `[gambar]`/`[dokumen]` untuk pesan bertipe media. |
| `test/simulate-send-media.js` | **Baru.** Simulasi logika (bukan pengiriman nyata): validasi `decodeBase64Media` (base64 tidak valid, batas ukuran), penolakan `sendMediaReply` saat `chatId` tidak valid/belum connected, penolakan `sendMediaMessage` untuk `mediaType` yang tidak dikenal. |

### 14.3 Yang sudah diverifikasi sendiri

- `node --check` pada seluruh file yang diubah/ditambahkan — tidak ada syntax error.
- `node test/simulate-send-media.js` dan `node test/simulate-lid-conversation.js` — sama-sama lulus, fitur baru tidak merusak logika `@lid` yang sudah ada sebelumnya.
- Server benar-benar dijalankan (`startServer()`) dan diuji dengan `curl` sungguhan (bukan cuma dibaca kodenya):
  - `POST /send-media` tanpa token → `401`.
  - `POST /send-media` dengan `media_type` tidak dikenal → `400 INVALID_MEDIA_TYPE`.
  - `POST /send-media` dengan `media_type: "document"` tanpa `file_name` → `400 MISSING_FILE_NAME`.
  - `POST /send-media` valid tapi belum connected ke WhatsApp → `409 NOT_CONNECTED`.
  - `POST /api/chats/:chatId/reply-media` tanpa `mediaType` → `400`.
  - Body `> 256kb` ke `/send` (endpoint teks) → `413` (bukan lagi `500`).
  - Body media ~25MB (raw, jadi ~33MB setelah base64) ke `/send-media`, di atas limit `MAX_MEDIA_UPLOAD_MB=20` default → `413`.
  - Body media 5MB (raw, ~6.7MB setelah base64), di bawah limit → **lolos** body-parser, lanjut ke validasi bisnis (`409 NOT_CONNECTED`, sesuai ekspektasi karena tidak ada koneksi WhatsApp nyata di sandbox ini).
- Signature `image`/`document` di `AnyMediaMessageContent` dicek langsung dari `node_modules/baileys/lib/Types/Message.d.ts` yang ter-install (bukan ditebak dari memori), untuk memastikan `Buffer` memang diterima langsung sebagai `WAMediaUpload` dan field mana yang wajib (`document.mimetype`) vs opsional.

### 14.4 Yang PERLU kamu jalankan/verifikasi sendiri

1. **Kirim gambar sungguhan** lewat dashboard (`Balas dengan media` di panel Conversations) ke nomor HP asli, pastikan benar-benar muncul sebagai gambar (bukan dokumen/corrupt) di WhatsApp penerima.
2. **Kirim dokumen sungguhan** (PDF misalnya), pastikan nama file & isinya benar saat dibuka penerima.
3. **Kirim dari sisi CI4** lewat `POST /send-media` — endpoint ini sudah dibangun di sisi Gateway, tapi **sisi CI4 (AuliaPos v3.0) belum punya UI upload/panggilan ke endpoint ini** (lihat `docs/aturan-bisnis-CHAT.md` §7.8 di repo AuliaPos — outgoing media memang ditandai "belum dikerjakan" di sana). Pembuatan UI upload di POS + pemanggilan `POST /send-media` dari CI4 adalah pekerjaan **terpisah** di sisi AuliaPos, di luar scope perubahan Gateway ini.
4. **Uji file besar mendekati/di atas `MAX_MEDIA_UPLOAD_MB`** dari dashboard sungguhan (bukan cuma `curl`), pastikan pesan error di UI cukup jelas untuk kasir (bukan cuma `413` mentah).
5. Tidak bisa saya test di sandbox ini: pengiriman **sungguhan** ke server WhatsApp (perlu koneksi Baileys nyata + akun WhatsApp aktif, tidak tersedia di environment saya).

---

## 15. Versi Android (Gateway jalan langsung di HP)

Selain versi desktop (Windows) di atas, tersedia juga versi **Android**
yang menjalankan Gateway ini langsung di HP (embed Node.js via
[nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile)) --
tanpa PC/server terpisah, cocok untuk kasus HP yang sama juga memegang
nomor WhatsApp toko. Login pakai **pairing code** (lihat endpoint baru
`POST /api/pairing-code` di bagian 5) sebagai alternatif scan QR untuk
skenario itu.

Source code, cara build (APK), dan seluruh keterbatasan/risikonya ada di
**[`android/README.md`](android/README.md)** -- termasuk catatan penting
bahwa proyek Android ini belum di-build/dijalankan sungguhan di Android
Studio oleh sesi yang menulisnya (sandbox pengembangannya tidak punya
Android SDK/NDK), jadi anggap sebagai starting point yang solid, bukan
produk jadi siap pakai.

---

## 16. Dukungan Sticker (Kirim & Terima)

Menambahkan sticker sebagai jenis media ketiga (setelah image/document),
memakai **pola yang PERSIS sama** dengan image/document di §14 -- bukan
pola baru. Baik masuk maupun keluar direview & diverifikasi langsung dari
source code Baileys yang ter-install (`node_modules/baileys`), bukan
ditebak dari dokumentasi/memori.

### 16.1 Keputusan desain

- **REUSE, bukan duplikasi**: `buildMediaRef()` di `connectionManager.js`
  (ekstraksi `directPath`/`mediaKey`/`mimetype`/`fileLength`/`fileSha256`)
  dipakai APA ADANYA untuk sticker, tanpa perubahan signature/logic --
  fungsi ini sudah generik sejak awal untuk image/document, terbukti
  langsung cocok untuk sticker karena proto `IStickerMessage` di Baileys
  punya field yang identik (diverifikasi dari `WAProto/index.d.ts`).
- **Sticker masuk mengikuti prinsip image/document** (BUKAN audio/video):
  kalau `directPath`/`mediaKey` tidak lengkap, pesan **dibuang** (tidak
  diteruskan ke CI4) -- beda dari audio/video yang tetap diteruskan
  walau metadata kosong, karena binary audio/video memang tidak pernah
  diambil sama sekali.
- **Tidak ada caption untuk sticker**: diverifikasi dari proto Baileys
  (`IStickerMessage` masuk, dan variant `sticker` di `AnyMediaMessageContent`
  keluar) -- keduanya memang tidak punya field caption sama sekali. Ini
  konsisten dengan perilaku asli WhatsApp (app resmi juga tidak
  menyediakan UI kirim sticker dengan caption).
- **Kontrak field ke CI4 identik dengan image/document**: object `media`
  yang dikirim ke `POST /api/inbox/gateway/messages` untuk
  `message_type: "sticker"` punya field **PERSIS SAMA** (nama & bentuk)
  dengan image/document (`direct_path`, `media_key_base64`, `mimetype`,
  `file_length`, `file_sha256_base64`, `file_name`) -- **TIDAK ada**
  field tambahan seperti `is_animated` yang ikut terbawa ke payload ini,
  supaya sisi AuliaPos bisa memproses sticker lewat cabang kode yang
  sama persis dengan image/document, tanpa field asing yang tidak
  dikenal. Flag `isAnimated` dari proto Baileys dibaca (memastikan tidak
  crash), tapi sengaja tidak diteruskan ke payload CI4.
- **`downloadContentFromMessage(ref, 'sticker')`**: diverifikasi langsung
  dari `node_modules/baileys/lib/Defaults/index.js`
  (`MEDIA_HKDF_KEY_MAPPING`) bahwa `'sticker'` adalah `MediaType` yang
  valid (di-mapping ke kunci HKDF `'Image'`) -- endpoint
  `POST /media/download` yang sudah ada otomatis bisa dipakai ulang,
  cukup dengan mengirim `media_type: "sticker"` di body (validasi daftar
  tipe di endpoint ini sebelumnya **hardcoded** `['image', 'document']`,
  bukan pakai `VALID_MEDIA_TYPES` -- celah kecil yang ditemukan &
  diperbaiki sekalian saat menambahkan sticker).
- **Sticker keluar TIDAK dikonversi otomatis dari format lain** (JPEG/PNG/dst)
  -- tidak ada dependency baru ditambahkan untuk ini. `sharp` yang
  muncul di `node_modules/` HANYALAH *optional peer dependency* milik
  `baileys` sendiri (`peerDependencies.sharp` di
  `node_modules/baileys/package.json`, untuk kebutuhan internal Baileys),
  **bukan** dependency project ini -- menambahkannya sebagai dependency
  langsung untuk konversi sticker akan mengulang masalah yang sama
  seperti `better-sqlite3` untuk build Android (native addon, lihat
  `android/README.md`). Sebagai gantinya, `isValidWebp()` (baru, di
  `mediaPayload.js`) memvalidasi **magic bytes** container WebP
  (`RIFF....WEBP`) sebelum diteruskan ke Baileys -- validasi minimal,
  bukan validasi struktur WebP penuh (dimensi/VP8 chunk/dst), cukup
  untuk menyaring kesalahan paling umum (kasir lupa konversi, upload
  JPEG/PNG mentah sebagai "sticker").
- **`is_animated`** (opsional, boolean) bisa dikirim di `POST /send-media`/
  `POST /api/chats/:chatId/reply-media` untuk sticker animasi -- diteruskan
  ke Baileys sebagai `isAnimated` saat upload (`sock.sendMessage(jid,
  { sticker, isAnimated })`), TIDAK muncul di `media_ref` response
  (kontrak response tetap identik image/document: `direct_path` +
  `media_key_base64` saja).

### 16.2 File yang diubah/ditambahkan

| File | Perubahan |
|------|-----------|
| `src/whatsapp/connectionManager.js` | Cabang baru `stickerMessage` di `_handleIncomingMessage()` (reuse `buildMediaRef()`). `sendMediaMessage()`/`sendMediaReply()` menerima `mediaType: 'sticker'` + opsi `isAnimated`. Docblock `buildMediaRef()`/`downloadMediaByRef()` diupdate menyebut sticker. |
| `src/whatsapp/mediaPayload.js` | `VALID_MEDIA_TYPES` bertambah `'sticker'`. Fungsi baru `isValidWebp()` (validasi magic bytes, TANPA dependency baru). |
| `src/api/ci4Routes.js` | `POST /send-media` menerima `media_type: "sticker"` + `is_animated` opsional, ditolak `400 INVALID_STICKER_FORMAT` kalau bukan WebP valid. `POST /media/download` diperbaiki memakai `VALID_MEDIA_TYPES` (sebelumnya hardcoded `['image','document']`, tidak otomatis dapat sticker). |
| `src/api/routes.js` | `POST /api/chats/:chatId/reply-media` (dashboard test) menerima `mediaType: "sticker"` + `isAnimated`, validasi WebP sama seperti `/send-media`. |
| `test/simulate-sticker.js` | **Baru.** Simulasi logika: sticker referensi lengkap diteruskan, referensi tidak lengkap dibuang, sticker animasi diproses identik dengan statis (tidak ada percabangan), idempotency `wa_message_id`, `isValidWebp()` menerima/menolak buffer, kirim sticker keluar (mock `sock.sendMessage()`) menghasilkan `media_ref` benar, regresi penolakan `mediaType` tidak dikenal. |
| `test/simulate-send-media.js` | Assertion `VALID_MEDIA_TYPES` diupdate menyertakan `'sticker'`. |

### 16.3 Yang sudah diverifikasi sendiri

- `node --check` pada seluruh file yang diubah/ditambahkan -- tidak ada syntax error.
- `node test/simulate-sticker.js` -- 8 skenario lulus (lihat §16.2), TERMASUK memverifikasi bahwa object `media` yang dikirim ke CI4 (`Object.keys(...)`) identik persis bentuknya dengan image/document, dan identik antara sticker statis vs animasi.
- Seluruh test simulasi LAIN yang sudah ada (`simulate-lid-conversation.js`, `simulate-identity-hint.js`, `simulate-audio-video.js`, `simulate-send-media.js`) dijalankan ulang -- semua tetap lulus, tidak ada regresi ke image/document/audio/video/@lid.
- Server benar-benar dijalankan (`startServer()`) dan diuji dengan `curl` sungguhan:
  - `POST /send-media` dengan `media_type: "sticker"` + base64 BUKAN WebP → `400 INVALID_STICKER_FORMAT` (ditolak SEBELUM cek koneksi, sama seperti validasi `file_name` untuk document).
  - `POST /send-media` dengan `media_type: "sticker"` + base64 WebP valid (magic bytes) tapi belum connected → `409 NOT_CONNECTED` (lolos validasi format, ditolak di tahap koneksi seperti mestinya).
  - `POST /media/download` dengan `media_type: "sticker"` → tidak lagi ditolak `400 INVALID_MEDIA_TYPE` (celah `hardcoded ['image','document']` yang ditemukan sudah diperbaiki) -- lanjut ke proses download sungguhan (gagal di sandbox ini karena tidak ada akses jaringan ke server WhatsApp, error `MEDIA_UNAVAILABLE`, BUKAN karena `media_type` ditolak).
- Fakta Baileys berikut diverifikasi LANGSUNG dari `node_modules/baileys` yang ter-install (bukan tebakan): field proto `IStickerMessage` (`WAProto/index.d.ts`), `MediaType` mencakup `'sticker'` (`Defaults/index.js`), dan variant `sticker` di `AnyMediaMessageContent` (`Types/Message.d.ts`) tidak punya field caption.

### 16.4 Yang sudah diverifikasi di HP sungguhan (bukan cuma sandbox)

- **Kirim sticker WebP sungguhan** lewat `POST /send-media` (dari AuliaPos POS ke WhatsApp asli, via app Android) — dikonfirmasi 2026-09-17: `[SEND] pesan media berhasil dikirim` di Logcat, tanpa error, dan `media_ref` yang dikembalikan terbukti bisa dipakai ulang (`[MEDIA] berhasil mengambil & mendekripsi media on-demand`). Ini juga sekaligus memverifikasi fix `os.tmpdir()` override (lihat `android/README.md` §Troubleshooting) benar-benar bekerja untuk sticker di device nyata.

### 16.5 Yang PERLU kamu jalankan/verifikasi sendiri (BELUM bisa diverifikasi di sandbox ini)

1. **Terima sticker sungguhan** (statis) dari HP customer asli, pastikan tersimpan sebagai `message_type: "sticker"` dan bisa diambil ulang lewat `POST /media/download` (dibuka sebagai gambar WebP yang valid, bukan corrupt).
2. **Terima sticker ANIMASI sungguhan**, pastikan tetap diteruskan dengan benar (flag `isAnimated` dari WhatsApp sungguhan belum pernah diverifikasi bentuknya persis seperti apa di sandbox ini -- kode mengasumsikan `boolean`, sesuai definisi proto).
3. **Kirim file WebP yang valid secara format tapi TIDAK memenuhi syarat sticker WhatsApp** (dimensi bukan 512x512, ukuran terlalu besar, dst) -- `isValidWebp()` SENGAJA cuma cek magic bytes container, jadi kemungkinan besar akan lolos validasi Gateway tapi ditolak oleh WhatsApp sendiri. Perlu dipastikan pesan error dari Baileys (kalau ada) diteruskan dengan jelas, bukan generic `500`.
4. **Sisi CI4 (AuliaPos v3.0)**: seperti disebutkan di §14.4, endpoint `POST /send-media` sudah mendukung sticker di sisi Gateway, tapi UI upload sticker + pemanggilannya dari CI4 adalah pekerjaan terpisah di luar scope perubahan ini. Untuk arah masuk, cabang kode `image`/`document` yang akan direuse untuk `sticker` di `InboxGatewayApi::messages()` (sisi AuliaPos) BELUM diverifikasi menerima `message_type: "sticker"` dengan benar -- itu perubahan di repo AuliaPos, bukan Gateway ini.
