# check-env-parity.ps1 -- AC-5: .env adapter & Evolution berpasangan dan token
# dari parameter; nilai rahasia tidak bocor ke log.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Split-Path -Parent $here
$repo = Split-Path -Parent $installer
. (Join-Path $installer 'lib\common.ps1')

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('env-' + [guid]::NewGuid().ToString('N'))
$adapterDir = Join-Path $tmp 'evolution-gateway'
$evoDir = Join-Path $tmp 'evolution-api-server'
New-Item -ItemType Directory -Path $adapterDir -Force | Out-Null
New-Item -ItemType Directory -Path $evoDir -Force | Out-Null

# Template minimal; kunci yang tidak ada akan ditambahkan oleh setup-env.
[IO.File]::WriteAllLines((Join-Path $adapterDir '.env.example'), @('CI4_BASE_URL=', 'CI4_GATEWAY_TOKEN=', 'EVOLUTION_BASE_URL='), (New-Object System.Text.UTF8Encoding($false)))
[IO.File]::WriteAllLines((Join-Path $evoDir 'env.example'), @('DATABASE_CONNECTION_URI=', 'AUTHENTICATION_API_KEY='), (New-Object System.Text.UTF8Encoding($false)))

$log = Join-Path $tmp 'setup-env.log'
$token = 'test-token-parity-123'
# Installer meneruskan token lewat environment (bukan command line); uji jalur itu.
$env:CI4_GATEWAY_TOKEN_INPUT = $token
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'scripts\setup-env.ps1') `
  -AdapterDir $adapterDir -EvolutionDir $evoDir `
  -EvolutionEnvTemplate (Join-Path $evoDir 'env.example') -LogPath $log | Out-Null
$code = $LASTEXITCODE
Remove-Item Env:\CI4_GATEWAY_TOKEN_INPUT -ErrorAction SilentlyContinue

$adapterEnv = Join-Path $adapterDir '.env'
$evolutionEnv = Join-Path $evoDir '.env'
$apiKeyA = Get-EnvValue -Path $adapterEnv -Key 'EVOLUTION_API_KEY'
$apiKeyE = Get-EnvValue -Path $evolutionEnv -Key 'AUTHENTICATION_API_KEY'
$tokenA = Get-EnvValue -Path $adapterEnv -Key 'CI4_GATEWAY_TOKEN'

$logText = if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Raw } else { '' }
$leak = ($logText -like ('*' + $apiKeyA + '*')) -or ($logText -like ('*' + $token + '*'))

$ok = ($code -eq 0) -and ($apiKeyA -and $apiKeyA -eq $apiKeyE) -and ($tokenA -eq $token) -and (-not $leak)
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
if ($ok) { Write-Host 'PASS check-env-parity (AC-5)'; exit 0 }
Write-Host ("FAIL check-env-parity (AC-5): code=$code keyMatch=$($apiKeyA -eq $apiKeyE) tokenMatch=$($tokenA -eq $token) leak=$leak")
exit 1
