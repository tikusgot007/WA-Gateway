<#
  stop.ps1 -- hentikan Evolution dan adapter (keduanya Windows Service).

  Evolution & adapter dihentikan lewat Stop-Service (bukan lagi pencarian proses
  pemilik port). PostgreSQL (service) secara bawaan TIDAK dihentikan; pakai
  -StopPostgres kalau memang ingin mematikannya juga.

  Pemeriksaan port di akhir tetap dipertahankan sebagai jaring pengaman
  independen: kalau port stack masih listen setelah service dihentikan, skrip
  keluar dengan kode 1 (tidak melaporkan sukses palsu).
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = 'C:\AuliaGateway',
  [string]$PgService = 'postgresql-auliagw',
  [string]$EvolutionServiceName = 'AuliaGatewayEvolution',
  [string]$AdapterServiceName = 'AuliaGatewayAdapter',
  [int]$PgPort = 5432,
  [int]$EvolutionPort = 8080,
  [int]$AdapterPort = 3000,
  [switch]$StopPostgres,
  [string]$LogPath
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'lib\common.ps1')

$logDir = Join-Path $InstallRoot 'logs'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
if (-not $LogPath) { $LogPath = Join-Path $logDir 'stop.log' }
Initialize-AuliaLog -Path $LogPath -Reset

function Stop-ServiceSafe {
  param(
    [string]$Name,
    [string]$Label
  )
  $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $svc) { Write-Log ($Label + ': service ' + $Name + ' tidak terdaftar (dilewati).'); return }
  if ($svc.Status -eq 'Stopped') { Write-Log ($Label + ': sudah Stopped.'); return }
  Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
  foreach ($i in 1..15) {
    if ((Get-Service -Name $Name).Status -eq 'Stopped') { break }
    Start-Sleep -Seconds 1
  }
  $final = (Get-Service -Name $Name).Status
  Write-Log ($Label + ': Stop-Service selesai, status=' + $final + '.')
}

Write-Log '=== STOP STACK GATEWAY ==='
Stop-ServiceSafe -Name $AdapterServiceName -Label 'adapter'
Stop-ServiceSafe -Name $EvolutionServiceName -Label 'evolution'

if ($StopPostgres) {
  $svc = Get-Service -Name $PgService -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -eq 'Running') {
    Stop-Service -Name $PgService -Force
    Write-Log ('postgres: service ' + $PgService + ' dihentikan.')
  }
}

# Jangan laporkan sukses palsu: kalau port stack masih listen, keluar kode 1.
$failed = $false
foreach ($p in @($AdapterPort, $EvolutionPort)) {
  if (Test-Listen -Port $p) { Write-Log ('GAGAL: port ' + $p + ' masih listen.'); $failed = $true }
}
if ($failed) { Write-Log '=== SELESAI DENGAN MASALAH ==='; exit 1 }
Write-Log '=== SELESAI ==='
exit 0
