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

# Pastikan git.exe ada di PATH; pasang lewat winget kalau belum (pola sama
# dengan Ensure-Node di install.ps1). Menyegarkan $env:Path dari registry
# setelah instalasi karena proses ini tidak otomatis melihat PATH mesin yang
# baru ditulis winget.
function Resolve-GitTool {
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $git) {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
  }
  return $git
}

function Ensure-Git {
  $git = Resolve-GitTool
  if ($git) { Write-Log ('git: sudah ada ' + $git.Source); return }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { throw 'Git belum ada dan winget tidak tersedia. Pasang Git for Windows manual, lalu ulangi dengan -SkipPrereqs.' }
  Write-Log 'git: memasang Git.Git lewat winget...'
  $null = Invoke-Native -Exe $winget.Source -NativeArgs @('install', '--id', 'Git.Git', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements') -Label 'winget'
  $git = Resolve-GitTool
  if (-not $git) { throw 'git.exe masih tidak ditemukan setelah winget install.' }
}

# Pastikan $Dest berisi working tree Git dari $Repo (format 'owner/name') pada
# commit yang diresolve dari $Ref (branch, tag, atau SHA penuh). Clone sekali
# (checkout awal terpisah supaya .git ada sebelum checkout ref spesifik);
# panggilan berikutnya hanya fetch + checkout -- TIDAK pernah menghapus
# $Dest, sehingga file gitignored (.env, data/, node_modules/) selamat lewat
# update berikutnya (beda dari Expand-RepoZip yang menghapus $DestDir lebih
# dulu). Checkout selalu --detach supaya ref bergerak (mis. branch) tidak
# bergantung pada local branch yang bisa basi -- lihat docs/design terkait,
# risiko "moving ref silently changes content" sudah ada sejak ZIP dan bukan
# regresi dari perubahan ini.
# Return: [pscustomobject]@{ OldHead; NewHead; Changed }
# -Url: override URL remote (hanya untuk pengujian terhadap repo lokal;
# produksi selalu memakai https://github.com/<Repo>.git lewat $Repo).
function Ensure-GitSource {
  param(
    [Parameter(Mandatory = $true)][string]$Dest,
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Ref,
    [string]$Label = $Repo,
    [string]$Url
  )
  $git = Resolve-GitTool
  if (-not $git) { throw 'git.exe tidak ditemukan. Panggil Ensure-Git lebih dulu.' }
  if (-not $Url) { $Url = 'https://github.com/' + $Repo + '.git' }
  $url = $Url

  $oldHead = $null
  if (Test-Path -LiteralPath (Join-Path $Dest '.git')) {
    $r = Invoke-Native -Exe $git.Source -NativeArgs @('rev-parse', 'HEAD') -Label ($Label + ' rev-parse') -WorkDir $Dest -Quiet
    if ($r.Code -eq 0 -and $r.Output.Count -gt 0) { $oldHead = $r.Output[0].Trim() }
  } else {
    if (Test-Path -LiteralPath $Dest) {
      $existing = @(Get-ChildItem -LiteralPath $Dest -Force -ErrorAction SilentlyContinue)
      if ($existing.Count -gt 0) { throw ($Label + ': ' + $Dest + ' sudah ada dan bukan git working tree (tidak kosong, tidak ada .git). Hapus manual dulu kalau memang ingin diganti.') }
    } else {
      New-Item -ItemType Directory -Path $Dest -Force | Out-Null
    }
    Write-Log ($Label + ': clone ' + $url + ' -> ' + $Dest)
    $r = Invoke-Native -Exe $git.Source -NativeArgs @('clone', '--no-checkout', $url, $Dest) -Label ($Label + ' clone')
    if ($r.Code -ne 0) { throw ($Label + ': git clone gagal.') }
  }

  Write-Log ($Label + ': fetch origin...')
  $r = Invoke-Native -Exe $git.Source -NativeArgs @('fetch', '--tags', 'origin') -Label ($Label + ' fetch') -WorkDir $Dest
  if ($r.Code -ne 0) { throw ($Label + ': git fetch gagal.') }

  # Resolve $Ref ke commit yang pasti ada setelah fetch: coba sebagai SHA
  # langsung, lalu sebagai origin/<branch>, lalu sebagai tag/<Ref> apa adanya
  # (git checkout menerima nama tag langsung selama sudah di-fetch).
  $checkoutTarget = $Ref
  $asRemoteBranch = Invoke-Native -Exe $git.Source -NativeArgs @('rev-parse', '--verify', '--quiet', ('origin/' + $Ref)) -Label ($Label + ' verify-branch') -WorkDir $Dest -Quiet
  if ($asRemoteBranch.Code -eq 0) { $checkoutTarget = 'origin/' + $Ref }

  Write-Log ($Label + ': checkout ' + $checkoutTarget + ' (--detach)')
  $r = Invoke-Native -Exe $git.Source -NativeArgs @('checkout', '--detach', $checkoutTarget) -Label ($Label + ' checkout') -WorkDir $Dest
  if ($r.Code -ne 0) { throw ($Label + ': git checkout gagal untuk ref ''' + $Ref + '''.') }

  $r = Invoke-Native -Exe $git.Source -NativeArgs @('rev-parse', 'HEAD') -Label ($Label + ' rev-parse-after') -WorkDir $Dest -Quiet
  $newHead = $r.Output[0].Trim()
  Write-Log ($Label + ': HEAD -> ' + $newHead)

  return [pscustomobject]@{
    OldHead = $oldHead
    NewHead = $newHead
    Changed = ($oldHead -ne $newHead)
  }
}
