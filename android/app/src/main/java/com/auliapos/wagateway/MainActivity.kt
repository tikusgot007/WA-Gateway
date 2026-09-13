package com.auliapos.wagateway

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.auliapos.wagateway.ui.DashboardScreen
import com.auliapos.wagateway.ui.MonitorScreen
import com.auliapos.wagateway.ui.SetupScreen

private const val ROUTE_SETUP = "setup"
private const val ROUTE_MONITOR = "monitor"
private const val ROUTE_DASHBOARD = "dashboard"

class MainActivity : ComponentActivity() {

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* diabaikan kalau ditolak -- service tetap jalan, cuma tanpa notifikasi terlihat */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        requestNotificationPermissionIfNeeded()

        val prefs = GatewayPrefs(applicationContext)
        if (prefs.setupCompleted) {
            GatewayForegroundService.start(applicationContext)
        }

        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    val navController = rememberNavController()
                    AppNavHost(
                        navController = navController,
                        prefs = prefs,
                        onSetupSaved = {
                            GatewayForegroundService.start(applicationContext)
                        },
                    )
                }
            }
        }
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                this, Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }
}

@Composable
private fun AppNavHost(
    navController: NavHostController,
    prefs: GatewayPrefs,
    onSetupSaved: () -> Unit,
) {
    val startDestination = remember { if (prefs.setupCompleted) ROUTE_MONITOR else ROUTE_SETUP }

    NavHost(navController = navController, startDestination = startDestination) {
        composable(ROUTE_SETUP) {
            SetupScreen(
                prefs = prefs,
                onSaved = {
                    onSetupSaved()
                    navController.navigate(ROUTE_MONITOR) {
                        popUpTo(ROUTE_SETUP) { inclusive = true }
                    }
                },
            )
        }
        composable(ROUTE_MONITOR) {
            MonitorScreen(
                port = prefs.port,
                onOpenSetup = { navController.navigate(ROUTE_SETUP) },
                onConnected = {
                    navController.navigate(ROUTE_DASHBOARD) {
                        popUpTo(ROUTE_MONITOR) { inclusive = true }
                    }
                },
            )
        }
        composable(ROUTE_DASHBOARD) {
            DashboardScreen(
                port = prefs.port,
                onOpenSetup = {
                    navController.navigate(ROUTE_SETUP)
                },
            )
        }
    }
}
