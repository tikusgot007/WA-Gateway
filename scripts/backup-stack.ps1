<#
  backup-stack.ps1 -- backup terjadwal gateway (TODO-O1).

  Isi tiap backup (subfolder BackupRoot):
    pg\     PostgreSQL Evolution (pg_dump -Fc)
    sqlite\ SQLite antrean (backup ONLINE via scripts/backup-sqlite.js)
    media\  data/media (zip)
    env\    .env adapter + Evolution (zip; BERISI RAHASIA -- batasi akses)

  Dijalankan task AuliaBackup (harian). Output: D:\kilo\backup.log
  Semua langkah fail-soft: kegagalan satu bagian dicatat & tidak menghentikan
  bagian lain; keluar kode 1 kalau ada yang gagal (agar task terlihat gagal).

  Jalankan: powershell -NoProfile -ExecutionPolicy Bypass -File backup-stack.ps1
#>
[CmdletBinding()]
param(
  [string]$BackupRoot   = 'D:\backup\aulia3',
  [int]   $KeepDays     = 30,
  [string]$AdapterDir   = 'D:\evolution-gateway',
  [string]$EvolutionEnv = 'D:\evolution-api-server\.env',
  [string]$PgDump       = 'D:\pgsql16\bin\pg_dump.exe',
  [string]$NodeExe      = 'D:\node\node.exe',
  [string]$LogPath      = 'D:\kilo\backup.log'
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null
function L { param([string]$m) Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) }

$day   = Get-Date -Format 'yyyy-MM-dd'
$fail  = @()

foreach ($sub in @('pg', 'sqlite', 'media', 'env')) {
  New-Item -ItemType Directory -Path (Join-Path $BackupRoot $sub) -Force | Out-Null
}

L '=== BACKUP STACK ==='
L ("root: $BackupRoot; keep: $KeepDays hari")

# --- 1. PostgreSQL Evolution ----------------------------------------------
try {
  $line = (Select-String -LiteralPath $EvolutionEnv -Pattern '^DATABASE_CONNECTION_URI=' | Select-Object -First 1).Line
  if (-not $line) { throw 'DATABASE_CONNECTION_URI tidak ditemukan di env Evolution' }

  $uri = ($line -replace '^DATABASE_CONNECTION_URI=', '').Trim().Trim("'").Trim('"')
  $m = [regex]::Match($uri, 'postgresql://(?<user>[^:]+):(?<pass>[^@]+)@(?<host>[^:/]+):(?<port>\d+)/(?<db>[^?]+)')
  if (-not $m.Success) { throw 'format DATABASE_CONNECTION_URI tidak dikenal' }

  $pgUser = $m.Groups['user'].Value
  $pgPass = $m.Groups['pass'].Value
  $pgHost = $m.Groups['host'].Value
  $pgPort = $m.Groups['port'].Value
  $pgDb   = $m.Groups['db'].Value

  $dest = Join-Path (Join-Path $BackupRoot 'pg') ("$pgDb`_$day.dump")
  $env:PGPASSWORD = $pgPass
  try {
    & $PgDump -h $pgHost -p $pgPort -U $pgUser -d $pgDb -Fc -f $dest 2>&1 |
      ForEach-Object { L ('  pg_dump: ' + $_.ToString().Trim()) }
    if ($LASTEXITCODE -ne 0) { throw ('pg_dump exit ' + $LASTEXITCODE) }
  } finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  }

  if (-not (Test-Path -LiteralPath $dest) -or (Get-Item -LiteralPath $dest).Length -le 0) { throw 'dump kosong/tidak ada' }
  L ("  pg OK: $dest (" + (Get-Item -LiteralPath $dest).Length + ' B)')
} catch {
  $fail += 'pg'; L ('  pg GAGAL: ' + $_.Exception.Message)
}

# --- 2. SQLite online backup ----------------------------------------------
try {
  $src  = Join-Path $AdapterDir 'data\evolution-gateway.sqlite'
  $dest = Join-Path (Join-Path $BackupRoot 'sqlite') ("evolution-gateway_$day.sqlite")
  & $NodeExe (Join-Path $AdapterDir 'scripts\backup-sqlite.js') $src $dest 2>&1 |
    ForEach-Object { L ('  sqlite: ' + $_.ToString().Trim()) }
  if ($LASTEXITCODE -ne 0) { throw ('nilai keluar ' + $LASTEXITCODE) }
  L ("  sqlite OK: $dest")
} catch {
  $fail += 'sqlite'; L ('  sqlite GAGAL: ' + $_.Exception.Message)
}

# --- 3. media (zip) --------------------------------------------------------
try {
  $media = Join-Path $AdapterDir 'data\media'
  if (Test-Path -LiteralPath $media) {
    $dest = Join-Path (Join-Path $BackupRoot 'media') ("media_$day.zip")
    Compress-Archive -Path (Join-Path $media '*') -DestinationPath $dest -Force
    L ("  media OK: $dest (" + (Get-Item -LiteralPath $dest).Length + ' B)')
  } else {
    L '  media: folder tidak ada, dilewati'
  }
} catch {
  $fail += 'media'; L ('  media GAGAL: ' + $_.Exception.Message)
}

# --- 4. .env (RAHASIA) -----------------------------------------------------
try {
  $envs = @((Join-Path $AdapterDir '.env'), $EvolutionEnv) | Where-Object { Test-Path -LiteralPath $_ }
  $dest = Join-Path (Join-Path $BackupRoot 'env') ("env_$day.zip")
  Compress-Archive -LiteralPath $envs -DestinationPath $dest -Force
  L ("  env OK: $dest (" + (Get-Item -LiteralPath $dest).Length + ' B) - BERISI RAHASIA')
} catch {
  $fail += 'env'; L ('  env GAGAL: ' + $_.Exception.Message)
}

# --- 5. retensi ------------------------------------------------------------
$cutoff = (Get-Date).AddDays(-$KeepDays)
$old = @(Get-ChildItem -LiteralPath $BackupRoot -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt $cutoff })
foreach ($f in $old) {
  try { Remove-Item -LiteralPath $f.FullName -Force; L ('  prune: ' + $f.FullName) }
  catch { L ('  gagal prune ' + $f.Name) }
}
L ("  retensi: hapus " + $old.Count + " file > $KeepDays hari")

if ($fail.Count -gt 0) {
  L ('=== SELESAI dengan GAGAL: ' + ($fail -join ', ') + ' ===')
  exit 1
}
L '=== SELESAI (semua OK) ==='
