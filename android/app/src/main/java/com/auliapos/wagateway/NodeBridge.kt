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

        // Selamatkan auth/ (sesi WhatsApp) & data/ (buffer retry) -- keduanya
        // dibuat Node saat runtime, TIDAK ada di assets, dan hidup DI DALAM
        // nodejs-project. Tanpa langkah ini, deleteRecursively() di bawah
        // ikut menghapusnya (bug: setiap update APK memaksa login WhatsApp
        // ulang + membuang buffer retry).
        val preservedRoot = File(context.filesDir, "$PROJECT_ASSET_DIR-preserved-tmp")

        // (1) REKONSILIASI sisa percobaan sebelumnya SEBELUM menyentuh apa pun.
        // Kalau percobaan sebelumnya sempat memindahkan auth/ data/ keluar dari
        // `dir` lalu gagal di tengah, salinan di `preservedRoot` bisa jadi
        // SATU-SATUNYA salinan sesi. JANGAN hapus `preservedRoot` sebelum
        // semuanya berhasil dipulihkan (bug CORR-01).
        val reconcileFailures = RuntimeDataPreserver.reconcile(dir, preservedRoot)
        if (reconcileFailures.isNotEmpty()) {
            for (failure in reconcileFailures) {
                Log.e(TAG, "Gagal memulihkan sisa data runtime '${failure.name}' dari percobaan sebelumnya.", failure.error)
            }
            Log.e(TAG, "Penyalinan ulang project DIBATALKAN: auth/data belum pulih sepenuhnya; tidak ada yang dihapus.")
            return
        }

        Log.i(TAG, "Menyalin nodejs-project dari assets APK ke storage app...")

        if (dir.exists()) {
            // (2) FASE SIMPAN -- exception-safe. Kalau gagal, BATALKAN dan
            // JANGAN hapus `dir`: data yang belum terselamatkan tidak boleh
            // ikut terhapus.
            val saveFailures = RuntimeDataPreserver.preserve(dir, preservedRoot)
            if (saveFailures.isNotEmpty()) {
                for (failure in saveFailures) {
                    Log.e(TAG, "Gagal menyelamatkan data runtime '${failure.name}' sebelum salin ulang.", failure.error)
                }
                Log.e(TAG, "Penyalinan ulang project DIBATALKAN sebelum menghapus apa pun; akan dicoba lagi start berikutnya.")
                return
            }

            val deleted = dir.deleteRecursively()
            if (!deleted) {
                Log.w(TAG, "Sebagian isi nodejs-project gagal dihapus sebelum salin ulang -- melanjutkan.")
            }
        }
        dir.mkdirs()

        val ok = copyAssetFolder(context, PROJECT_ASSET_DIR, dir.absolutePath)

        // (3) FASE KEMBALIKAN -- exception-safe. `preservedRoot` hanya dihapus
        // kalau semua berhasil dipulihkan (lihat RuntimeDataPreserver.restore).
        val restoreFailures = RuntimeDataPreserver.restore(dir, preservedRoot)
        for (failure in restoreFailures) {
            Log.e(TAG, "Gagal mengembalikan data runtime '${failure.name}' setelah salin ulang.", failure.error)
        }

        if (!ok) {
            Log.e(TAG, "Sebagian file nodejs-project GAGAL disalin -- Gateway mungkin tidak bisa start dengan benar.")
        }

        if (restoreFailures.isEmpty()) {
            prefs.edit().putLong("assets_installed_for_update", lastUpdateTime).apply()
        } else {
            Log.e(TAG, "auth/data belum sepenuhnya dikembalikan; penyalinan ditandai BELUM selesai agar dicoba lagi start berikutnya.")
        }
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

/**
 * Logika murni (`java.io.File`) untuk mempertahankan `auth/`/`data/` melewati
 * salin ulang aset APK. Dipisahkan dari [NodeBridge] supaya bisa diuji di JVM
 * tanpa Android `Context`.
 *
 * Exception-safe: kegagalan I/O dikembalikan sebagai daftar [Failure], BUKAN
 * dilempar ke pemanggil. Salinan terakhir yang belum dipulihkan TIDAK PERNAH
 * dihapus -- `preservedRoot` hanya dibersihkan setelah semua nama berhasil
 * dipulihkan (mencegah hilangnya sesi WhatsApp / buffer retry saat I/O gagal
 * di tengah, mis. disk penuh -- temuan CORR-01).
 */
internal object RuntimeDataPreserver {
    val PRESERVED_NAMES = listOf("auth", "data")

