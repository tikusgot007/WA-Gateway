# WA Gateway - Android (Node.js embedded)

Aplikasi Android yang menjalankan Gateway (Baileys) **langsung di HP**,
tanpa perlu PC/server terpisah -- HP inilah yang connect ke WhatsApp,
menyimpan session, mengantre pesan yang gagal terkirim ke POS, dan
menyajikan dashboard test yang sama seperti versi desktop.

Source code Gateway (`src/`, `public/`) **TIDAK diduplikasi/ditulis
ulang** di sini -- app ini meng-embed Node.js runtime (proyek
[nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile)) dan
menjalankan salinan `src/app/index.js` yang sama persis dengan yang
dipakai di Windows/desktop. Satu source code, dua target.

> **Status**: proyek ini **belum pernah di-build/dijalankan di Android
> Studio sungguhan** oleh sesi yang menulisnya -- sandbox yang dipakai
> tidak punya Android SDK/NDK/emulator, dan akses ke `dl.google.com`
> (Maven Google, wajib untuk resolve Android Gradle Plugin) diblokir
> jaringan sandbox tersebut. Bagian JS/Node-nya SUDAH diuji jalan (lihat
> "Yang sudah diverifikasi" di bawah), tapi bagian Kotlin/JNI-nya baru
> divalidasi lewat pembacaan kode cermat, BUKAN compile sungguhan.
> Anggap ini starting point yang solid, bukan produk jadi -- wajar kalau
> ada penyesuaian kecil dibutuhkan saat build pertama kali (lihat
> "Troubleshooting").

## Yang sudah diverifikasi (dijalankan sungguhan, bukan cuma dibaca)

- `npm run android:prepare-assets` berhasil membuat bundle Node lengkap
  tanpa `better-sqlite3`.
- Gateway (`src/app/index.js`) berhasil **start dari nol** memakai
  bundle itu di folder terisolasi (disimulasikan sebagai storage privat
  app Android): fallback `IncomingBufferJsonFile` otomatis terpakai,
  HTTP API `0.0.0.0:<port>` benar-benar listen dan merespons
  `GET /api/status`, worker delivery & heartbeat jalan.
- Fallback JSON buffer (`src/store/incomingBuffer.js`) diuji: enqueue
  idempotent, retry backoff, mark completed -- hasilnya identik dengan
  versi SQLite.
- Endpoint baru `POST /api/pairing-code` (lihat bagian arsitektur).

Yang **belum** diverifikasi (butuh Android Studio + HP sungguhan):
compile Kotlin, compile JNI/CMake terhadap `libnode.so` asli, App benar-
benar connect ke WhatsApp dari dalam APK, foreground service bertahan di
background HP sungguhan.

---

## 1. Arsitektur Singkat

```
App Android (Kotlin, Jetpack Compose)
├── MainActivity + NavHost
│   ├── SetupScreen      -- port, URL/token POS, auto-start
│   ├── MonitorScreen    -- status + login (pairing code / QR)
│   └── DashboardScreen  -- WebView, reuse public/ dashboard apa adanya
├── GatewayForegroundService
│   -- wake lock + wifi lock + notifikasi persisten, supaya Gateway
│      tetap hidup & TERHUBUNGI walau layar HP mati
├── NodeBridge (JNI) ──────────────► native-lib.cpp ──► libnode.so
│   -- salin nodejs-project dari assets APK ke storage privat app,
│      tulis .env sesuai Setup, lalu node::Start()
└── assets/nodejs-project/  (dari npm run android:prepare-assets)
    = salinan src/ + public/ + package.json + node_modules
      (TANPA better-sqlite3 -- lihat src/store/incomingBuffer.js)
```

Kenapa **pairing code**, bukan scan QR, jadi cara login default: HP ini
sering kali adalah HP YANG SAMA dengan HP pemilik nomor WhatsApp (biar
tidak perlu HP kedua) -- scan QR ke layar sendiri tidak praktis. Baileys
mendukung `sock.requestPairingCode(phoneNumber)` sebagai alternatif,
sudah di-wire lewat endpoint baru `POST /api/pairing-code` (lihat
`src/whatsapp/connectionManager.js` & `src/api/routes.js`). QR tetap
tersedia di MonitorScreen sebagai opsi kalau mau scan dari HP lain.

**Kenapa targetSdk 33, bukan 34**: mulai targetSdk 34, Android membatasi
foreground service tipe `dataSync` maksimal ~6 jam kumulatif per 24 jam
lalu dihentikan paksa oleh sistem -- tidak cocok untuk Gateway yang harus
hidup terus-menerus. Tetap compileSdk 34 (API terbaru tersedia saat
compile), cuma app tidak kena kebijakan baru itu.

