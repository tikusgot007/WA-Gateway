<#
  status.ps1 -- status stack gateway: service PostgreSQL, port listen,
  proses pemilik, status instance Evolution, dan ekor log.

  Keluar dengan kode 1 kalau salah satu dari pg/evolution/adapter tidak
  listen, supaya tidak melaporkan sukses palsu.
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

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'lib\common.ps1')

$logDir = Join-Path $InstallRoot 'logs'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
if (-not $LogPath) { $LogPath = Join-Path $logDir 'status.log' }
Initialize-AuliaLog -Path $LogPath -Reset

Write-Log '=== STATUS STACK GATEWAY ==='
Write-Log ('waktu: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

Write-Log '--- service PostgreSQL ---'
$svc = Get-Service -Name $PgService -ErrorAction SilentlyContinue
if ($svc) { Write-Log ('  ' + $PgService + ': ' + $svc.Status + ' (start=' + $svc.StartType + ')') }
else { Write-Log ('  ' + $PgService + ': tidak terdaftar') }

Write-Log '--- service Evolution/adapter ---'
foreach ($svcName in @($EvolutionServiceName, $AdapterServiceName)) {
  $s = Get-Service -Name $svcName -ErrorAction SilentlyContinue
  if ($s) { Write-Log ('  ' + $svcName + ': ' + $s.Status + ' (start=' + $s.StartType + ')') }
  else { Write-Log ('  ' + $svcName + ': tidak terdaftar') }
}

Write-Log '--- port listen ---'
foreach ($p in @($PgPort, $EvolutionPort, $AdapterPort)) {
  $conns = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
  if ($conns.Count -eq 0) { Write-Log ('  ' + $p + ': TIDAK listen'); continue }
  $names = @($conns | ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } | Select-Object -Unique)
  Write-Log ('  ' + $p + ': LISTEN pid=' + (($conns | ForEach-Object { $_.OwningProcess }) -join ',') + ' (' + ($names -join ',') + ')')
}

Write-Log '--- instance Evolution ---'
$adapterEnv = Join-Path $InstallRoot 'evolution-gateway\.env'
$base = Get-EnvValue -Path $adapterEnv -Key 'EVOLUTION_BASE_URL'
$apiKey = Get-EnvValue -Path $adapterEnv -Key 'EVOLUTION_API_KEY'
$instance = Get-EnvValue -Path $adapterEnv -Key 'EVOLUTION_INSTANCE'
if ($base -and $apiKey -and $instance) {
  try {
    $state = Invoke-RestMethod -Uri ($base.TrimEnd('/') + '/instance/connectionState/' + $instance) -Headers @{ apikey = $apiKey } -Method Get -TimeoutSec 10
    Write-Log ('  ' + $instance + ': state=' + $state.instance.state)
  } catch { Write-Log ('  ' + $instance + ': tidak bisa dibaca (' + $_.Exception.Message + ')') }
} else { Write-Log '  (config Evolution tidak lengkap di .env adapter)'; }

Write-Log '--- ekor log ---'
foreach ($f in @('adapter.out.log', 'adapter.err.log', 'evolution.err.log')) {
  $path = Join-Path $logDir $f
  if (Test-Path -LiteralPath $path) {
    Write-Log ('  [' + $f + ']')
    Get-Content -LiteralPath $path -Tail 3 | ForEach-Object { Write-Log ('    ' + $_) }
  }
}

$pgUp = Test-Listen -Port $PgPort
$evoUp = Test-Listen -Port $EvolutionPort
$adUp = Test-Listen -Port $AdapterPort
Write-Log ('--- ringkasan: pg=' + $pgUp + ' evolution=' + $evoUp + ' adapter=' + $adUp + ' ---')
if ($pgUp -and $evoUp -and $adUp) { Write-Log 'OK'; exit 0 }
Write-Log 'ADA KOMPONEN YANG TIDAK LISTEN'
exit 1
