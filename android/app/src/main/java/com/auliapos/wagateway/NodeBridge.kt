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
 *   4. Menyiapkan (& membersihkan) folder tmp privat app sendiri untuk
 *      dipakai sebagai TMPDIR proses Node -- lihat tmpDir()/cleanTmpDir(),
 *      dibutuhkan karena `/tmp` sistem tidak ada/tidak writable di sandbox
 *      app Android (beda dari Linux/Windows desktop), padahal Baileys
 *      butuh direktori temp yang valid untuk generate thumbnail otomatis
 *      saat kirim gambar/video keluar.
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
     * Folder temp milik APP SENDIRI, dipakai sebagai `TMPDIR` untuk proses
     * Node (lihat startIfNeeded() & native-lib.cpp) -- BUKAN `/tmp` sistem.
     *
     * LATAR BELAKANG BUG: Baileys (lib/Utils/messages-media.js) menulis
     * file sementara ke `os.tmpdir()` setiap kali kirim gambar/video KELUAR
     * tanpa `jpegThumbnail` yang sudah disiapkan sendiri (persis yang
     * dilakukan sendMediaMessage() di sini) -- untuk generate thumbnail
     * otomatis. `os.tmpdir()` default ke `/tmp` kalau env var `TMPDIR`
     * tidak diset, dan `/tmp` TIDAK ADA/tidak writable di sandbox proses
     * app Android biasa (beda dari Linux/Windows desktop) -- Node
     * melempar `ENOENT: no such file or directory, open '/tmp/image...-
     * original'` (atau `-enc`) begitu Baileys mencoba menulis/membacanya.
     * Diverifikasi ulang gejala persis ini di sandbox pengembangan dengan
     * memaksa `TMPDIR` ke folder yang tidak ada.
     */
    fun tmpDir(context: Context): File = File(context.filesDir, TMP_DIR_NAME)

    /** true kalau thread Node sudah pernah dimulai di proses (Android process) ini. */
    fun isNodeStarted(): Boolean = nodeStarted.get()

    /**
     * Salin ulang folder nodejs-project dari assets APK ke storage privat
     * app HANYA kalau belum pernah, atau APK sudah di-update sejak
     * salinan terakhir (pola sama seperti sample resmi nodejs-mobile:
     * bandingkan PackageInfo.lastUpdateTime dengan timestamp tersimpan).
     * Auth/session (folder `auth/`) dan buffer retry (folder `data/`)
     * SENGAJA dibuat oleh Node sendiri di luar assets (tidak pernah ada
     * di APK), jadi tidak pernah tertimpa oleh proses salin ulang ini.
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
        if (dir.exists()) {
            dir.deleteRecursively()
        }
        dir.mkdirs()

        val ok = copyAssetFolder(context, PROJECT_ASSET_DIR, dir.absolutePath)
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
