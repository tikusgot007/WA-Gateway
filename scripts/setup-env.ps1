<#
  setup-env.ps1 -- run ON the gateway PC (aulia3), typically as SYSTEM.

  Generates one shared Evolution API key and writes two paired .env files:
    - <EvolutionDir>\.env   (Evolution API server)
    - <AdapterDir>\.env     (evolution-gateway adapter)

  Secrets are generated locally with a CSPRNG and never leave this machine.
  The CI4 gateway token is copied from the existing old gateway .env so
  AuliaPos needs no change.

  The PostgreSQL application-role password is generated here and embedded in
  the Evolution DATABASE_CONNECTION_URI; install-postgres.ps1 reads it back
  from there so the role and the .env can never disagree.

  Idempotent: existing .env files are kept unless -Force is given.

  Usage:
    powershell -ExecutionPolicy Bypass -File D:\evolution-gateway\scripts\setup-env.ps1
#>
[CmdletBinding()]
param(
  [string]$AdapterDir     = 'D:\evolution-gateway',
  [string]$EvolutionDir   = 'D:\evolution-api-server',
  [string]$OldGatewayEnv  = 'D:\WA-Gateway\.env',
  [string]$Ci4BaseUrl     = 'http://AULIA-SERVER2/aulia',
  [string]$InstanceName   = 'aulia-toko',
  [string]$PgHost         = '127.0.0.1',
  [int]   $PgPort         = 5432,
  [string]$PgDatabase     = 'evolution_gateway_pg',
  [string]$PgUser         = 'evolution_gw',
  [string]$EvolutionUrl   = 'http://AULIA3:8080',
  [string]$AdapterHost    = '0.0.0.0',
  [int]   $AdapterPort    = 3000,
  [int]   $EvolutionPort  = 8080,
  [string]$LogPath        = 'D:\kilo\setup-env.log',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null
Set-Content -LiteralPath $LogPath -Value ''

function Say {
  param([string]$Message, [string]$Color = 'Gray')
  Write-Host $Message
  Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $Message)
}

