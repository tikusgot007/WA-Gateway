package com.auliapos.wagateway

import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import java.io.File
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Jembatan ke runtime Node.js embedded (lihat cpp/native-lib.cpp). Semua
 * logic Gateway sendiri (koneksi WhatsApp, HTTP API, dashboard) TETAP di
 * JavaScript (assets/nodejs-project/, salinan dari src/ + public/ di root
 * repo) -- object ini HANYA bertugas:
 *   1. Menyalin project Node dari assets APK ke storage privat app (assets
 *      APK read-only, sedangkan Node butuh menulis file: auth/ session,
 *      data/ buffer retry, .env, node_modules/.cache dst).
 *   2. Menulis file `.env` sesuai pengaturan dari layar Setup.
 *   3. Memanggil native startNodeWithArguments() SEKALI per proses (Node
 *      tidak didesain untuk di-restart di proses yang sama -- kalau perlu
 *      restart total, seluruh proses Android app-nya yang diminta selesai
 *      oleh GatewayForegroundService lalu Android/BootReceiver yang
 *      menghidupkan proses baru).
 *   4. Menyiapkan (& membersihkan) folder tmp privat app sendiri, dikirim
 *      ke Baileys lewat DUA jalur sekaligus -- lihat tmpDir()/
 *      cleanTmpDir() di sini, dan src/whatsapp/baileysLoader.js di sisi
 *      JavaScript (jalur yang TERBUKTI benar-benar dipakai Baileys,
 *      lihat catatan kejujuran di file itu) -- dibutuhkan karena `/tmp`
 *      sistem tidak ada/tidak writable di sandbox app Android (beda dari
 *      Linux/Windows desktop), padahal Baileys butuh direktori temp yang
 *      valid untuk generate thumbnail otomatis saat kirim gambar/video/
 *      sticker keluar.
 */
object NodeBridge {
    private const val TAG = "NodeBridge"
    private const val PROJECT_ASSET_DIR = "nodejs-project"
    private const val ENTRY_SCRIPT = "src/app/index.js"
    private const val TMP_DIR_NAME = "tmp"

    init {
        System.loadLibrary("native-lib")
        System.loadLibrary("node")
    }

    @JvmStatic
    external fun startNodeWithArguments(workingDir: String, tmpDir: String, arguments: Array<String>): Int

    private val nodeStarted = AtomicBoolean(false)

    fun projectDir(context: Context): File = File(context.filesDir, PROJECT_ASSET_DIR)

    /**
     * Folder temp milik APP SENDIRI -- BUKAN `/tmp` sistem.
     *
     * LATAR BELAKANG BUG: Baileys (lib/Utils/messages-media.js) menulis
     * file sementara ke `os.tmpdir()` setiap kali kirim gambar/video/
     * sticker KELUAR (untuk generate thumbnail otomatis pada image/video --
     * tapi file `*-enc` untuk data upload terenkripsi dibuat untuk SEMUA
     * jenis media tanpa kecuali, termasuk sticker). `os.tmpdir()` default
     * ke `/tmp` kalau tidak di-override, dan `/tmp` TIDAK ADA/tidak
     * writable di sandbox proses app Android biasa (beda dari Linux/
     * Windows desktop) -- Node melempar `ENOENT: no such file or
     * directory, open '/tmp/image...-original'` (atau `-enc`) begitu
     * Baileys mencoba menulis/membacanya. Diverifikasi ulang gejala
     * persis ini di sandbox pengembangan dengan memaksa `TMPDIR` ke
     * folder yang tidak ada.
     *
     * Path dari folder ini dikirim ke Node lewat DUA jalur: (1) parameter
     * ke `startNodeWithArguments()` -> `setenv("TMPDIR", ...)` di
     * native-lib.cpp (dipertahankan sebagai lapisan tambahan, TAPI
     * TERBUKTI TIDAK CUKUP SENDIRIAN -- lihat catatan di bawah), dan
     * (2) `.env` (`APP_TMP_DIR`, lihat writeEnvFile()) yang dibaca
     * `src/whatsapp/baileysLoader.js` untuk override `os.tmpdir()`
     * langsung di level JavaScript -- jalur (2) inilah yang TERBUKTI
     * benar-benar menyelesaikan masalahnya lewat testing sungguhan di HP.
     */
    fun tmpDir(context: Context): File = File(context.filesDir, TMP_DIR_NAME)

    /** true kalau thread Node sudah pernah dimulai di proses (Android process) ini. */
    fun isNodeStarted(): Boolean = nodeStarted.get()

