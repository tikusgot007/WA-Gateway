<#
  stop.ps1 -- hentikan Evolution dan adapter secara MANUAL.

  Pengaman (pola scripts/restart-adapter.ps1): proses pemilik port HANYA
  dimatikan kalau namanya node DAN command line-nya cocok dengan komponen
  yang dimaksud. Port yang dipakai proses lain TIDAK ikut dimatikan.

  PostgreSQL (service) secara bawaan TIDAK dihentikan; pakai -StopPostgres
  kalau memang ingin mematikannya juga.
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = 'C:\AuliaGateway',
  [string]$PgService = 'postgresql-auliagw',
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

function Stop-OwnedProcess {
  param(
    [int]$Port,
    [string]$Match,
    [string]$Label
  )
  $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)
  if ($pids.Count -eq 0) { Write-Log ($Label + ': tidak ada proses di port ' + $Port + ' (sudah mati).'); return }

  $killed = 0
  foreach ($procId in $pids) {
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    $cmd = $null
    try { $cmd = (Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $procId) -ErrorAction Stop).CommandLine } catch { }
    $isOurs = ($proc.ProcessName -like 'node*') -and $cmd -and ($cmd -match $Match)
    if (-not $isOurs) {
      Write-Log ('  ' + $Label + ': BUKAN proses kita -- pid=' + $procId + ' nama=' + $proc.ProcessName + ' cmd=' + $cmd + ' (dilewati)')
      continue
    }
    try { Stop-Process -Id $procId -Force -ErrorAction Stop; $killed++; Write-Log ('  ' + $Label + ': stop pid ' + $procId + ' OK') }
    catch { Write-Log ('  ' + $Label + ': stop pid ' + $procId + ' GAGAL: ' + $_.Exception.Message) }
  }

  foreach ($i in 1..15) {
    if (-not (Test-Listen -Port $Port)) { Write-Log ('  ' + $Label + ': port ' + $Port + ' bebas.'); return }
    Start-Sleep -Seconds 1
  }
  Write-Log ('  ' + $Label + ': PERINGATAN -- port ' + $Port + ' masih listen setelah 15 detik.')
}

Write-Log '=== STOP STACK GATEWAY ==='
Stop-OwnedProcess -Port $AdapterPort -Match 'evolution-gateway|src[\\/]app[\\/]evolution\.js' -Label 'adapter'
Stop-OwnedProcess -Port $EvolutionPort -Match 'evolution-api-server|src[\\/]main\.ts' -Label 'evolution'

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
