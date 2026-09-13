package com.auliapos.wagateway

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/**
 * Client HTTP kecil untuk memanggil API Gateway sendiri di
 * http://127.0.0.1:<port>/api/* dari sisi Kotlin (dipakai
 * GatewayForegroundService untuk update notifikasi status, dan
 * ui/PairingScreen.kt untuk memicu pairing code/QR). Sengaja tidak pakai
 * library HTTP tambahan (OkHttp dst) -- panggilan ini simple & jarang
 * (polling tiap beberapa detik), HttpURLConnection bawaan JDK cukup.
 */
data class GatewayStatus(
    val status: String,
    val connectedNumber: String?,
    val hasQr: Boolean,
    val pairingCode: String?,
)

object GatewayApiClient {
    private fun baseUrl(port: Int) = "http://127.0.0.1:$port"

    suspend fun getStatus(port: Int): Result<GatewayStatus> = withContext(Dispatchers.IO) {
        runCatching {
            val json = httpGet("${baseUrl(port)}/api/status")
            val data = JSONObject(json).getJSONObject("data")
            GatewayStatus(
                status = data.optString("status", "unknown"),
                connectedNumber = data.optString("connectedNumber", null).takeUnless { it.isNullOrEmpty() },
                hasQr = data.optBoolean("hasQr", false),
                pairingCode = data.optString("pairingCode", null).takeUnless { it.isNullOrEmpty() },
            )
        }
    }

    suspend fun getQrDataUrl(port: Int): Result<String?> = withContext(Dispatchers.IO) {
        runCatching {
            val json = httpGet("${baseUrl(port)}/api/qr")
            val data = JSONObject(json).getJSONObject("data")
            if (data.optBoolean("available", false)) data.getString("qrDataUrl") else null
        }
    }

    suspend fun requestPairingCode(port: Int, phone: String): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            val body = JSONObject().put("phone", phone).toString()
            val json = httpPost("${baseUrl(port)}/api/pairing-code", body)
            val root = JSONObject(json)
            if (!root.optBoolean("ok", false)) {
                error(root.optString("error", "Gagal meminta pairing code"))
            }
            root.getJSONObject("data").getString("pairingCode")
        }
    }

    suspend fun logout(port: Int): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            httpPost("${baseUrl(port)}/api/logout", "")
            Unit
        }
    }

    private fun httpGet(url: String): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 5000
        conn.readTimeout = 5000
        try {
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    private fun httpPost(url: String, body: String): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 5000
        conn.readTimeout = 10000
        conn.setRequestProperty("Content-Type", "application/json")
        try {
            OutputStreamWriter(conn.outputStream).use { it.write(body) }
            val stream = if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream
            return stream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }
}
