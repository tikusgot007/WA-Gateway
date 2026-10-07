# Petunjuk Penggunaan — Paket Instalasi Gateway WhatsApp

Dokumen ini untuk **operator** yang memasang gateway WhatsApp di PC Windows baru.
Gateway ini berdiri sendiri (gateway-only): AuliaPos (POS + database-nya) tetap
berjalan di server lain. Paket memasang **PostgreSQL 16 + Evolution API 2.3.7 +
adapter evolution-gateway**, lalu menyambungkannya ke AuliaPos lewat LAN.

Start/stop dilakukan **manual** (tanpa scheduled task / watchdog).

---

## 1. Prasyarat

- Windows 10/11 **64-bit**.
- **PowerShell 5.1+** (bawaan Windows) dan dijalankan **sebagai Administrator**.
- **Akses internet** saat pemasangan (bootstrap online: mengunduh Node LTS, binari
  PostgreSQL 16, sumber Evolution API, dan sumber adapter).
- `winget` tersedia (biasanya sudah ada di Windows 10/11). Kalau tidak ada, pasang
  **Node.js LTS (v20+)** secara manual lebih dulu (lihat bagian 8).
- Nilai berikut sudah disiapkan sebelum mulai:
  - **Alamat AuliaPos** (contoh `http://192.168.1.10/aulia-app`).
  - **Token gateway** — harus **sama persis** dengan `inbox.gatewayToken` di `.env`
    AuliaPos. Tanyakan ke admin AuliaPos.
  - **Daftar IP tepercaya** yang boleh mengakses port 3000/8080 (mis. IP server
    AuliaPos dan IP komputer operator), dipisah koma.
- Nomor WhatsApp yang akan dipakai gateway (nomor baru khusus, bukan nomor pribadi
  yang dipakai sehari-hari) dan HP untuk scan QR.

> Mode `WHATSAPP-BAILEYS` bersifat **unofficial**; risiko pemblokiran nomor oleh
> WhatsApp tetap ada. Ini keputusan operasional, bukan jaminan aman.

---

## 2. Instalasi

Buka PowerShell **sebagai Administrator**. Disarankan menaruh token di sebuah file
sekali pakai (agar tidak tampil di command line / history):

```powershell
Set-Content -LiteralPath "$env:TEMP\aulia-gateway-token.txt" `
  -Value "<token sama dengan inbox.gatewayToken AuliaPos>" -NoNewline

Set-Location <folder-paket-ini>\..
powershell -ExecutionPolicy Bypass -File installer\install.ps1 `
  -Ci4BaseUrl          "http://192.168.1.10/aulia-app" `
  -Ci4GatewayTokenFile "$env:TEMP\aulia-gateway-token.txt" `
  -LanSources          "192.168.1.10"
```

Alternatif: `-Ci4GatewayToken "<token>"` (nilai tampil di command line/history —
kurang aman). Salah satu dari `-Ci4GatewayToken` atau `-Ci4GatewayTokenFile` wajib.

Parameter yang bisa diubah:

| Parameter | Default | Keterangan |
|---|---|---|
| `-InstallRoot` | `C:\AuliaGateway` | folder induk; semua komponen dipasang di sini |
| `-Ci4BaseUrl` | (wajib) | alamat AuliaPos |
| `-Ci4GatewayToken` | — | token gateway (tampil di command line; pakai salah satu) |
| `-Ci4GatewayTokenFile` | — | file berisi token (disarankan; pakai salah satu) |
| `-LanSources` | (wajib) | IP yang diizinkan ke port 3000/8080 |
| `-InstanceName` | `aulia-toko` | nama instance Evolution |
| `-PgPort` / `-EvolutionPort` / `-AdapterPort` | `5432` / `8080` / `3000` | port |
| `-EvolutionRef` | `2.3.7` | tag sumber Evolution API |
| `-AdapterRef` | `master` | branch/commit sumber adapter (sebaiknya commit SHA saat rilis) |
| `-PgVersion` | `16.15-1` | versi binari PostgreSQL Windows |
| `-SkipPrereqs` | mati | lewati pemasangan Node/PostgreSQL (bila sudah ada) |

Apa yang dilakukan `install.ps1` (berurutan):