**Kenapa `better-sqlite3` dihapus dari bundle Android**: native addon
SQLite butuh binary yang cocok dengan arsitektur CPU. Daripada
cross-compile (rumit, rapuh), `src/store/incomingBuffer.js` sudah dibuat
otomatis fallback ke penyimpanan JSON murni JavaScript kalau
`better-sqlite3` tidak ketemu -- lihat `scripts/prepare-android-assets.js`
yang sengaja menghapus foldernya setelah `npm install`.

---

## 2. Prasyarat

- **Android Studio** (Jellyfish 2023.3.1 atau lebih baru) dengan:
  - Android SDK Platform 34
  - **NDK 26.1.10909125** (Tools > SDK Manager > SDK Tools > centang
    "Show Package Details" untuk pilih versi persis ini, harus sama
    dengan yang ditulis di `app/build.gradle.kts`)
  - CMake 3.22.1
- **Node.js v20+** di komputer yang sama (untuk menjalankan
  `npm run android:prepare-assets` dari root repo -- gunakan Node yang
  sama dengan yang dipakai menjalankan Gateway versi desktop).
- HP Android **fisik** untuk testing sungguhan (koneksi WhatsApp perlu
  device asli; emulator BISA dipakai untuk sekadar cek app kebuka/build
  sukses, tapi tidak untuk uji koneksi WA end-to-end).

---

## 3. Langkah Build

### 3.1 Unduh `libnode.so` + header Node.js (WAJIB, tidak ikut repo ini)

Binary native Node.js untuk Android (`libnode.so`, per arsitektur CPU)
+ header C (`node.h`, dst) **tidak di-commit di repo ini** -- ukurannya
ratusan MB per arsitektur dan bukan kode yang kami tulis.

1. Buka [rilis nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile/releases)
   (proyek ini community-maintained setelah tidak lagi aktif dikerjakan
   Janea Systems -- pilih rilis stabil terbaru yang tersedia).
2. Unduh asset Android-nya (nama biasanya mengandung `android`, contoh
   pola `nodejs-mobile-vX.X.X-android.zip` -- **cek isi rilis yang
   tersedia saat kamu baca ini**, struktur nama bisa berbeda antar versi
   karena proyeknya sekarang dikelola komunitas, bukan lagi rilis resmi
   tunggal).
3. Ekstrak, lalu salin:
   - Folder `libnode/bin/<abi>/libnode.so` untuk **keempat** arsitektur
     (`arm64-v8a`, `armeabi-v7a`, `x86_64`, `x86`) ke:
     ```
     android/app/libnode/bin/arm64-v8a/libnode.so
     android/app/libnode/bin/armeabi-v7a/libnode.so
     android/app/libnode/bin/x86_64/libnode.so
     android/app/libnode/bin/x86/libnode.so
     ```
   - Folder header Node.js (biasanya `include/node/`) ke:
     ```
     android/app/libnode/include/node/*.h
     ```
     (`CMakeLists.txt` sudah mengarah ke path ini, lihat
     `app/src/main/cpp/CMakeLists.txt`.)

   Kalau HP target testing cuma satu jenis arsitektur (HP modern hampir
   selalu `arm64-v8a`), boleh sementara cuma isi `arm64-v8a` saja untuk
   mempercepat -- tapi hapus arsitektur lain dari `abiFilters` di
   `app/build.gradle.kts` supaya build tidak gagal mencari file yang
   tidak ada.

