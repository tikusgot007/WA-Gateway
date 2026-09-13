package com.auliapos.wagateway.ui

import android.annotation.SuppressLint
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

/**
 * Dashboard test Gateway yang SUDAH ADA (public/index.html dkk, di-serve
 * oleh Express) ditampilkan apa adanya lewat WebView, supaya tidak perlu
 * menulis ulang UI-nya versi native -- konsisten 1:1 dengan versi desktop.
 * Hanya dipakai SETELAH WhatsApp connected (lihat MonitorScreen).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen(port: Int, onOpenSetup: () -> Unit) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Dashboard Gateway") },
                actions = {
                    IconButton(onClick = onOpenSetup) {
                        Icon(Icons.Filled.Settings, contentDescription = "Pengaturan")
                    }
                },
            )
        },
    ) { padding ->
        GatewayWebView(
            url = "http://127.0.0.1:$port/",
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        )
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun GatewayWebView(url: String, modifier: Modifier = Modifier) {
    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                webViewClient = WebViewClient()
                loadUrl(url)
            }
        },
        update = { webView -> if (webView.url != url) webView.loadUrl(url) },
    )
}