    /**
     * Salin ulang folder nodejs-project dari assets APK ke storage privat
     * app HANYA kalau belum pernah, atau APK sudah di-update sejak
     * salinan terakhir (pola sama seperti sample resmi nodejs-mobile:
     * bandingkan PackageInfo.lastUpdateTime dengan timestamp tersimpan).
     *
     * PENTING: `auth/` (sesi WhatsApp) dan `data/` (buffer retry) dibuat
     * oleh Node saat runtime dan TIDAK ADA di assets APK, jadi keduanya
     * HARUS dipertahankan melewati salin ulang ini. Sebelum perbaikan ini
     * seluruh direktori dihapus rekursif, sehingga setiap update APK
     * memaksa login WhatsApp ulang (scan QR / pairing code) dan membuang
     * isi buffer retry.
     */
    fun ensureProjectFilesInstalled(context: Context) {
        val dir = projectDir(context)
        val prefs = context.getSharedPreferences("wa_gateway_internal", Context.MODE_PRIVATE)

        val lastUpdateTime = try {
            context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime
        } catch (e: PackageManager.NameNotFoundException) {
            0L
        }
        val installedForUpdate = prefs.getLong("assets_installed_for_update", -1L)

        if (dir.exists() && installedForUpdate == lastUpdateTime) {
            Log.i(TAG, "nodejs-project sudah terpasang & up to date, tidak perlu salin ulang.")
            return
        }

        Log.i(TAG, "Menyalin nodejs-project dari assets APK ke storage app...")

        // Selamatkan auth/ (sesi WhatsApp) & data/ (buffer retry) -- keduanya
        // dibuat Node saat runtime, TIDAK ada di assets, dan hidup DI DALAM
        // nodejs-project. Tanpa langkah ini, deleteRecursively() di bawah
        // ikut menghapusnya (bug: setiap update APK memaksa login WhatsApp
        // ulang + membuang buffer retry).
        val preservedNames = listOf("auth", "data")
        val preservedRoot = File(context.filesDir, "$PROJECT_ASSET_DIR-preserved-tmp")
        preservedRoot.deleteRecursively() // bersihkan sisa percobaan sebelumnya yang gagal

        if (dir.exists()) {
            preservedRoot.mkdirs()
            for (name in preservedNames) {
                val saved = File(dir, name)
                if (saved.exists()) {
                    // renameTo cepat & tidak menggandakan data (satu filesystem);
                    // fallback salin kalau rename gagal.
                    if (!saved.renameTo(File(preservedRoot, name))) {
                        saved.copyRecursively(File(preservedRoot, name), overwrite = true)
                    }
                }
            }
            dir.deleteRecursively()
        }
        dir.mkdirs()

        val ok = copyAssetFolder(context, PROJECT_ASSET_DIR, dir.absolutePath)

        // Kembalikan auth/ & data/ yang diselamatkan.
        for (name in preservedNames) {
            val saved = File(preservedRoot, name)
            if (saved.exists()) {
                val target = File(dir, name)
                if (target.exists()) {
                    target.deleteRecursively()
                }
                if (!saved.renameTo(target)) {
                    saved.copyRecursively(target, overwrite = true)
                }
            }
        }
        preservedRoot.deleteRecursively()

        if (!ok) {
            Log.e(TAG, "Sebagian file nodejs-project GAGAL disalin -- Gateway mungkin tidak bisa start dengan benar.")
        }

        prefs.edit().putLong("assets_installed_for_update", lastUpdateTime).apply()
    }

    private fun copyAssetFolder(context: Context, fromAssetPath: String, toPath: String): Boolean {
        val assets = context.assets
        return try {
            val entries = assets.list(fromAssetPath) ?: return false
            File(toPath).mkdirs()
            var allOk = true
            for (entry in entries) {
                val assetSubPath = "$fromAssetPath/$entry"
                val destSubPath = "$toPath/$entry"
                val subEntries = assets.list(assetSubPath)
                allOk = if (!subEntries.isNullOrEmpty()) {
                    copyAssetFolder(context, assetSubPath, destSubPath) && allOk
                } else {
                    copyAssetFile(context, assetSubPath, destSubPath) && allOk
                }
            }
            allOk
        } catch (e: IOException) {
            Log.e(TAG, "copyAssetFolder gagal untuk $fromAssetPath", e)
            false
        }
    }

    private fun copyAssetFile(context: Context, fromAssetPath: String, toPath: String): Boolean {
        return try {
            context.assets.open(fromAssetPath).use { input ->
                File(toPath).outputStream().use { output -> input.copyTo(output) }
            }
            true
        } catch (e: IOException) {
            Log.e(TAG, "copyAssetFile gagal untuk $fromAssetPath", e)
            false
        }
    }