4. **Kalau signature `node::Start()` di header yang kamu unduh berbeda**
   dari yang dipanggil `native-lib.cpp` (bisa terjadi kalau versi
   nodejs-mobile yang dipakai cukup jauh berbeda) -- sesuaikan
   pemanggilannya di `app/src/main/cpp/native-lib.cpp`. Pola di file ini
   mengikuti contoh resmi
   [nodejs-mobile-samples/android/native-gradle-node-folder](https://github.com/JaneaSystems/nodejs-mobile-samples/tree/master/android/native-gradle-node-folder).

### 3.2 Siapkan bundle Node (nodejs-project)

Dari **root repo** (bukan folder `android/`):

```bash
npm run android:prepare-assets
```

Jalankan ini **setiap kali** source `src/` atau `public/` berubah, atau
setiap sebelum build APK baru -- assets lama dihapus & dibuat ulang dari
nol, tidak ada mekanisme sinkronisasi otomatis.

### 3.3 Build di Android Studio

1. Buka folder `android/` (BUKAN root repo) sebagai proyek di Android
   Studio.
2. Tunggu Gradle sync selesai (butuh internet untuk resolve
   `com.android.application`/dependency AndroidX -- pastikan
   `dl.google.com` & `repo.maven.apache.org` tidak diblokir firewall
   kantor/jaringanmu).
3. Build > Build Bundle(s)/APK(s) > Build APK(s). Atau lewat terminal:
   ```bash
   cd android
   ./gradlew assembleDebug
   ```
4. APK ada di `android/app/build/outputs/apk/debug/app-debug.apk`.

### 3.4 Install ke HP target

HP target = **HP yang akan memegang nomor WhatsApp toko**, bisa jadi
BUKAN HP yang kamu pakai sekarang untuk membaca dokumen ini.

- Lewat USB + `adb`: `adb install app-debug.apk`
- Atau salin file APK ke HP (WhatsApp/Drive/USB), buka filenya dari HP,
  izinkan "Install dari sumber tidak dikenal" kalau diminta.

---

## 4. Pemakaian Pertama Kali

1. Buka app > layar **Setup**: isi
   - **Port** (default 3000, bebas asal tidak bentrok port lain di HP).
   - **URL Server POS** (AuliaPos CI4), contoh `http://192.168.1.10/aulia`.
   - **Gateway Token** -- HARUS SAMA PERSIS dengan `inbox.gatewayToken`
     di sisi CI4 (lihat README.md root, bagian integrasi CI4).
   - Centang auto-start kalau mau Gateway otomatis jalan lagi tiap HP
     reboot.
2. Tekan **Simpan & Mulai Gateway** -- foreground service mulai, ada
   notifikasi persisten "menghubungkan...".
3. Di layar **Monitor**, masukkan nomor WhatsApp (format internasional
   tanpa `+`/spasi/0 di depan, contoh `62812xxxxxxx`) lalu **Minta
   Pairing Code**.
4. Buka app **WhatsApp** (app resmi) **di HP yang sama** > Setelan >
   Perangkat Tertaut > Tautkan dengan nomor telepon > masukkan kode yang
   muncul di app Gateway.
5. Setelah WhatsApp konfirmasi, status otomatis berubah jadi "Terhubung"
   dan app pindah ke layar **Dashboard** (WebView dari `public/`, sama
   seperti dashboard test di desktop).

Mau login dari HP lain (scan QR biasa)? Di layar Monitor tekan "Atau
scan QR dari HP lain".

---

## 5. Supaya Gateway Tetap Hidup di Background (WAJIB dibaca)

HP Android (apalagi dari Xiaomi/Oppo/Vivo/Realme/Huawei) SANGAT agresif
mematikan proses background demi hemat baterai -- ini masalah terkenal
di seluruh ekosistem Android, bukan spesifik app ini. Foreground service
+ wake lock + wifi lock di app ini membantu, tapi **tidak menjamin 100%**
di semua merk HP. Langkah tambahan yang disarankan di HP target:

1. **Battery**: Setelan > Aplikasi > WA Gateway > Baterai > pilih
   "Tanpa batas"/"Unrestricted" (bukan "Optimized"/"Dioptimalkan").
2. **Autostart** (khusus MIUI/ColorOS/FuntouchOS/EMUI/Realme UI): cari
   menu "Autostart"/"Mulai otomatis" di pengaturan aplikasi, aktifkan
   untuk WA Gateway.
3. **WiFi tetap nyala saat layar mati**: Setelan > WiFi > Lanjutan >
   "WiFi aktif saat layar mati" = Selalu (nama menu beda-beda tiap merk).
4. **Jangan swipe-close app dari recent apps** -- di banyak HP itu
   dianggap "user ingin app berhenti total" dan foreground service ikut
   dimatikan meski secara teknis Android tidak mengharuskan itu.
5. Pertimbangkan mematikan update sistem otomatis/reboot terjadwal HP
   yang bisa memutus koneksi tanpa auto-start ter-trigger (auto-start
   sudah ditangani `BootReceiver`, tapi tetap butuh `setupCompleted` &
   opsi auto-start dicentang).

---

## 6. Keterbatasan & Risiko yang Perlu Disadari

- **Belum ter-build/ter-test sungguhan** di Android Studio oleh sesi
  yang menulis kode ini (lihat bagian "Status" di atas) -- kemungkinan
  ada penyesuaian kecil dibutuhkan (lihat Troubleshooting).
- **API tidak punya authentication**, sama seperti versi desktop --
  JANGAN expose Gateway ke internet, HANYA di LAN toko yang dipercaya.
  Karena `HOST=0.0.0.0` dipakai secara default di Android (supaya server
  POS bisa memanggil `/send`), risiko ini SELALU aktif di versi Android,
  bukan opsional seperti di desktop.
- **HP harus di LAN/WiFi yang sama dengan server POS** untuk fitur kirim
  pesan dari POS (`POST /send`) -- HP di luar jaringan itu (data
  seluler) tidak bisa dihubungi balik oleh POS (NAT/firewall operator).
  Pesan MASUK & retry-nya (WA -> Gateway -> POS) tetap aman di skenario
  mana pun karena arahnya Gateway yang menghubungi POS, bukan sebaliknya
  -- lihat README.md root bagian reliability buffer.
- **Risiko akun WhatsApp**: Baileys adalah unofficial client (bukan API
  resmi Meta/WhatsApp Business API), ada risiko pemblokiran akun --
  risiko ini sama persis dengan versi desktop, tidak bertambah/berkurang
  karena dipindah ke HP.
- **Ukuran APK besar** (puluhan-ratusan MB) karena membawa `libnode.so`
  untuk tiap arsitektur CPU -- wajar untuk aplikasi yang meng-embed
  runtime Node.js penuh.
- **nodejs-mobile tidak lagi dikelola aktif** oleh pembuat aslinya
  (Janea Systems) -- sekarang dilanjutkan komunitas. Cukup matang untuk
  dipakai, tapi update/dukungan tidak secepat proyek besar lainnya.

---

## 7. Troubleshooting

**`UnsatisfiedLinkError: dlopen failed: library "libnode.so" not found`**
HP target arsitekturnya tidak ada di `app/libnode/bin/<abi>/libnode.so`
yang kamu isi. Cek arsitektur HP (Setelan > Tentang HP, atau
`adb shell getprop ro.product.cpu.abi`), pastikan file untuk arsitektur
itu ada.

**Gradle sync gagal resolve `com.android.application`/AndroidX**
Firewall/jaringan memblokir `dl.google.com` atau
`repo.maven.apache.org`. Ini render umum di jaringan kantor/korporat --
coba dari jaringan lain atau lewat VPN.

**CMake error: `node.h`/`node_api.h` tidak ketemu**
Header Node.js belum ditaruh di `app/libnode/include/node/`, atau nama
foldernya beda dari yang diasumsikan `CMakeLists.txt` (`include/node`).
Sesuaikan `NODEJS_MOBILE_LIBNODE_DIR`/`include_directories` di
`app/src/main/cpp/CMakeLists.txt` dengan struktur folder rilis yang kamu
unduh.

**App kebuka tapi status selalu "Menghubungkan..." tidak pernah lanjut**
Cek `adb logcat | grep WaGatewayNode` dan `adb logcat | grep NodeJS` --
semua log Gateway (termasuk error Baileys) diteruskan ke Logcat lewat
`native-lib.cpp`. Penyebab umum: HP tidak ada akses internet, atau
`fetchLatestBaileysVersion()` gagal terus (Baileys tidak bisa reach
server WhatsApp).

**Pairing code selalu gagal / error "sudah pernah login"**
Kalau sebelumnya app ini PERNAH connect ke WhatsApp lalu logout tidak
sempurna, folder `auth/` di storage app masih menyimpan credential lama.
Hapus data app (Setelan > Aplikasi > WA Gateway > Hapus Data) untuk
mulai dari nol, atau panggil `POST /api/logout` dulu dari dashboard.

---

## 8. Struktur File

```
android/
├── settings.gradle.kts, build.gradle.kts, gradle.properties, gradlew*
├── app/
│   ├── build.gradle.kts
│   ├── libnode/bin/<abi>/          <- ISI MANUAL, lihat 3.1 (tidak di-commit)
│   ├── libnode/include/node/       <- ISI MANUAL, lihat 3.1 (tidak di-commit)
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── cpp/CMakeLists.txt, native-lib.cpp   <- jembatan JNI ke libnode
│       ├── java/com/auliapos/wagateway/
│       │   ├── MainActivity.kt         <- NavHost (Setup/Monitor/Dashboard)
│       │   ├── NodeBridge.kt           <- salin assets + start Node
│       │   ├── GatewayForegroundService.kt  <- wakelock/wifilock/notifikasi
│       │   ├── GatewayApiClient.kt     <- panggil API Gateway sendiri
│       │   ├── GatewayPrefs.kt         <- SharedPreferences (Setup)
│       │   ├── BootReceiver.kt         <- auto-start setelah reboot
│       │   └── ui/*.kt                 <- layar Compose
│       ├── res/                        <- string/tema/ikon
│       └── assets/nodejs-project/      <- HASIL GENERATE, lihat 3.2 (tidak di-commit)
└── README.md   <- file ini
```