    /**
     * Operasi berkas yang dapat disuntik di test (mis. memaksa [move] gagal
     * atau [copy] melempar `IOException`) untuk membuktikan jalur gagal aman.
     */
    internal class Ops(
        val move: (File, File) -> Boolean = { src, dst -> src.renameTo(dst) },
        val copy: (File, File) -> Boolean = { src, dst -> src.copyRecursively(dst, overwrite = true) },
    )

    internal data class Failure(val name: String, val error: Throwable)

    private fun moveOrCopy(src: File, dst: File, ops: Ops) {
        if (ops.move(src, dst)) return
        dst.parentFile?.mkdirs()
        if (!ops.copy(src, dst)) {
            throw IOException("renameTo + copyRecursively gagal: ${src.absolutePath} -> ${dst.absolutePath}")
        }
    }

    /**
     * Pulihkan sisa percobaan sebelumnya: untuk setiap nama, kalau salinan di
     * `projectDir` TIDAK ada sedangkan salinan di `preservedRoot` ada,
     * kembalikan dulu. `preservedRoot` hanya dihapus kalau tidak ada kegagalan.
     *
     * @return daftar kegagalan (kosong = semua aman untuk lanjut).
     */
    fun reconcile(projectDir: File, preservedRoot: File, ops: Ops = Ops()): List<Failure> {
        if (!preservedRoot.exists()) return emptyList()
        val failures = mutableListOf<Failure>()
        var unrestored = 0
        for (name in PRESERVED_NAMES) {
            val saved = File(preservedRoot, name)
            if (!saved.exists()) continue
            val target = File(projectDir, name)
            if (target.exists()) {
                // Keduanya ada: salinan `target` mungkin parsial (peninggalan
                // restore yang gagal). JANGAN hapus `preservedRoot` -- biarkan
                // fase simpan/kembalikan berikutnya merekonsiliasi dengan aman.
                unrestored += 1
                continue
            }
            try {
                moveOrCopy(saved, target, ops)
            } catch (e: IOException) {
                failures.add(Failure(name, e))
            }
        }
        if (failures.isEmpty() && unrestored == 0) {
            preservedRoot.deleteRecursively()
        }
        return failures
    }

    /**
     * FASE SIMPAN: pindahkan `projectDir/<name>` ke `preservedRoot/<name>`.
     * Tidak melempar; kegagalan dikembalikan supaya pemanggil dapat membatalkan
     * salin ulang SEBELUM menghapus apa pun.
     */
    fun preserve(projectDir: File, preservedRoot: File, ops: Ops = Ops()): List<Failure> {
        val failures = mutableListOf<Failure>()
        var rootCreated = false
        for (name in PRESERVED_NAMES) {
            val source = File(projectDir, name)
            if (!source.exists()) continue
            if (!rootCreated) {
                preservedRoot.mkdirs()
                rootCreated = true
            }
            try {
                moveOrCopy(source, File(preservedRoot, name), ops)
            } catch (e: IOException) {
                failures.add(Failure(name, e))
            }
        }
        return failures
    }

    /**
     * FASE KEMBALIKAN: pindahkan `preservedRoot/<name>` kembali ke
     * `projectDir/<name>`. Tidak melempar. `preservedRoot` hanya dihapus kalau
     * SEMUA nama berhasil dipulihkan -- kalau ada kegagalan, salinan di sana
     * dipertahankan sebagai satu-satunya sumber pemulihan.
     */
    fun restore(projectDir: File, preservedRoot: File, ops: Ops = Ops()): List<Failure> {
        val failures = mutableListOf<Failure>()
        for (name in PRESERVED_NAMES) {
            val saved = File(preservedRoot, name)
            if (!saved.exists()) continue
            val target = File(projectDir, name)
            try {
                if (target.exists() && !target.deleteRecursively()) {
                    throw IOException("gagal menghapus target lama: ${target.absolutePath}")
                }
                moveOrCopy(saved, target, ops)
            } catch (e: IOException) {
                // Jangan tinggalkan target SETENGAH JADI: kalau dibiarkan, ia
                // bisa menimpa salinan lengkap di `preservedRoot` pada start
                // berikutnya (saat fase simpan menyalin target parsial balik
                // ke `preservedRoot`). Hapus best-effort supaya salinan lengkap
                // tetap satu-satunya sumber pemulihan.
                if (target.exists()) {
                    target.deleteRecursively()
                }
                failures.add(Failure(name, e))
            }
        }
        if (failures.isEmpty()) {
            preservedRoot.deleteRecursively()
        }
        return failures
    }
}
