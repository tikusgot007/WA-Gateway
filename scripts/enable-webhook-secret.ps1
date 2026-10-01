<#
  enable-webhook-secret.ps1 -- aktifkan validasi secret pada webhook adapter
  untuk deployment yang SUDAH berjalan (mis. aulia3).

  Urutannya sengaja begini supaya tidak ada jendela pesan hilang:
    1. Tulis EVOLUTION_WEBHOOK_SECRET ke .env adapter (adapter yang sedang
       jalan belum membacanya, jadi masih menerima webhook apa pun).
    2. Daftarkan ulang webhook ke Evolution MEMBAWA header secret tersebut
       (proses baru membaca .env yang sudah diperbarui).
    3. Restart adapter supaya mulai mewajibkan header itu.

  Setelah langkah 2 Evolution sudah mengirim header, dan adapter lama
  mengabaikannya; setelah langkah 3 adapter memvalidasinya. Tidak ada momen
  webhook ditolak.

  Output: D:\kilo\enable-webhook-secret.log
#>
[CmdletBinding()]
param(
  [string]$AdapterDir = 'D:\evolution-gateway',
  [string]$WebhookUrl = 'http://127.0.0.1:3000/evolution/webhook',
  [string]$NodeExe    = 'D:\node\node.exe',
  [string]$RestartScript = 'D:\kilo\restart-adapter.ps1',
  [string]$LogPath    = 'D:\kilo\enable-webhook-secret.log'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null
Set-Content -LiteralPath $LogPath -Value ''
function L { param([string]$m) Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) }

function New-Hex {
  param([int]$Bytes)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $buf = New-Object byte[] $Bytes; $rng.GetBytes($buf) } finally { $rng.Dispose() }
  return (($buf | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Invoke-Native {
  param([string]$Exe, [string[]]$NativeArgs, [string]$Label)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = @(); $code = 0
  try {
    $out = @(& $Exe @NativeArgs 2>&1 | ForEach-Object { $_.ToString() })
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  foreach ($line in $out) { L ($Label + ': ' + $line) }
  L ($Label + ' [exit=' + $code + ']')
  return $code
}

try {
  L '=== ENABLE WEBHOOK SECRET ==='
  $envFile = Join-Path $AdapterDir '.env'
  if (-not (Test-Path -LiteralPath $envFile)) { throw "Tidak ada $envFile" }

  $lines = Get-Content -LiteralPath $envFile
  $found = $false
  $sudahAda = $false
  $baru = @()
  foreach ($line in $lines) {
    if ($line -match '^EVOLUTION_WEBHOOK_SECRET\s*=\s*(.*)$') {
      $found = $true
      if ($Matches[1].Trim()) { $sudahAda = $true; $baru += $line }
      else { $baru += ('EVOLUTION_WEBHOOK_SECRET=' + (New-Hex -Bytes 32)) }
      continue
    }
    $baru += $line
  }
  if (-not $found) { $baru += ('EVOLUTION_WEBHOOK_SECRET=' + (New-Hex -Bytes 32)) }

  if ($sudahAda) {
    L 'secret sudah terisi di .env (tidak diubah).'
  } else {
    [IO.File]::WriteAllLines($envFile, $baru, (New-Object System.Text.UTF8Encoding($false)))
    L 'secret baru ditulis ke .env adapter (nilai tidak dicetak).'
  }

  # 2. Daftarkan ulang webhook ke Evolution, membawa header secret.
  Push-Location -LiteralPath $AdapterDir
  try {
    $env:WEBHOOK_PUBLIC_URL = $WebhookUrl
    $code = Invoke-Native -Exe $NodeExe -NativeArgs @('scripts\set-webhook.js') -Label 'set-webhook'
  } finally { Pop-Location }
  if ($code -ne 0) { throw "set-webhook gagal (exit $code)" }

  # 3. Restart adapter supaya mulai memvalidasi secret.
  $rc = Invoke-Native -Exe 'powershell.exe' -Label 'restart-adapter' -NativeArgs @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $RestartScript)
  if ($rc -ne 0) { throw "restart-adapter gagal (exit $rc)" }

  L '=== SELESAI ==='
} catch {
  L ('GAGAL: ' + $_.Exception.Message)
  exit 1
}