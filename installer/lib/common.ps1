<#
  common.ps1 -- helper bersama untuk paket installer gateway.

  Di-dot-source oleh install.ps1 / start.ps1 / stop.ps1 / status.ps1.
  Hanya memakai cmdlet + native call; TIDAK memakai socket mentah
  (TcpClient) karena panggilan itu menggantung saat dijalankan sebagai
  SYSTEM di host gateway -- lihat scripts/watchdog-stack.ps1.
#>

$script:AuliaLogPath = $null

function Initialize-AuliaLog {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$Reset
  )
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  if ($Reset) { Set-Content -LiteralPath $Path -Value '' }
  $script:AuliaLogPath = $Path
}

function Write-Log {
  param([string]$Message = '')
  if ($script:AuliaLogPath) {
    Add-Content -LiteralPath $script:AuliaLogPath -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $Message)
  }
  Write-Host $Message
}

# Jalankan program native, tangkap stdout+stderr sebagai teks + exit code.
# PENTING di PowerShell 5.1: stderr sebuah native call menjadi ErrorRecord,
# dan dengan $ErrorActionPreference='Stop' itu menghentikan skrip di tengah
# jalan. Karena itu error preference dilonggarkan selama pemanggilan.
function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [string[]]$NativeArgs = @(),
    [string]$Label = $Exe,
    [string]$WorkDir,
    [switch]$Quiet
  )
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = @()
  $code = 0
  $pushed = $false
  try {
    if ($WorkDir) { Push-Location -LiteralPath $WorkDir; $pushed = $true }
    $out = @(& $Exe @NativeArgs 2>&1 | ForEach-Object { $_.ToString() })
    $code = $LASTEXITCODE
  } finally {
    if ($pushed) { Pop-Location }
    $ErrorActionPreference = $prev
  }
  if (-not $Quiet) {
    foreach ($line in $out) { Write-Log ('  ' + $Label + ': ' + $line) }
    Write-Log ('  ' + $Label + ' [exit=' + $code + ']')
  }
  return [pscustomobject]@{ Output = $out; Code = $code }
}

function Get-EnvValue {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Key
  )
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $line = Select-String -LiteralPath $Path -Pattern ('^' + [regex]::Escape($Key) + '\s*=') | Select-Object -First 1
  if (-not $line) { return $null }
  return (($line.Line -split '=', 2)[1]).Trim().Trim("'").Trim('"')
}

# Muat .env ke environment proses (Prisma hanya membaca .env dari cwd,
# jadi skrip yang memanggil Prisma memuatnya eksplisit).
function Import-DotEnv {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { throw "File .env tidak ditemukan: $Path" }
  $count = 0
  foreach ($line in (Get-Content -LiteralPath $Path)) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    $idx = $t.IndexOf('=')
    if ($idx -lt 1) { continue }
    $key = $t.Substring(0, $idx).Trim()
    $val = $t.Substring($idx + 1).Trim().Trim("'").Trim('"')
    if ($key -match '^[A-Za-z_][A-Za-z0-9_]*$') { Set-Item -Path ('Env:' + $key) -Value $val; $count++ }
  }
  return $count
}

function Test-Listen {
  param([Parameter(Mandatory = $true)][int]$Port)
  @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0
}

function Wait-Listen {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [int]$Seconds = 30
  )
  foreach ($i in 1..$Seconds) {
    if (Test-Listen -Port $Port) { return $true }
    Start-Sleep -Seconds 1
  }
  return (Test-Listen -Port $Port)
}

# Info pemilik port: pid, nama proses, dan command line (untuk memverifikasi
# apakah port dipegang stack kita sendiri).
function Get-PortOwners {
  param([Parameter(Mandatory = $true)][int]$Port)
  $result = @()
  foreach ($c in @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    $cmd = $null
    try { $cmd = (Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $c.OwningProcess) -ErrorAction Stop).CommandLine } catch { }
    $result += [pscustomobject]@{ Pid = $c.OwningProcess; Name = $(if ($p) { $p.ProcessName } else { '' }); CommandLine = $cmd }
  }
  return $result
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Admin {
  if (-not (Test-Admin)) { throw 'Skrip ini harus dijalankan sebagai Administrator.' }
}

function New-Hex {
  param([int]$Bytes = 32)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $buf = New-Object byte[] $Bytes; $rng.GetBytes($buf) } finally { $rng.Dispose() }
  return (($buf | ForEach-Object { $_.ToString('x2') }) -join '')
}

# IPv4 lokal non-loopback pertama (untuk info URL webhook di ringkasan).
function Get-LanIPv4 {
  $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown' })
  if ($ips.Count -gt 0) { return $ips[0].IPAddress }
  return '127.0.0.1'
}

# Resolve node.exe / npm.cmd. Menyegarkan PATH dari registry kalau perlu,
# karena winget memasang Node ke PATH mesin yang belum terbaca proses ini.
function Resolve-NodeTools {
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $node -or -not $npm) {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  }
  return [pscustomobject]@{ Node = $node; Npm = $npm }
}

# Unduh file besar tanpa progress bar (progress bar PS sangat lambat).
function Get-RemoteFile {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [string]$Label = $Url
  )
  $dir = Split-Path -Parent $OutFile
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Write-Log ('unduh: ' + $Label)
  $prev = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try { Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec 1800 }
  finally { $ProgressPreference = $prev }
  if (-not (Test-Path -LiteralPath $OutFile)) { throw ('Unduhan gagal: ' + $Url) }
  Write-Log ('  -> ' + $OutFile + ' (' + [math]::Round((Get-Item -LiteralPath $OutFile).Length / 1MB, 1) + ' MB)')
}

# Ekstrak ZIP repo GitHub (satu folder di dalamnya) menjadi $DestDir.
function Expand-RepoZip {
  param(
    [Parameter(Mandatory = $true)][string]$ZipPath,
    [Parameter(Mandatory = $true)][string]$DestDir
  )
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('auliagw-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    Write-Log ('ekstrak: ' + $ZipPath)
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $tmp -Force
    $inner = @(Get-ChildItem -LiteralPath $tmp -Directory)
    if ($inner.Count -ne 1) { throw ('Isi ZIP tidak seperti yang diharapkan: ' + $ZipPath) }
    if (Test-Path -LiteralPath $DestDir) { Remove-Item -LiteralPath $DestDir -Recurse -Force }
    Move-Item -LiteralPath $inner[0].FullName -Destination $DestDir
    Write-Log ('  -> ' + $DestDir)
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
