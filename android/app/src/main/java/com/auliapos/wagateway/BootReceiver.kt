package com.auliapos.wagateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Menyalakan ulang GatewayForegroundService setelah HP restart, supaya
 * Gateway tidak perlu dibuka manual tiap kali listrik toko mati/HP
 * di-restart. Bisa dimatikan dari layar Setup (GatewayPrefs.autoStartOnBoot).
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val prefs = GatewayPrefs(context)
        if (prefs.setupCompleted && prefs.autoStartOnBoot) {
            GatewayForegroundService.start(context)
        }
    }
}
