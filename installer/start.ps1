<#
  start.ps1 -- jalankan stack gateway (PostgreSQL service + Evolution + adapter)
  secara MANUAL. Tanpa scheduled task / watchdog (lihat requirement 2026-10-02).

  Idempotent: komponen yang portnya sudah listen dilewati, jadi aman
  dijalankan berkali-kali.
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = 'C:\AuliaGateway',
  [string]$PgService = 'postgresql-auliagw',
  [int]$PgPort = 5432,
  [int]$EvolutionPort = 8080,
  [int]$AdapterPort = 3000,
  [string]$NodeExe,
  [string]$LogPath
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'lib\common.ps1')

$evolutionDir = Join-Path $InstallRoot 'evolution-api-server'
$adapterDir = Join-Path $InstallRoot 'evolution-gateway'
$logDir = Join-Path $InstallRoot 'logs'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
if (-not $LogPath) { $LogPath = Join-Path $logDir 'start.log' }
Initialize-AuliaLog -Path $LogPath -Reset

function Start-StackApp {
  param(
    [string]$Name,
    [string]$Dir,
    [string]$Entry,
    [int]$Port,
    [int]$GraceSec
  )
  if (Test-Listen -Port $Port) { Write-Log ($Name + ': sudah listen di ' + $Port + ', dilewati.'); return }
  if (-not (Test-Path -LiteralPath $Dir)) { throw ($Name + ': folder tidak ditemukan: ' + $Dir) }
  $stdout = Join-Path $logDir ($Name + '.out.log')
  $stderr = Join-Path $logDir ($Name + '.err.log')
  $p = Start-Process -FilePath $script:Node -ArgumentList $Entry -WorkingDirectory $Dir `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -WindowStyle Hidden
  Write-Log ($Name + ': pid ' + $p.Id + ' dijalankan (' + $Entry + '), cwd=' + $Dir)
  if (Wait-Listen -Port $Port -Seconds $GraceSec) { Write-Log ($Name + ': port ' + $Port + ' siap.') }
  else {
    Write-Log ($Name + ': TIDAK listen di ' + $Port + ' setelah ' + $GraceSec + ' detik.')
    if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Tail 20 | ForEach-Object { Write-Log ('  err: ' + $_) } }
    throw ($Name + ' gagal start')
  }
}

try {
  Write-Log '=== START STACK GATEWAY ==='
  Write-Log ('computer: ' + $env:COMPUTERNAME + ' user: ' + $env:USERNAME)

  if ($NodeExe) { $script:Node = $NodeExe }
  else {
    $tools = Resolve-NodeTools
    if (-not $tools.Node) { throw 'Node.js tidak ditemukan di PATH.' }
    $script:Node = $tools.Node.Source
  }
  Write-Log ('node: ' + $script:Node)

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

  # 2. Evolution, lalu 3. adapter.
  Start-StackApp -Name 'evolution' -Dir $evolutionDir -Entry 'node_modules\tsx\dist\cli.mjs src\main.ts' -Port $EvolutionPort -GraceSec 420
  Start-StackApp -Name 'adapter' -Dir $adapterDir -Entry 'src\app\evolution.js' -Port $AdapterPort -GraceSec 90

  Write-Log '=== SELESAI ==='
  exit 0
} catch {
  Write-Log ('GAGAL: ' + $_.Exception.Message)
  exit 1
}