function New-Hex {
  param([int]$Bytes)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $buf = New-Object byte[] $Bytes
    $rng.GetBytes($buf)
  } finally {
    $rng.Dispose()
  }
  return (($buf | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-EnvValue {
  param([string]$Path, [string]$Key)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $line = Select-String -LiteralPath $Path -Pattern ('^' + [regex]::Escape($Key) + '\s*=') | Select-Object -First 1
  if (-not $line) { return $null }
  return (($line.Line -split '=', 2)[1]).Trim()
}

# Replace the value of known keys in place, preserving comments and ordering.
# Keys absent from the source are appended at the end.
function Set-EnvLines {
  param([string[]]$Lines, [hashtable]$Values)
  $seen = @{}
  $out = foreach ($line in $Lines) {
    if ($line -match '^([A-Za-z0-9_]+)\s*=') {
      $key = $Matches[1]
      if ($Values.ContainsKey($key)) {
        $seen[$key] = $true
        "$key=$($Values[$key])"
        continue
      }
    }
    $line
  }
  $missing = @($Values.Keys | Where-Object { -not $seen.ContainsKey($_) })
  if ($missing.Count -gt 0) {
    $out += ''
    $out += '# --- added by setup-env.ps1 ---'
    foreach ($key in $missing) { $out += "$key=$($Values[$key])" }
  }
  return $out
}

function Write-Utf8NoBom {
  param([string]$Path, [string[]]$Lines)
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [IO.File]::WriteAllLines($Path, $Lines, (New-Object System.Text.UTF8Encoding($false)))
}

$adapterEnv   = Join-Path $AdapterDir '.env'
$adapterEx    = Join-Path $AdapterDir '.env.example'
$evolutionEnv = Join-Path $EvolutionDir '.env'
$evolutionTpl = Join-Path $EvolutionDir '.env.template'

Say '=== SETUP ENV EVOLUTION GATEWAY ===' 'White'
Say ("computer: " + $env:COMPUTERNAME + " user: " + $env:USERNAME)

foreach ($ref in @($adapterEx, $evolutionTpl)) {
  if (-not (Test-Path -LiteralPath $ref)) { Say ("GAGAL: file acuan tidak ditemukan: " + $ref) 'Red'; throw "File acuan tidak ditemukan: $ref" }
}

# Reuse the token already trusted by AuliaPos production.
$ci4Token = Get-EnvValue -Path $OldGatewayEnv -Key 'CI4_GATEWAY_TOKEN'
if (-not $ci4Token) {
  Say ("PERINGATAN: CI4_GATEWAY_TOKEN tidak ada di " + $OldGatewayEnv + ' (dilinteractive saja bila dijalankan manual)') 'Yellow'
}
if (-not $ci4Token) { Say 'GAGAL: CI4_GATEWAY_TOKEN kosong.' 'Red'; throw 'CI4_GATEWAY_TOKEN kosong, dibatalkan.' }
Say ('CI4_GATEWAY_TOKEN: diambil dari .env gateway lama (panjang ' + $ci4Token.Length + ' karakter).')

$existing = @($adapterEnv, $evolutionEnv) | Where-Object { Test-Path -LiteralPath $_ }
if ($existing.Count -gt 0 -and -not $Force) {
  Say 'File .env berikut sudah ada dan TIDAK ditimpa:' 'Yellow'
  $existing | ForEach-Object { Say ('  ' + $_) 'Yellow' }
  Say 'Jalankan ulang dengan -Force kalau memang ingin menimpa.' 'Yellow'
  Say '=== SELESAI (dilewati) ===' 'Green'
  return
}

$apiKey     = New-Hex -Bytes 32
$pgPassword = New-Hex -Bytes 16
$dbUri      = "postgresql://${PgUser}:${pgPassword}@${PgHost}:${PgPort}/${PgDatabase}?schema=public"

$adapterValues = @{
  'CI4_BASE_URL'       = $Ci4BaseUrl
  'CI4_GATEWAY_TOKEN'  = $ci4Token
  'EVOLUTION_BASE_URL' = "http://127.0.0.1:$EvolutionPort"
  'EVOLUTION_API_KEY'  = $apiKey
  'EVOLUTION_INSTANCE' = $InstanceName
  'HOST'               = $AdapterHost
  'PORT'               = "$AdapterPort"
  'SQLITE_PATH'        = './data/evolution-gateway.sqlite'
  'MEDIA_STORE_DIR'    = './data/media'
  # Webhook TANPA secret berarti host LAN mana pun bisa menyuntikkan pesan
  # "masuk" palsu ke Inbox POS. Selalu diisi; nilainya didaftarkan ke Evolution
  # oleh setup-instance.js (lewat `headers`).
  'EVOLUTION_WEBHOOK_SECRET' = (New-Hex -Bytes 32)
}
$adapterLines = Set-EnvLines -Lines (Get-Content -LiteralPath $adapterEx) -Values $adapterValues
Write-Utf8NoBom -Path $adapterEnv -Lines $adapterLines
Say ('adapter .env ditulis  : ' + $adapterEnv)

$evolutionValues = @{
  'SERVER_PORT'                    = "$EvolutionPort"
  'SERVER_URL'                     = $EvolutionUrl
  'AUTHENTICATION_API_KEY'         = $apiKey
  'DATABASE_PROVIDER'              = 'postgresql'
  'DATABASE_CONNECTION_URI'        = "'$dbUri'"
  'DATABASE_SAVE_DATA_NEW_MESSAGE' = 'true'
  'CACHE_REDIS_ENABLED'            = 'false'
  'CACHE_LOCAL_ENABLED'            = 'true'
}
$evolutionLines = Set-EnvLines -Lines (Get-Content -LiteralPath $evolutionTpl) -Values $evolutionValues
Write-Utf8NoBom -Path $evolutionEnv -Lines $evolutionLines
Say ('evolution .env ditulis: ' + $evolutionEnv)

# Verify both files really carry the same key before declaring success.
$checkAdapter = (Get-EnvValue -Path $adapterEnv -Key 'EVOLUTION_API_KEY')
$checkEvol    = (Get-EnvValue -Path $evolutionEnv -Key 'AUTHENTICATION_API_KEY')
if ($checkAdapter -ne $apiKey -or $checkEvol -ne $apiKey) {
  Say 'GAGAL: verifikasi key tidak cocok setelah penulisan.' 'Red'
  throw 'Verifikasi key gagal.'
}
Say ('API key: 64 hex, identik di kedua .env (tidak dicetak).')
Say ('PostgreSQL: user ' + $PgUser + ' / db ' + $PgDatabase + ' -- password ada di .env Evolution.')
Say 'Langkah berikutnya: jalankan install-postgres.ps1 (membaca password dari .env itu).'
Say ('Manager UI : ' + $EvolutionUrl + '/manager')
Say ('Webhook    : http://AULIA3:' + $AdapterPort + '/evolution/webhook')
Say '=== SELESAI ===' 'Green'