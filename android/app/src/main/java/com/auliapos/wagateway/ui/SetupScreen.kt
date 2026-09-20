package com.auliapos.wagateway.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.auliapos.wagateway.GatewayPrefs
import com.auliapos.wagateway.NodeBridge

/**
 * Layar pengaturan: port HTTP Gateway, base URL & token server POS
 * (AuliaPos CI4), dan opsi auto-start setelah HP reboot. Nilai-nilai ini
 * ditulis ke `.env` folder nodejs-project setiap Gateway distart --
 * lihat NodeBridge.writeEnvFile().
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SetupScreen(
    prefs: GatewayPrefs,
    onSaved: () -> Unit,
) {
    var port by remember { mutableStateOf(prefs.port.toString()) }
    var ci4BaseUrl by remember { mutableStateOf(prefs.ci4BaseUrl) }
    var ci4Token by remember { mutableStateOf(prefs.ci4GatewayToken) }
    var autoStart by remember { mutableStateOf(prefs.autoStartOnBoot) }

    Scaffold(topBar = { TopAppBar(title = { Text("Pengaturan Gateway") }) }) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "Pengaturan ini hanya perlu diisi sekali. Server POS (AuliaPos) " +
                    "HARUS berada di jaringan WiFi/LAN yang sama dengan HP ini.",
                style = MaterialTheme.typography.bodySmall,
            )

            if (NodeBridge.isNodeStarted()) {
                // Node.js yang sudah jalan HANYA baca .env sekali waktu start --
                // perubahan di layar ini tidak otomatis kepakai sampai app
                // benar-benar di-restart total (lihat NodeBridge.startIfNeeded()
                // dan android/README.md bagian Troubleshooting).
                Text(
                    "⚠️ Gateway sudah berjalan. Perubahan di sini BARU " +
                        "kepakai setelah app di-Force Stop (Setelan > Aplikasi > " +
                        "WA Gateway > Paksa berhenti) lalu dibuka lagi -- sekadar " +
                        "menutup app dari recent apps belum cukup.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            OutlinedTextField(
                value = port,
                onValueChange = { port = it.filter(Char::isDigit) },
                label = { Text("Port HTTP Gateway") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
            )

            OutlinedTextField(
                value = ci4BaseUrl,
                onValueChange = { ci4BaseUrl = it },
                label = { Text("URL Server POS (contoh: http://192.168.1.10/aulia)") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                modifier = Modifier.fillMaxWidth(),
            )

            OutlinedTextField(
                value = ci4Token,
                onValueChange = { ci4Token = it },
                label = { Text("Gateway Token (dari server POS)") },
                modifier = Modifier.fillMaxWidth(),
            )

            Row {
                Checkbox(checked = autoStart, onCheckedChange = { autoStart = it })
                Text(
                    "Otomatis jalan lagi setiap HP restart",
                    modifier = Modifier.padding(top = 12.dp),
                )
            }

            Button(
                onClick = {
                    prefs.port = port.toIntOrNull() ?: 3000
                    // Kesalahan input yang ternyata gampang terjadi: lupa tulis
                    // skema (http://) di URL POS -- fetch() di sisi Node akan
                    // gagal keras ("Failed to parse URL") kalau ini dibiarkan.
                    // Tambahkan otomatis di sini (mirror dari pengaman yang sama
                    // di src/config/index.js) supaya kesalahan ini tidak terjadi
                    // sama sekali, bukan cuma "gagal dengan lebih rapi".
                    val trimmedUrl = ci4BaseUrl.trim()
                    prefs.ci4BaseUrl = when {
                        trimmedUrl.isEmpty() -> trimmedUrl
                        trimmedUrl.matches(Regex("(?i)^https?://.*")) -> trimmedUrl
                        else -> "http://$trimmedUrl"
                    }
                    prefs.ci4GatewayToken = ci4Token
                    prefs.autoStartOnBoot = autoStart
                    prefs.setupCompleted = true
                    onSaved()
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Simpan & Mulai Gateway")
            }
        }
    }
}
