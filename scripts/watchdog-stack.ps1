<#
  watchdog-stack.ps1 -- pastikan seluruh stack hidup; sembuhkan yang mati.

  Dijalankan oleh task AuliaStackWatchdog saat startup dan tiap 5 menit.
  Alasan keberadaannya: aulia3 pernah mati mendadak (Kernel-Power 41) dan
  setelah boot: service PostgreSQL berhenti, task adapter tidak jalan, dan
  dua instance adapter sempat hidup lalu mati tanpa jejak error. Satu
  mekanisme yang memeriksa + menyalakan ulang jauh lebih andal daripada tiga
  mekanisme terpisah yang masing-masing bisa gagal diam-diam.

  Aturan penting: HANYA cmdlet untuk cek port (Get-NetTCPConnection). Panggilan
  socket mentah (TcpClient) menggantung saat dijalankan sebagai SYSTEM di host
  ini -- sudah terbukti dua kali.

  Keluar dengan kode 1 kalau ada komponen yang masih mati di akhir, supaya task
  terjadwal tidak melaporkan sukses palsu.
#>
[CmdletBinding()]
param(
  [string]$PgService   = 'postgresql-aulia3',
  [string]$PgCtl       = 'D:\pgsql16\bin\pg_ctl.exe',
  [string]$PgData      = 'D:\pgsql16\data',
  [string]$EvolutionTask = 'AuliaEvolution',
  [string]$AdapterTask   = 'AuliaAdapter',
  [string]$RestartAdapterScript = 'D:\evolution-gateway\scripts\restart-adapter.ps1',
  [int]   $PgPort        = 5432,
  [int]   $EvolutionPort = 8080,
  [int]   $AdapterPort   = 3000,
  [string]$LogPath      = 'D:\kilo\watchdog.log',
  [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null
function L { param([string]$m) Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) }

function Test-Listen {
  param([int]$Port)
  @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0
}

function Wait-Listen {
  param([int]$Port, [int]$Seconds)
  foreach ($i in 1..$Seconds) {
    if (Test-Listen -Port $Port) { return $true }
    Start-Sleep -Seconds 1
  }
  return (Test-Listen -Port $Port)
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
  foreach ($line in $out) { L ('    ' + $Label + ': ' + $line) }
  return $code
}

function Start-Task {
  param([string]$Name)
  $out = & schtasks /run /tn $Name 2>&1
  L ('    schtasks /run ' + $Name + ' -> ' + (($out | ForEach-Object { $_.ToString().Trim() }) -join ' '))
}

$actions = @()

# --- 1. PostgreSQL --------------------------------------------------------
if (-not (Test-Listen -Port $PgPort)) {
  $actions += 'postgres tidak listen'
  $svc = Get-Service -Name $PgService -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -ne 'Running') {
    try { Start-Service -Name $PgService -ErrorAction Stop; $actions += "service $PgService dinyalakan" }
    catch { $actions += ('Start-Service gagal: ' + $_.Exception.Message) }
  }
  if (-not (Wait-Listen -Port $PgPort -Seconds 20)) {
    $actions += 'masih mati -> pg_ctl start langsung'
    $null = Invoke-Native -Exe $PgCtl -NativeArgs @('start', '-D', $PgData, '-w', '-t', '30') -Label 'pg_ctl start'
    $null = Wait-Listen -Port $PgPort -Seconds 20
  }
}

# --- 2. Evolution --------------------------------------------------------
if (-not (Test-Listen -Port $EvolutionPort)) {
  $actions += 'evolution tidak listen'
  $task = Get-ScheduledTask -TaskName $EvolutionTask -ErrorAction SilentlyContinue
  if ($task -and $task.State -eq 'Running') {
    # Task "Running" tapi port mati = proses zombie; hentikan dulu.
    $actions += 'task evolution Running tapi port mati -> end+start'
    & schtasks /end /tn $EvolutionTask 2>&1 | Out-Null
    Start-Sleep -Seconds 2
  }
  Start-Task -Name $EvolutionTask
  if (-not (Wait-Listen -Port $EvolutionPort -Seconds 90)) { $actions += 'evolution MASIH mati' }
}

# --- 3. Adapter ----------------------------------------------------------
if (-not (Test-Listen -Port $AdapterPort)) {
  $actions += 'adapter tidak listen -> restart (memverifikasi pemilik port)'
  if (Test-Path -LiteralPath $RestartAdapterScript) {
    $null = Invoke-Native -Exe 'powershell.exe' -Label 'restart-adapter' -NativeArgs @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $RestartAdapterScript)
  } else {
    Start-Task -Name $AdapterTask
    $null = Wait-Listen -Port $AdapterPort -Seconds 60
  }
}

# --- ringkasan -----------------------------------------------------------
$pgUp   = Test-Listen -Port $PgPort
$evoUp  = Test-Listen -Port $EvolutionPort
$adUp   = Test-Listen -Port $AdapterPort
$allUp  = $pgUp -and $evoUp -and $adUp

if ($actions.Count -gt 0 -or -not $allUp) {
  L ('--- watchdog: pg=' + $pgUp + ' evolution=' + $evoUp + ' adapter=' + $adUp)
  foreach ($a in $actions) { L ('    aksi: ' + $a) }
} elseif (-not $Quiet) {
  L ('ok: pg/evolution/adapter listen')
}

if (-not $allUp) { exit 1 }
exit 0