    /**
     * Tulis ulang `.env` sesuai pengaturan tersimpan (GatewayPrefs) --
     * dipanggil setiap kali sebelum Gateway distart, supaya perubahan di
     * layar Setup langsung berlaku pada start berikutnya. HOST sengaja
     * SELALU 0.0.0.0 (bukan 127.0.0.1 seperti default desktop) karena
     * skenario pemakaian app ini adalah server POS di LAN yang sama
     * memanggil Gateway di HP ini langsung -- lihat android/README.md.
     *
     * APP_TMP_DIR: dibaca `src/whatsapp/baileysLoader.js` untuk override
     * os.tmpdir() -- lihat komentar lengkap di file itu soal kenapa ini
     * dibutuhkan (setenv("TMPDIR") saja di native-lib.cpp TERBUKTI TIDAK
     * CUKUP di runtime Node/nodejs-mobile yang dipakai).
     */
    fun writeEnvFile(context: Context, prefs: GatewayPrefs) {
        val envFile = File(projectDir(context), ".env")
        val content = buildString {
            appendLine("HOST=0.0.0.0")
            appendLine("PORT=${prefs.port}")
            appendLine("AUTH_FOLDER=./auth")
            appendLine("LOG_LEVEL=info")
            appendLine("SQLITE_PATH=./data/gateway.sqlite")
            appendLine("CI4_BASE_URL=${prefs.ci4BaseUrl}")
            appendLine("CI4_GATEWAY_TOKEN=${prefs.ci4GatewayToken}")
            appendLine("APP_TMP_DIR=${tmpDir(context).absolutePath}")
        }
        envFile.writeText(content)
    }

    /**
     * Kosongkan ISI folder tmpDir() (folder itu sendiri TETAP ada setelahnya)
     * -- WAJIB dipanggil setiap app start, SEBELUM node::Start(). Beda dari
     * `/tmp` Linux biasa (yang dibersihkan OS saat reboot/berkala), folder
     * privat app ini PERSISTEN antar-restart.
     *
     * CATATAN KEJUJURAN: Baileys SEBENARNYA sudah membersihkan sendiri file
     * `*-enc`/`*-original`-nya lewat blok `.finally()` di
     * `lib/Utils/messages.js` (jalan baik saat sukses MAUPUN gagal kirim),
     * diverifikasi langsung dari source code-nya. Tapi itu TIDAK menjamin
     * folder ini selalu kosong -- kalau proses app dimatikan paksa di
     * tengah pengiriman media (di-force-stop, kehabisan memori/di-kill OS,
     * crash), blok `.finally()` itu tidak sempat jalan sama sekali dan
     * file sisa akan tertinggal PERMANEN (folder ini persisten, tidak
     * seperti `/tmp` Linux). Pembersihan di sini adalah jaring pengaman
     * untuk skenario itu, bukan pengganti cleanup Baileys.
     */
    private fun cleanTmpDir(context: Context) {
        val dir = tmpDir(context)
        val deletedOk = if (dir.exists()) dir.deleteRecursively() else true
        dir.mkdirs()
        if (!deletedOk) {
            Log.w(TAG, "Sebagian isi $dir gagal dihapus saat start -- tidak fatal, akan dicoba lagi start berikutnya.")
        }
    }

    /**
     * Mulai runtime Node di background thread (SEKALI per proses). Aman
     * dipanggil berkali-kali (mis. dari onStartCommand service yang
     * dipanggil ulang) -- panggilan kedua dst diabaikan.
     */
    fun startIfNeeded(context: Context, prefs: GatewayPrefs) {
        if (nodeStarted.getAndSet(true)) {
            Log.i(TAG, "Node sudah berjalan di proses ini, startIfNeeded() diabaikan.")
            return
        }

        ensureProjectFilesInstalled(context)
        writeEnvFile(context, prefs)
        cleanTmpDir(context)

        val dir = projectDir(context)
        val tmp = tmpDir(context)
        Thread({
            Log.i(TAG, "Memulai Node.js runtime, entry: $ENTRY_SCRIPT, cwd: ${dir.absolutePath}, TMPDIR: ${tmp.absolutePath}")
            startNodeWithArguments(dir.absolutePath, tmp.absolutePath, arrayOf("node", ENTRY_SCRIPT))
            Log.w(TAG, "Node.js runtime BERHENTI (seharusnya jalan terus selama service hidup).")
        }, "node-runtime").apply {
            isDaemon = true
        }.start()
    }
}
