package com.auliapos.wagateway

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Foreground service yang menjaga Gateway (Node.js + koneksi WhatsApp)
 * tetap hidup walau layar mati / app di-swipe dari recent apps. Tanpa
 * ini, Android (apalagi HP Xiaomi/Oppo/Vivo yang agresif membunuh
 * background process) akan mematikan koneksi WhatsApp setelah beberapa
 * menit layar mati -- lihat android/README.md bagian "Battery & Doze".
 *
 * Tiga hal yang dipegang selama service hidup:
 *   1. WakeLock partial -- CPU tetap boleh proses (JS timer, koneksi
 *      Baileys) walau layar mati.
 *   2. WifiLock full-high-perf -- WiFi tidak di-suspend, supaya HTTP
 *      server (Express) tetap bisa DIHUBUNGI dari server POS di LAN
 *      walau layar HP mati (bukan cuma supaya HP bisa connect KELUAR).
 *   3. Notifikasi persisten -- syarat wajib foreground service, sekaligus
 *      dipakai menampilkan status koneksi WA terkini ke user.
 */
class GatewayForegroundService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    private val scope = CoroutineScope(Dispatchers.Main + Job())
    private var statusPollJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()

        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "WaGateway:nodeRuntime").apply {
            setReferenceCounted(false)
            acquire()
        }

        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("DEPRECATION")
        wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "WaGateway:wifi").apply {
            setReferenceCounted(false)
            acquire()
        }

        startForeground(NOTIF_ID, buildNotification(getString(R.string.notif_title_connecting)))

        val prefs = GatewayPrefs(applicationContext)
        NodeBridge.startIfNeeded(applicationContext, prefs)
        startStatusPolling(prefs.port)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // START_STICKY: kalau service ini dibunuh sistem karena tekanan
        // memori, Android akan mencoba menghidupkannya lagi -- tapi ini
        // BUKAN jaminan Node ikut hidup lagi (kalau prosesnya sendiri
        // yang mati, semua state Node hilang juga; startIfNeeded() di
        // proses baru akan start Node dari awal, yang mana wajar/aman).
        return START_STICKY
    }

    override fun onDestroy() {
        statusPollJob?.cancel()
        wakeLock?.let { if (it.isHeld) it.release() }
        wifiLock?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }

    private fun startStatusPolling(port: Int) {
        statusPollJob?.cancel()
        statusPollJob = scope.launch {
            while (true) {
                val result = GatewayApiClient.getStatus(port)
                result.onSuccess { status ->
                    updateNotification(status)
                }
                delay(7_000)
            }
        }
    }

    private fun updateNotification(status: GatewayStatus) {
        val title = when (status.status) {
            "connected" -> getString(R.string.notif_title_connected, status.connectedNumber ?: "-")
            "connecting", "reconnecting" -> getString(R.string.notif_title_connecting)
            else -> getString(R.string.notif_title_disconnected)
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager?.notify(NOTIF_ID, buildNotification(title))
    }

    private fun buildNotification(title: String): Notification {
        val openAppIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, openAppIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        return NotificationCompat.Builder(this, NOTIF_CHANNEL_ID)
            .setContentTitle(title)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    companion object {
        const val NOTIF_CHANNEL_ID = "wa_gateway_status"
        const val NOTIF_ID = 1001

        fun start(context: Context) {
            val intent = Intent(context, GatewayForegroundService::class.java)
            context.startForegroundService(intent)
        }
    }
}
