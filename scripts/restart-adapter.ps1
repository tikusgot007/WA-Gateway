<#
  restart-adapter.ps1 -- restart HANYA adapter (port 3000). Evolution (8080)
  dan PostgreSQL tidak disentuh.

  Pengaman sebelum mematikan:
  - Proses pemilik port 3000 HARUS node dengan command line yang menyebut
    adapter (src/app/evolution.js). Kalau tidak cocok, skrip berhenti TANPA
    mematikan apa pun -- jangan sampai port 3000 dipakai proses lain lalu ikut
    dibunuh hanya karena kebetulan memegang port itu.
  - Kalau setelah restart port 3000 tidak listen, skrip keluar kode 1 supaya
    task terjadwal tidak melaporkan sukses palsu.

  Output: D:\kilo\restart-adapter.log
#>
[CmdletBinding()]
param(
  [int]    $Port     = 3000,
  [string] $TaskName = 'AuliaAdapter',
  [string] $LogPath  = 'D:\kilo\restart-adapter.log'
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null
Set-Content -LiteralPath $LogPath -Value ''
function L { param([string]$m) Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) }

function Get-AdapterPids {
  param([int]$LocalPort)
  @(Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)
}

L '=== RESTART ADAPTER ==='

$targets = @()
foreach ($procId in (Get-AdapterPids -LocalPort $Port)) {
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if (-not $proc) { L ("  pid $procId sudah tidak ada"); continue }
  $cmdLine = $null
  try { $cmdLine = (Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction Stop).CommandLine }
  catch { L ("  pid $procId : tidak bisa baca command line -- " + $_.Exception.Message) }

  $looksLikeAdapter = ($proc.ProcessName -like 'node*') -and $cmdLine -and ($cmdLine -match 'evolution')
  if (-not $looksLikeAdapter) {
    L ("  BUKAN adapter: pid=$procId nama=$($proc.ProcessName) cmd=$cmdLine")
    continue
  }
  $targets += $procId
}

if ($targets.Count -eq 0) {
  L "  tidak ada proses adapter yang memegang port $Port (mungkin sudah mati)."
} else {
  foreach ($procId in $targets) {
    try { Stop-Process -Id $procId -Force -ErrorAction Stop; L ("  stop pid ${procId}: OK") }
    catch { L ("  stop pid $procId GAGAL: " + $_.Exception.Message) }
  }
}

# Pastikan port benar-benar bebas sebelum start ulang (hindari EADDRINUSE).
$bebas = $false
foreach ($i in 1..10) {
  Start-Sleep -Seconds 1
  if ((Get-AdapterPids -LocalPort $Port).Count -eq 0) { $bebas = $true; break }
}
if (-not $bebas) {
  L "GAGAL: port $Port masih dipakai setelah proses dihentikan."
  exit 1
}
L "  port $Port bebas."

$run = & schtasks /run /tn $TaskName 2>&1
L ("  schtasks /run $TaskName : " + ($run -join ' '))

$ok = $false
foreach ($i in 1..30) {
  Start-Sleep -Seconds 1
  $pids = Get-AdapterPids -LocalPort $Port
  if ($pids.Count -gt 0) { $ok = $true; L ("  port $Port listen setelah $i detik (pid=$($pids -join ','))"); break }
}

if (-not $ok) {
  L "GAGAL: port $Port tidak listen setelah 30 detik."
  if (Test-Path 'D:\kilo\logs\adapter.log') {
    Get-Content 'D:\kilo\logs\adapter.log' -Tail 10 | ForEach-Object { L ('  ' + $_) }
  }
  exit 1
}

Start-Sleep -Seconds 3
if (Test-Path 'D:\kilo\logs\adapter.log') {
  L '--- 3 baris terakhir adapter.log ---'
  Get-Content 'D:\kilo\logs\adapter.log' -Tail 3 | ForEach-Object { L ('  ' + $_) }
}
L '=== SELESAI ==='
exit 0