1. Memeriksa hak admin dan memastikan port belum terpakai.
2. Menyiapkan **Node.js LTS** (lewat `winget`) dan **binari PostgreSQL 16**.
3. Mengunduh **Evolution API** (tag `2.3.7`) dan **adapter** (ref terpin).
4. `npm ci` kedua repo, lalu `prisma generate`.
5. Menerapkan **patch view-once** ke sumber Evolution (idempotent).
6. Membuat `.env` adapter + Evolution (kunci API dibuat lokal).
7. Menyiapkan **cluster + service PostgreSQL**, role, dan database.
8. `prisma migrate deploy` (skema Evolution).
9. Menjalankan stack (`start.ps1`).
10. Membuka **firewall** hanya untuk `-LanSources`.
11. Membuat **instance** Evolution + mendaftarkan **webhook**.
12. Menulis **`install-summary.txt`** (nilai ter-resolve + langkah berikutnya).

Selesai. Ringkasan tersimpan di `<InstallRoot>\install-summary.txt`.

---

## 3. Start / Stop / Status (manual)

Semua perintah dijalankan dari folder paket sebagai Administrator.

```powershell
# Menyalakan PostgreSQL (service) + Evolution + adapter
powershell -ExecutionPolicy Bypass -File installer\start.ps1 -InstallRoot C:\AuliaGateway

# Mematikan Evolution + adapter (PostgreSQL tetap jalan)
powershell -ExecutionPolicy Bypass -File installer\stop.ps1  -InstallRoot C:\AuliaGateway

# Status: service, port, proses, status instance, ekor log
powershell -ExecutionPolicy Bypass -File installer\status.ps1 -InstallRoot C:\AuliaGateway
```

- `start.ps1` idempotent: komponen yang portnya sudah listen dilewati.
- `stop.ps1` hanya mematikan proses node yang command line-nya cocok dengan
  adapter/Evolution; port milik proses lain tidak diganggu.
- Untuk juga mematikan PostgreSQL: tambahkan `-StopPostgres` pada `stop.ps1`.

---

## 4. Menautkan nomor WhatsApp (scan QR)

Pairing **sengaja manual**: siapa pun yang melihat QR bisa menautkan perangkat ke
nomor tersebut. QR tidak pernah dicetak atau disimpan oleh skrip.

1. Pastikan stack hidup (`start.ps1` dan `status.ps1` menunjukkan
   `evolution/adapter` listen dan instance `state=connecting`).
2. Buka **Evolution Manager** di browser:
   - dari PC gateway: `http://127.0.0.1:8080/manager`
   - dari PC lain (IP ada di `-LanSources`): `http://<IP-PC-GATEWAY>:8080/manager`
3. Pilih instance (default `aulia-toko`), lalu **scan QR** memakai WhatsApp nomor
   gateway: **Perangkat Tertaut → Tautkan perangkat**.
4. Tunggu sampai status instance **`open`**. Cek:

```powershell
powershell -ExecutionPolicy Bypass -File installer\status.ps1 -InstallRoot C:\AuliaGateway
```

### 4.1 Read receipts / status dibaca — WAJIB

Fitur centang biru ("status dibaca") di Inbox AuliaPos **hanya** bekerja bila nomor
WhatsApp gateway mengirim read receipt. Baileys/Evolution bisa menandai pesan
dibaca, tetapi WhatsApp tetap **tidak** mengirim blue tick ke pelanggan jika
privasi **Read receipts** nomor gateway = `none`. Jadi setelah instance `open`,
pastikan read receipts aktif:

```powershell
# Lihat nilai sekarang -- yang benar: "readreceipts":"all"
curl.exe -s -H "apikey: <EVOLUTION_API_KEY>" http://127.0.0.1:8080/chat/fetchPrivacySettings/<InstanceName>

# Aktifkan (ganti <InstanceName>, default aulia-toko)
curl.exe -s -X POST -H "apikey: <EVOLUTION_API_KEY>" -H "Content-Type: application/json" -d "{\"readreceipts\":\"all\",\"profile\":\"all\",\"status\":\"all\",\"online\":\"match_last_seen\",\"last\":\"none\",\"groupadd\":\"all\"}" http://127.0.0.1:8080/chat/updatePrivacySettings/<InstanceName>
```

`<InstanceName>` default `aulia-toko` (lihat `-InstanceName`); `EVOLUTION_API_KEY`
ada di `<InstallRoot>\evolution-gateway\.env`.

