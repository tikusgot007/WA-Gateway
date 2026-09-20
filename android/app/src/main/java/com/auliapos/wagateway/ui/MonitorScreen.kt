package com.auliapos.wagateway.ui

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.graphics.createBitmap
import com.auliapos.wagateway.GatewayApiClient
import com.auliapos.wagateway.GatewayStatus
import kotlinx.coroutines.delay

/**
 * Layar utama sebelum WA connected: tampilkan status Gateway, dan form
 * login (pairing code -- lihat pembahasan sebelumnya kenapa ini default,
 * bukan scan QR, untuk kasus Gateway & WA jalan di HP yang sama). QR
 * tetap disediakan sebagai opsi kalau operator ingin scan dari HP lain.
 *
 * Begitu status == "connected", `onConnected` dipanggil (MainActivity
 * berpindah ke DashboardScreen/WebView).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MonitorScreen(
    port: Int,
    onOpenSetup: () -> Unit,
    onConnected: () -> Unit,
) {
    var status by remember { mutableStateOf<GatewayStatus?>(null) }
    var phone by remember { mutableStateOf("") }
    var pairingError by remember { mutableStateOf<String?>(null) }
    var isRequestingCode by remember { mutableStateOf(false) }
    var requestTrigger by remember { mutableStateOf(0) }
    var showQr by remember { mutableStateOf(false) }
    var qrDataUrl by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(port) {
        while (true) {
            GatewayApiClient.getStatus(port).onSuccess { s ->
                status = s
                if (s.status == "connected") onConnected()
            }
            if (showQr) {
                GatewayApiClient.getQrDataUrl(port).onSuccess { qrDataUrl = it }
            }
            delay(3_000)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("WA Gateway") },
                actions = {
                    IconButton(onClick = onOpenSetup) {
                        Icon(Icons.Filled.Settings, contentDescription = "Pengaturan")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .padding(16.dp)
                .fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            StatusCard(status)

            if (status?.status != "connected") {
                Text("Login dengan Pairing Code", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Masukkan nomor WhatsApp yang akan dipakai (format internasional, " +
                        "tanpa '+'/spasi/0 di depan), contoh: 62812xxxxxxx.",
                    style = MaterialTheme.typography.bodySmall,
                )
                OutlinedTextField(
                    value = phone,
                    onValueChange = { phone = it.filter(Char::isDigit) },
                    label = { Text("Nomor WhatsApp") },
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = {
                        isRequestingCode = true
                        pairingError = null
                        requestTrigger++
                    },
                    enabled = phone.length >= 8 && !isRequestingCode,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(if (isRequestingCode) "Meminta kode..." else "Minta Pairing Code")
                }

                LaunchedEffect(requestTrigger) {
                    if (requestTrigger == 0) return@LaunchedEffect
                    GatewayApiClient.requestPairingCode(port, phone)
                        .onSuccess { status = status?.copy(pairingCode = it) }
                        .onFailure { pairingError = it.message }
                    isRequestingCode = false
                }

                pairingError?.let {
                    Text(it, color = MaterialTheme.colorScheme.error)
                }

                status?.pairingCode?.let { code ->
                    PairingCodeCard(code)
                }

                TextButton(onClick = { showQr = !showQr }) {
                    Text(if (showQr) "Sembunyikan QR" else "Atau scan QR dari HP lain")
                }

                if (showQr) {
                    QrCard(qrDataUrl)
                }
            }
        }
    }
}

@Composable
private fun StatusCard(status: GatewayStatus?) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text("Status Koneksi", style = MaterialTheme.typography.titleMedium)
            Text(
                when (status?.status) {
                    "connected" -> "Terhubung (${status.connectedNumber ?: "-"})"
                    "connecting" -> "Menghubungkan..."
                    "reconnecting" -> "Menyambung ulang..."
                    "logged_out" -> "Logout -- perlu login ulang"
                    null -> "Memuat status..."
                    else -> "Terputus"
                },
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

@Composable
private fun PairingCodeCard(code: String) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("Kode Pairing", style = MaterialTheme.typography.titleSmall)
            Text(
                code,
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
            )
            Text(
                "Buka WhatsApp di HP ini -> Setelan -> Perangkat Tertaut -> " +
                    "Tautkan dengan nomor telepon -> masukkan kode di atas.",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun QrCard(qrDataUrl: String?) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (qrDataUrl == null) {
                CircularProgressIndicator()
                Text("Menunggu QR...")
            } else {
                val base64 = qrDataUrl.substringAfter(",")
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                    ?: createBitmap(1, 1)
                Image(
                    bitmap = bitmap.asImageBitmap(),
                    contentDescription = "QR Code WhatsApp",
                    modifier = Modifier.size(220.dp),
                )
            }
        }
    }
}
