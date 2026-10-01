<#
  create-instance.ps1 -- run ON aulia3 (as SYSTEM via scheduled task).

  Creates the WhatsApp instance in Evolution if it does not exist yet, using
  the API key and instance name from the Evolution .env. Idempotent.

  The QR / pairing code is NOT printed or saved by this script: pairing must
  be done by the operator from the Evolution Manager UI on the LAN, because
  whoever sees the QR can link a device to the number.

  Output: D:\kilo\create-instance.log
#>
[CmdletBinding()]
param(
  [string]$EvolutionEnv = 'D:\evolution-api-server\.env',
  [string]$EvolutionUrl = 'http://127.0.0.1:8080',
  [string]$InstanceName = 'aulia-toko',
  [string]$LogPath      = 'D:\kilo\create-instance.log'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null
Set-Content -LiteralPath $LogPath -Value ''
function L { param([string]$m) Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) }

function Get-EnvValue {
  param([string]$Path, [string]$Key)
  $line = Select-String -LiteralPath $Path -Pattern ('^' + [regex]::Escape($Key) + '\s*=') | Select-Object -First 1
  if (-not $line) { return $null }
  return (($line.Line -split '=', 2)[1]).Trim().Trim("'").Trim('"')
}

try {
  L '=== CREATE EVOLUTION INSTANCE ==='
  $apiKey  = Get-EnvValue -Path $EvolutionEnv -Key 'AUTHENTICATION_API_KEY'
  if (-not $apiKey) { throw 'AUTHENTICATION_API_KEY tidak ada di .env Evolution' }

  # Use 127.0.0.1 rather than the LAN hostname: a scheduled task runs as SYSTEM
  # and calling this machine by name resolves to an IPv6 link-local address that
  # can stall the HTTP client.
  $root = $EvolutionUrl
  $instance = $InstanceName
  L ("evolution: $root  instance: $instance")
  $headers = @{ apikey = $apiKey; 'Content-Type' = 'application/json' }

  # Already there?
  $exists = $false
  try {
    $st = Invoke-RestMethod -Uri "$root/instance/connectionState/$instance" -Headers $headers -Method Get -TimeoutSec 15
    $exists = $true
    L ('instance sudah ada, state = ' + $st.instance.state)
  } catch {
    L ('instance belum ada (cek state: ' + $_.Exception.Message + ')')
  }

  if (-not $exists) {
    $body = @{ instanceName = $instance; integration = 'WHATSAPP-BAILEYS'; qrcode = $true } | ConvertTo-Json
    $created = Invoke-RestMethod -Uri "$root/instance/create" -Headers $headers -Method Post -Body $body -TimeoutSec 30
    L ('instance dibuat: ' + $created.instance.instanceName + ' status=' + $created.instance.status)
  }

  # Summary of what the operator must do next.
  $st2 = $null
  try { $st2 = Invoke-RestMethod -Uri "$root/instance/connectionState/$instance" -Headers $headers -Method Get -TimeoutSec 15 } catch { }
  $state = if ($st2) { $st2.instance.state } else { 'unknown' }
  L ('state akhir: ' + $state)
  if ($state -ne 'open') {
    L 'BELUM TERTAUT: buka Evolution Manager, instance aulia-toko, lalu scan QR / pakai pairing code.'
    L '  http://AULIA3:8080/manager'
  }
  L '=== SELESAI ==='
} catch {
  L ('GAGAL: ' + $_.Exception.Message)
  exit 1
}