> Catatan penting:
> - Setelan `settings.readMessages` **tidak** perlu diaktifkan (biarkan `false`).
>   Pesan tidak otomatis dibaca; AuliaPos menandai dibaca hanya saat kasir
>   membuka percakapan.
> - Mengubah privacy sesaat dapat membuat koneksi instance singkat tidak stabil
>   (`connecting`/`close`). Tunggu sampai `open` stabil sebelum menguji; bila perlu
>   `installer\stop.ps1` lalu `installer\start.ps1`.

---

## 5. Verifikasi

1. `status.ps1` menunjukkan `pg=True evolution=True adapter=True` dan instance
   `state=open`.
2. Kirim pesan WhatsApp dari HP lain ke nomor gateway — pesan harus muncul di
   **Inbox AuliaPos**.
3. Balas dari Inbox AuliaPos — pesan harus terkirim ke WhatsApp.

Uji kirim manual (opsional, mengirim pesan nyata — pastikan nomor tujuan benar):

```powershell
Set-Location <InstallRoot>\evolution-gateway
node scripts\test-send.js 628123456789@s.whatsapp.net "uji gateway"
```

---

## 6. Menyambungkan ke AuliaPos (sisi server POS)

Di server AuliaPos, ubah `.env`:

```
inbox.gatewayBaseUrl = 'http://<IP-PC-GATEWAY>:3000'
inbox.gatewayToken   = '<token yang sama dengan -Ci4GatewayToken di atas>'
```

Lalu beri tahu admin AuliaPos untuk memuat ulang konfigurasi. Tanpa langkah ini,
gateway sudah jalan tetapi Inbox tidak saling terhubung.

---

## 7. Perawatan dan keamanan

- Jangan bagikan isi `.env` (berisi API key, password database, secret webhook).
  File ini tidak dilacak Git.
- `-LanSources` bersifat wajib: firewall tidak akan dibuka ke semua alamat.
- Rahasia webhook (`EVOLUTION_WEBHOOK_SECRET`) dibuat otomatis dan wajib ada,
  sehingga webhook tanpa header yang benar akan ditolak.
- Media masuk disimpan di `<InstallRoot>\evolution-gateway\data\media` dengan
  retensi default 7 hari.
- Log ada di `<InstallRoot>\logs\`. Backup/rotasi log belum diotomatiskan.

---

## 8. Penanganan masalah

| Gejala | Kemungkinan penyebab | Tindakan |
|---|---|---|
| `install.ps1` menolak karena port terpakai | port 5432/8080/3000 dipakai proses lain | hentikan proses itu atau pilih port lain lewat `-PgPort`/`-EvolutionPort`/`-AdapterPort` |
| `Node.js belum ada dan winget tidak tersedia` | winget tidak ada | pasang Node.js LTS manual (nodejs.org), tutup-buka PowerShell, ulangi `install.ps1 -SkipPrereqs` |
| `npm ci` gagal saat memasang Evolution | `better-sqlite3`/native module tidak ada prebuilt | pasang **Visual Studio Build Tools** (Desktop C++), lalu ulangi |
| PostgreSQL tidak siap / `pg_isready` gagal | service belum jalan | `Get-Service <ServiceName>`; `start.ps1` akan menyalakannya; cek `<InstallRoot>\logs\install-postgres.log` |
| Instance belum `open` setelah scan | QR kadaluarsa / socket menutup | buka Evolution Manager, muat ulang QR, scan lagi; tunggu instance benar-benar `open` |
| Adapter tidak listen di 3000 | error saat start | lihat `<InstallRoot>\logs\adapter.err.log` |
| Pesan masuk tidak sampai ke Inbox | `inbox.gatewayBaseUrl`/token AuliaPos belum disamakan | ulangi bagian 6 |
| Pesan tanpa secret ditolak di webhook | secret webhook tidak cocok | ulangi pendaftaran webhook (jalankan `node scripts\setup-instance.js` dari folder adapter) |
| Blue tick/status dibaca tidak muncul di HP pelanggan | privasi **Read receipts** nomor gateway = `none` | aktifkan seperti bagian 4.1 (`readreceipts: all`) |

Bila perlu memulai ulang dari awal: `stop.ps1`, lalu ulangi `install.ps1` dengan
parameter yang sama (langkah yang sudah selesai akan dilewati).
