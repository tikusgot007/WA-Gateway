<#
  start.ps1 -- nyalakan stack gateway: PostgreSQL + Evolution + adapter, ketiganya
  sebagai Windows Service. Evolution & adapter didaftarkan oleh install.ps1
  (WinSW); skrip ini hanya memanggil Start-Service lalu menunggu port listen.

  Idempotent: service yang sudah Running dilewati, jadi aman dijalankan berkali-kali.
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
  [string]$LogPath
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'lib\common.ps1')

$logDir = Join-Path $InstallRoot 'logs'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
if (-not $LogPath) { $LogPath = Join-Path $logDir 'start.log' }
Initialize-AuliaLog -Path $LogPath -Reset

function Start-ServiceAndWait {
  param(
    [string]$Name,
    [int]$Port,
    [int]$GraceSec
  )
  $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $svc) { throw ($Name + ': service tidak terdaftar. Jalankan installer\install.ps1 dulu.') }
  if ($svc.Status -ne 'Running') {
    Start-Service -Name $Name
    Write-Log ($Name + ': Start-Service dipanggil.')
  } else {
    Write-Log ($Name + ': service sudah Running.')
  }
  if (Wait-Listen -Port $Port -Seconds $GraceSec) {
    Write-Log ($Name + ': port ' + $Port + ' siap.')
  } else {
    Write-Log ($Name + ': service Running tapi port ' + $Port + ' TIDAK listen setelah ' + $GraceSec + ' detik.')
    throw ($Name + ' gagal start (service Running, port tidak merespons)')
  }
}

try {
  Write-Log '=== START STACK GATEWAY ==='
  Write-Log ('computer: ' + $env:COMPUTERNAME + ' user: ' + $env:USERNAME)

  # 1. PostgreSQL (Windows service).
  if (-not (Test-Listen -Port $PgPort)) {
    $svc = Get-Service -Name $PgService -ErrorAction SilentlyContinue
    if ($svc) {
      if ($svc.Status -ne 'Running') { Start-Service -Name $PgService; Write-Log ('postgres: service ' + $PgService + ' dinyalakan.') }
    } else {
      Write-Log ('postgres: service ' + $PgService + ' tidak terdaftar (lewati; mungkin PG eksternal).')
    }
    if (-not (Wait-Listen -Port $PgPort -Seconds 60)) { throw ('PostgreSQL tidak listen di ' + $PgPort + '.') }
  } else { Write-Log ('postgres: sudah listen di ' + $PgPort + '.') }

  # 2. Evolution, lalu 3. adapter (keduanya Windows Service berbasis WinSW).
  Start-ServiceAndWait -Name $EvolutionServiceName -Port $EvolutionPort -GraceSec 420
  Start-ServiceAndWait -Name $AdapterServiceName -Port $AdapterPort -GraceSec 90

  Write-Log '=== SELESAI ==='
  exit 0
} catch {
  Write-Log ('GAGAL: ' + $_.Exception.Message)
  exit 1
}
