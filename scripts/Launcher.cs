using System;
using System.Diagnostics;
using System.IO;

// Launcher native kecil untuk "AuliaPos Gateway.exe".
//
// TIDAK menjalankan business logic apa pun -- satu-satunya tugasnya adalah
// men-spawn run.cmd (di folder yang sama) tanpa menampilkan jendela
// console, lalu keluar. run.cmd sendiri yang menjalankan node.exe portable
// + supervisor/launcher.js (Supervisor/Control Panel) dari folder
// distribusi yang sama -- lihat scripts/run.cmd dan scripts/build-exe.ps1.
//
// Proses Node yang dihasilkan TIDAK ikut mati saat Launcher ini keluar
// (perilaku default Windows: child process yang di-spawn tanpa Job Object
// tetap hidup independen dari parent-nya) -- ini penting supaya
// Supervisor/Control Panel tetap berjalan di background walau window
// Launcher sudah tidak ada.
namespace AuliaPosGateway
{
    internal static class Launcher
    {
        private static void Main()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string runCmd = Path.Combine(baseDir, "run.cmd");

            if (!File.Exists(runCmd))
            {
                MessageBoxSafe("File run.cmd tidak ditemukan di:\n" + baseDir +
                    "\n\nInstalasi AuliaPos Gateway kemungkinan tidak lengkap.");
                return;
            }

            var psi = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = "/c \"" + runCmd + "\"",
                WorkingDirectory = baseDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
            };

            try
            {
                Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBoxSafe("Gagal menjalankan AuliaPos Gateway:\n" + ex.Message);
            }
        }

        // Pakai MessageBox lewat late-bound System.Windows.Forms supaya Launcher.cs
        // tidak butuh referensi System.Windows.Forms.dll saat compile (csc.exe
        // default reference set sudah cukup tanpa itu) -- kalau gagal load, fallback
        // diam-diam ke log file supaya Launcher tidak pernah crash tanpa jejak.
        private static void MessageBoxSafe(string message)
        {
            try
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                Directory.CreateDirectory(Path.Combine(baseDir, "logs"));
                File.AppendAllText(
                    Path.Combine(baseDir, "logs", "exe-launcher.log"),
                    DateTime.Now + " " + message + Environment.NewLine
                );
            }
            catch
            {
                // Jangan pernah biarkan logging kegagalan ikut melempar exception.
            }
        }
    }
}
