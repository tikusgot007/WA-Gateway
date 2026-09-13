package com.auliapos.wagateway

import android.content.Context

/**
 * Wrapper kecil di atas SharedPreferences untuk pengaturan yang bisa
 * diubah user dari layar Setup (lihat ui/SetupScreen.kt). Nilai-nilai ini
 * ditulis ulang ke file `.env` folder nodejs-project setiap kali Gateway
 * (di)start -- lihat NodeBridge.writeEnvFile().
 */
class GatewayPrefs(context: Context) {
    private val prefs = context.applicationContext
        .getSharedPreferences("wa_gateway_prefs", Context.MODE_PRIVATE)

    var port: Int
        get() = prefs.getInt(KEY_PORT, 3000)
        set(value) = prefs.edit().putInt(KEY_PORT, value).apply()

    // Base URL server POS (AuliaPos CI4), TANPA trailing slash, contoh:
    // http://192.168.1.10/aulia -- boleh kosong (Gateway tetap jalan
    // untuk kirim/terima WA, cuma integrasi ke POS yang dilewati).
    var ci4BaseUrl: String
        get() = prefs.getString(KEY_CI4_BASE_URL, "") ?: ""
        set(value) = prefs.edit().putString(KEY_CI4_BASE_URL, value.trim()).apply()

    var ci4GatewayToken: String
        get() = prefs.getString(KEY_CI4_TOKEN, "") ?: ""
        set(value) = prefs.edit().putString(KEY_CI4_TOKEN, value.trim()).apply()

    // Auto-start Gateway (foreground service) setiap HP boot -- lihat
    // BootReceiver.kt. Default true karena tujuan app ini memang supaya
    // Gateway selalu hidup tanpa perlu dibuka manual tiap saat.
    var autoStartOnBoot: Boolean
        get() = prefs.getBoolean(KEY_AUTOSTART, true)
        set(value) = prefs.edit().putBoolean(KEY_AUTOSTART, value).apply()

    var setupCompleted: Boolean
        get() = prefs.getBoolean(KEY_SETUP_DONE, false)
        set(value) = prefs.edit().putBoolean(KEY_SETUP_DONE, value).apply()

    companion object {
        private const val KEY_PORT = "port"
        private const val KEY_CI4_BASE_URL = "ci4_base_url"
        private const val KEY_CI4_TOKEN = "ci4_gateway_token"
        private const val KEY_AUTOSTART = "autostart_on_boot"
        private const val KEY_SETUP_DONE = "setup_completed"
    }
}
