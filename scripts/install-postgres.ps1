<#
  install-postgres.ps1 -- run ON aulia3 (as SYSTEM via scheduled task).

  Initializes a fresh PostgreSQL 16 cluster from the binaries already copied
  to D:\pgsql16, registers it as a Windows service, then creates the role and
  database used by Evolution.

  The application role password is NOT generated here: it is read from the
  DATABASE_CONNECTION_URI already written into the Evolution .env by
  setup-env.ps1, so the role and the .env can never disagree. Run
  setup-env.ps1 first.

  The PostgreSQL superuser password is generated locally (CSPRNG) and stored
  in D:\pgsql16\superuser.pwd.

  Idempotent: initdb / service registration / role / database creation are
  skipped when they already exist.

  NOTE on style: every native call goes through Invoke-Native. PowerShell 5.1
  turns a native command's stderr into an ErrorRecord, which - combined with
  $ErrorActionPreference = 'Stop' - aborts the script mid-way (this actually
  happened on the first run, right after initdb). Invoke-Native captures
  stderr as plain text and reports the real exit code instead.
#>
[CmdletBinding()]
param(
  [string]$PgRoot       = 'D:\pgsql16',
  [string]$DataDir      = 'D:\pgsql16\data',
  [string]$ServiceName  = 'postgresql-aulia3',
  [int]   $Port         = 5432,
  [string]$AppUser      = 'evolution_gw',
  [string]$AppDb        = 'evolution_gateway_pg',
  [string]$EvolutionEnv = 'D:\evolution-api-server\.env',
  [string]$LogPath      = 'D:\kilo\install-postgres.log'
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

# Run a native program, capturing stdout+stderr as text and the exit code.
function Invoke-Native {
  param([string]$Exe, [string[]]$NativeArgs, [string]$Label, [switch]$Quiet)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = @()
  $code = 0
  try {
    $out = @(& $Exe @NativeArgs 2>&1 | ForEach-Object { $_.ToString() })
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  if (-not $Quiet) {
    foreach ($line in $out) { L ($Label + ': ' + $line) }
    L ($Label + ' [exit=' + $code + ']')
  }
  return [pscustomobject]@{ Output = $out; Code = $code }
}

try {
  L '=== INSTALL POSTGRESQL (evolution gateway) ==='
  L ('computer: ' + $env:COMPUTERNAME + ' user: ' + $env:USERNAME)

  # --- application role password comes from the Evolution .env -------------
  if (-not (Test-Path -LiteralPath $EvolutionEnv)) {
    throw "Evolution .env tidak ditemukan: $EvolutionEnv (jalankan setup-env.ps1 dulu)"
  }
  $uriLine = Select-String -LiteralPath $EvolutionEnv -Pattern '^DATABASE_CONNECTION_URI=' | Select-Object -First 1
  if (-not $uriLine) { throw 'DATABASE_CONNECTION_URI tidak ditemukan di .env' }
  $uri = ($uriLine.Line -split '=', 2)[1].Trim().Trim("'").Trim('"')
  $m = [regex]::Match($uri, '^postgres(ql)?://(?<user>[^:/@]+):(?<pass>[^@]+)@')
  if (-not $m.Success) { throw 'format DATABASE_CONNECTION_URI tidak dikenali: ' + $uriLine.Line }
  $appPw = $m.Groups['pass'].Value
  if ($m.Groups['user'].Value -ne $AppUser) {
    L ('PERINGATAN: user di URI (' + $m.Groups['user'].Value + ') berbeda dari -AppUser (' + $AppUser + ')')
  }
  L 'password role: dibaca dari .env Evolution (tidak dicetak).'

  # --- binaries ------------------------------------------------------------
  $bin    = Join-Path $PgRoot 'bin'
  $initdb = Join-Path $bin 'initdb.exe'
  $pgctl  = Join-Path $bin 'pg_ctl.exe'
  $psql   = Join-Path $bin 'psql.exe'
  $isready= Join-Path $bin 'pg_isready.exe'
  foreach ($exe in @($initdb, $pgctl, $psql, $isready)) {
    if (-not (Test-Path -LiteralPath $exe)) { throw "Binary tidak ditemukan: $exe" }
  }

  # --- cluster -------------------------------------------------------------
  $pwFile = Join-Path $PgRoot 'superuser.pwd'
  $alreadyInit = Test-Path (Join-Path $DataDir 'PG_VERSION')

  if (-not $alreadyInit) {
    $superPw = New-Hex -Bytes 16
    Set-Content -LiteralPath $pwFile -Value $superPw -NoNewline
    L 'initdb: membuat cluster baru...'
    $pwTemp = Join-Path $PgRoot 'initdb.pwtmp'
    Set-Content -LiteralPath $pwTemp -Value $superPw -NoNewline
    $r = Invoke-Native -Exe $initdb -Label 'initdb' -NativeArgs @(
      '-D', $DataDir, '-U', 'postgres', "--pwfile=$pwTemp", '-E', 'UTF8', '--locale=C'
    )
    Remove-Item -LiteralPath $pwTemp -Force -ErrorAction SilentlyContinue
    if ($r.Code -ne 0) { throw "initdb gagal (exit $($r.Code))" }
    if (-not (Test-Path (Join-Path $DataDir 'PG_VERSION'))) { throw 'initdb keluar 0 tapi PG_VERSION tidak ada' }
    L 'initdb: selesai.'
  } else {
    $superPw = if (Test-Path $pwFile) { (Get-Content -LiteralPath $pwFile -Raw).Trim() } else { $null }
    L 'initdb: cluster sudah ada, dilewati.'
  }
  if (-not $superPw) { throw 'Password superuser tidak tersedia (D:\pgsql16\superuser.pwd hilang).' }

  # Localhost only: Evolution and the adapter run on this same machine, so the
  # database never needs to be reachable from the LAN.
  $confPath = Join-Path $DataDir 'postgresql.conf'
  $conf = Get-Content -LiteralPath $confPath
  $rewritten = 0
  $newConf = foreach ($line in $conf) {
    if ($line -match '^\s*#?\s*listen_addresses\s*=') { $rewritten++; "listen_addresses = 'localhost'" }
    elseif ($line -match '^\s*#?\s*port\s*=') { $rewritten++; "port = $Port" }
    else { $line }
  }
  Set-Content -LiteralPath $confPath -Value $newConf
  L ("postgresql.conf: $rewritten baris listen_addresses/port ditulis eksplisit.")

  # --- service -------------------------------------------------------------
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if (-not $svc) {
    L "service: mendaftarkan $ServiceName..."
    $r = Invoke-Native -Exe $pgctl -Label 'pg_ctl register' -NativeArgs @('register', '-N', $ServiceName, '-D', $DataDir, '-w')
    if ($r.Code -ne 0) { throw "pg_ctl register gagal (exit $($r.Code))" }
    $null = Invoke-Native -Exe 'sc.exe' -Label 'sc config' -NativeArgs @('config', $ServiceName, 'start=', 'auto')
    Start-Service -Name $ServiceName
    L 'service: terdaftar dan dijalankan (auto-start).'
  } else {
    if ($svc.Status -ne 'Running') { Start-Service -Name $ServiceName; L 'service: sudah ada, dinyalakan.' }
    else { L 'service: sudah ada dan sedang jalan.' }
  }

  # --- wait until ready ----------------------------------------------------
  $ready = $false
  foreach ($i in 1..20) {
    Start-Sleep -Seconds 1
    $pr = Invoke-Native -Exe $isready -Label 'pg_isready' -NativeArgs @('-h', 'localhost', '-p', "$Port", '-U', 'postgres') -Quiet
    if ($pr.Code -eq 0) { $ready = $true; break }
  }
  L ('pg_isready: ' + $(if ($ready) { 'siap' } else { 'TIDAK siap setelah 20 detik' }))
  if (-not $ready) { throw 'PostgreSQL tidak merespons setelah start service.' }

  # --- role + database -----------------------------------------------------
  $env:PGPASSWORD = $superPw
  $base = @('-h', 'localhost', '-p', "$Port", '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1')

  $r = Invoke-Native -Exe $psql -Label 'psql' -NativeArgs ($base + @('-tAc', "SELECT 1 FROM pg_roles WHERE rolname='$AppUser'"))
  if ($r.Code -ne 0) { throw "cek role gagal (exit $($r.Code))" }
  if ((($r.Output -join ' ').Trim()) -ne '1') {
    $null = Invoke-Native -Exe $psql -Label 'psql' -NativeArgs ($base + @('-c', "CREATE ROLE $AppUser LOGIN PASSWORD '$appPw';"))
    L "role $AppUser dibuat."
  } else {
    $null = Invoke-Native -Exe $psql -Label 'psql' -NativeArgs ($base + @('-c', "ALTER ROLE $AppUser WITH PASSWORD '$appPw';"))
    L "role $AppUser sudah ada, password disamakan dengan .env."
  }

  $r = Invoke-Native -Exe $psql -Label 'psql' -NativeArgs ($base + @('-tAc', "SELECT 1 FROM pg_database WHERE datname='$AppDb'"))
  if ($r.Code -ne 0) { throw "cek database gagal (exit $($r.Code))" }
  if ((($r.Output -join ' ').Trim()) -ne '1') {
    $null = Invoke-Native -Exe $psql -Label 'psql' -NativeArgs ($base + @('-c', "CREATE DATABASE $AppDb OWNER $AppUser;"))
    L "database $AppDb dibuat."
  } else {
    L "database $AppDb sudah ada."
  }

  # Verify the application role can log in with the password from the .env.
  $env:PGPASSWORD = $appPw
  $r = Invoke-Native -Exe $psql -Label 'psql-verify' -NativeArgs @('-h', 'localhost', '-p', "$Port", '-U', $AppUser, '-d', $AppDb, '-tAc', 'SELECT current_user')
  $who = (($r.Output -join ' ').Trim())
  L ("verifikasi login $AppUser ke $AppDb : " + $(if ($who -eq $AppUser) { 'OK' } else { 'GAGAL -> ' + $who }))
  if ($who -ne $AppUser) { throw 'role aplikasi tidak bisa login dengan password dari .env' }
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue

  L '=== SELESAI ==='
} catch {
  L ('GAGAL: ' + $_.Exception.Message)
  if ($_.InvocationInfo -and $_.InvocationInfo.Line) { L ('  pada: ' + $_.InvocationInfo.Line.Trim()) }
  exit 1
}