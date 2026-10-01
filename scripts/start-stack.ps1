<#
  start-stack.ps1 -- run ON aulia3 (as SYSTEM via scheduled task).

  Prepares the Evolution database schema, then starts Evolution API (8080)
  and the adapter (3000) and waits until both answer.

  Idempotent: migrations are applied with `prisma migrate deploy`, which is
  safe to re-run. Services are only started if not already listening.

  Uses D:\node\node.exe (a copy of the same portable Node that the old
  WA-Gateway shipped) so this stack does not depend on D:\WA-Gateway.

  Output: D:\kilo\start-stack.log
#>
[CmdletBinding()]
param(
  [string]$LogPath        = 'D:\kilo\start-stack.log',
  [string]$NodeExe        = 'D:\node\node.exe',
  [string]$EvolutionDir   = 'D:\evolution-api-server',
  [string]$AdapterDir     = 'D:\evolution-gateway',
  [int]   $EvolutionPort  = 8080,
  [int]   $AdapterPort    = 3000
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null
Set-Content -LiteralPath $LogPath -Value ''
function L { param([string]$m) Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) }

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
  return [pscustomobject]@{ Output = $out; Code = $code }
}

# Prisma only loads .env from its working directory, and a scheduled task
# starts in C:\Windows\System32. Load the .env explicitly so the CLI sees
# DATABASE_CONNECTION_URI no matter how this script was launched.
function Import-DotEnv {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { throw "File .env tidak ditemukan: $Path" }
  $count = 0
  foreach ($line in (Get-Content -LiteralPath $Path)) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    $idx = $t.IndexOf('=')
    if ($idx -lt 1) { continue }
    $key = $t.Substring(0, $idx).Trim()
    $val = $t.Substring($idx + 1).Trim().Trim("'").Trim('"')
    if ($key -match '^[A-Za-z_][A-Za-z0-9_]*$') { Set-Item -Path ("Env:" + $key) -Value $val; $count++ }
  }
  L ("env: $count variabel dimuat dari " + $Path)
}

function Test-Port {
  param([int]$Port)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne(1500)) { return $false }
    $client.EndConnect($ar); return $true
  } catch { return $false } finally { $client.Close() }
}

function Wait-Port {
  param([int]$Port, [int]$Seconds)
  foreach ($i in 1..$Seconds) {
    Start-Sleep -Seconds 1
    if (Test-Port -Port $Port) { return $true }
  }
  return $false
}

function Start-NodeApp {
  param([string]$Name, [string]$Dir, [string]$Entry, [int]$Port)
  if (Test-Port -Port $Port) { L "$Name sudah listen di $Port, dilewati."; return }
  $stdout = "D:\kilo\logs\$Name.out.log"
  $stderr = "D:\kilo\logs\$Name.err.log"
  New-Item -ItemType Directory -Path (Split-Path -Parent $stdout) -Force | Out-Null
  $p = Start-Process -FilePath $NodeExe -ArgumentList $Entry -WorkingDirectory $Dir `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -WindowStyle Hidden
  L ("${Name}: pid " + $p.Id + " dijalankan (" + $Entry + '), cwd=' + $Dir)
  if (Wait-Port -Port $Port -Seconds 60) { L "${Name}: port $Port siap." }
  else {
    L "${Name}: TIDAK listen di $Port setelah 60 detik."
    if (Test-Path $stderr) { Get-Content $stderr -Tail 20 | ForEach-Object { L ("  err: " + $_) } }
    throw "$Name gagal start"
  }
}

try {
  L '=== START STACK EVOLUTION GATEWAY ==='
  L ('computer: ' + $env:COMPUTERNAME + ' user: ' + $env:USERNAME)
  if (-not (Test-Path -LiteralPath $NodeExe)) { throw "Node tidak ditemukan: $NodeExe" }
  $nv = Invoke-Native -Exe $NodeExe -Label 'node' -NativeArgs @('-v')
  if ($nv.Code -ne 0) { throw 'node.exe tidak bisa dijalankan' }

  # --- Evolution database schema ------------------------------------------
  $prismaCli = Join-Path $EvolutionDir 'node_modules\prisma\build\index.js'
  $schema    = Join-Path $EvolutionDir 'prisma\postgresql-schema.prisma'
  if (-not (Test-Path $prismaCli)) { throw "Prisma CLI tidak ditemukan: $prismaCli" }
  if (-not (Test-Path $schema))    { throw "Schema tidak ditemukan: $schema" }

  $srcMigrations = Join-Path $EvolutionDir 'prisma\postgresql-migrations'
  $dstMigrations = Join-Path $EvolutionDir 'prisma\migrations'
  if (Test-Path $srcMigrations) {
    Remove-Item -LiteralPath $dstMigrations -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $srcMigrations -Destination $dstMigrations -Recurse -Force
    L ('migrations: ' + (Get-ChildItem $dstMigrations -Directory).Count + ' folder disalin ke prisma\migrations')
  }

  $env:DATABASE_PROVIDER = 'postgresql'
  Import-DotEnv -Path (Join-Path $EvolutionDir '.env')
  if (-not $env:DATABASE_CONNECTION_URI) { throw 'DATABASE_CONNECTION_URI kosong setelah memuat .env' }
  Push-Location -LiteralPath $EvolutionDir
  try {
    $mig = Invoke-Native -Exe $NodeExe -Label 'prisma migrate' -NativeArgs @($prismaCli, 'migrate', 'deploy', '--schema', $schema)
  } finally {
    Pop-Location
  }
  if ($mig.Code -ne 0) { throw "prisma migrate deploy gagal (exit $($mig.Code))" }
  L 'skema database Evolution siap.'

  # --- start both services -------------------------------------------------
  $tsxCli = Join-Path $EvolutionDir 'node_modules\tsx\dist\cli.mjs'
  if (-not (Test-Path $tsxCli)) { throw "tsx CLI tidak ditemukan: $tsxCli" }
  Start-NodeApp -Name 'evolution' -Dir $EvolutionDir -Entry "$tsxCli .\src\main.ts" -Port $EvolutionPort
  Start-NodeApp -Name 'adapter'   -Dir $AdapterDir   -Entry '.\src\app\evolution.js' -Port $AdapterPort

  L '=== SELESAI ==='
} catch {
  L ('GAGAL: ' + $_.Exception.Message)
  if ($_.InvocationInfo -and $_.InvocationInfo.Line) { L ('  pada: ' + $_.InvocationInfo.Line.Trim()) }
  exit 1
}