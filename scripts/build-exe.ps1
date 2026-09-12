<#
Build "AuliaPos Gateway.exe" -- distribusi standalone untuk Windows.

Menghasilkan folder dist/AuliaPos Gateway/ berisi:
  - AuliaPos Gateway.exe   (launcher native kecil, lihat scripts/Launcher.cs)
  - run.cmd                (dipanggil launcher, lihat scripts/run.cmd)
  - node.exe               (portable, disalin dari Node.js yang terinstall)
  - seluruh source Gateway + Supervisor + node_modules (apa adanya)

TIDAK menyalin folder auth/ (session WhatsApp) atau .env yang berisi
credential asli secara default -- lihat catatan di akhir skrip ini.

Kenapa pendekatan ini (bukan pkg/nexe single-file exe): baileys adalah
package ESM murni, dan V8-snapshot yang dipakai pkg/nexe untuk membungkus
kode ke satu file .exe tidak kompatibel dengan cara Node me-resolve import
ESM di dalam snapshot (sudah diuji nyata: gagal dengan ERR_REQUIRE_ESM /
ERR_MODULE_NOT_FOUND). Pendekatan "node.exe portable + file asli di folder
yang sama" menjalankan kode PERSIS seperti `npm run supervisor` biasa,
jadi tidak ada risiko baru sama sekali.
#>

$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$distRoot = Join-Path $repoRoot 'dist'
$appDir = Join-Path $distRoot 'AuliaPos Gateway'

Write-Host "== Build AuliaPos Gateway.exe ==" -ForegroundColor Cyan

# --- 1) Cari node.exe yang akan disalin (portable) -------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw "node.exe tidak ditemukan di PATH. Install Node.js dulu untuk BUILD (Node tidak diperlukan lagi di komputer TUJUAN setelah exe jadi)."
}
$nodeExePath = $nodeCmd.Source
Write-Host "node.exe sumber: $nodeExePath"

# --- 2) Siapkan folder distribusi bersih ------------------------------------
if (Test-Path $appDir) {
    Remove-Item $appDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

# --- 3) Salin node.exe portable ---------------------------------------------
Copy-Item $nodeExePath (Join-Path $appDir 'node.exe') -Force

# --- 4) Salin source project (TANPA auth/, data/, logs/, test/, .git, dist) -
$itemsToCopy = @('src', 'supervisor', 'public', 'node_modules', 'package.json', 'package-lock.json', '.env.example')
foreach ($item in $itemsToCopy) {
    $src = Join-Path $repoRoot $item
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $appDir $item) -Recurse -Force
    }
}

# .env: salin HANYA jika sudah ada (berisi konfigurasi nyata) -- tidak dibuat
# otomatis dari .env.example supaya user tetap sadar perlu mengisi
# SUPERVISOR_TOKEN/CI4_GATEWAY_TOKEN sendiri kalau ini instalasi baru.
$envSrc = Join-Path $repoRoot '.env'
if (Test-Path $envSrc) {
    Copy-Item $envSrc (Join-Path $appDir '.env') -Force
    Write-Host "'.env' disalin apa adanya (berisi token/konfigurasi yang sudah ada)." -ForegroundColor Yellow
} else {
    Write-Host "Tidak ada .env di sumber -- copy .env.example ke .env manual di folder distribusi sebelum menjalankan exe." -ForegroundColor Yellow
}

# --- 5) Salin run.cmd --------------------------------------------------------
Copy-Item (Join-Path $PSScriptRoot 'run.cmd') (Join-Path $appDir 'run.cmd') -Force

# --- 6) Compile Launcher.cs -> "AuliaPos Gateway.exe" -----------------------
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path $csc)) {
    throw "csc.exe (.NET Framework compiler) tidak ditemukan. Diperlukan untuk build launcher exe."
}

$exeOut = Join-Path $appDir 'AuliaPos Gateway.exe'
& $csc /nologo /target:winexe /out:"$exeOut" (Join-Path $PSScriptRoot 'Launcher.cs')
if ($LASTEXITCODE -ne 0) {
    throw "Compile Launcher.cs gagal (exit code $LASTEXITCODE)."
}

Write-Host ""
Write-Host "Selesai. Distribusi ada di:" -ForegroundColor Green
Write-Host "  $appDir"
Write-Host ""
Write-Host "Copy SELURUH folder 'AuliaPos Gateway' itu (bukan cuma file .exe-nya) ke komputer tujuan," -ForegroundColor Yellow
Write-Host "lalu double-click 'AuliaPos Gateway.exe' di dalamnya." -ForegroundColor Yellow
