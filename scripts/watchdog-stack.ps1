<#
  watchdog-stack.ps1 -- pastikan seluruh stack hidup; sembuhkan yang mati.

  Dijalankan oleh task AuliaStackWatchdog saat startup dan tiap 5 menit.
  Alasan keberadaannya: aulia3 pernah mati mendadak (Kernel-Power 41) dan
  setelah boot: service PostgreSQL berhenti, task adapter tidak jalan, dan
  dua instance adapter sempat hidup lalu mati tanpa jejak error. Satu
  mekanisme yang memeriksa + menyalakan ulang jauh lebih andal daripada tiga
  mekanisme terpisah yang masing-masing bisa gagal diam-diam.

  Aturan penting:
  - HANYA cmdlet untuk cek port (Get-NetTCPConnection). Panggilan socket mentah
    (TcpClient) menggantung saat dijalankan sebagai SYSTEM di host ini -- sudah
    terbukti dua kali.
  - Jangan pernah pakai Get-ScheduledTaskInfo.LastRunTime sebagai jam boot:
    nilai itu basi setelah reboot sehingga pernah terbaca 256s untuk proses yang
    baru saja start, dan Evolution yang sedang pulih pun dibunuh. Gunakan umur
    proses nyata (Get-TaskProcessAgeSec).

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
  # Cold boot Evolution butuh ~6 menit: run-evolution.cmd menunggu PostgreSQL
  # sampai 60s, lalu tsx mengompilasi TypeScript sebelum port 8080 dibuka.
  [int]   $EvolutionStartGraceSec = 420,
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

function Get-TaskProcessAgeSec {
  # Umur proses cmd.exe pembungkus task (bukan Get-ScheduledTaskInfo.LastRunTime,
  # yang basi setelah reboot). Mengambil nama file wrapper dari action task itu
  # sendiri, jadi tidak ada daftar nama yang perlu dirawat terpisah.
  # $null kalau task tidak Running atau proses wrapper tidak ditemukan.
  param([string]$TaskName)
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task -or $task.State -ne 'Running') { return $null }
  $exe = $null
  try { $exe = @($task.Actions)[0].Execute } catch { }
  if (-not $exe) { return $null }
  $leaf = Split-Path -Leaf $exe
  $cmd = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -match [regex]::Escape($leaf)) } |
    Sort-Object CreationDate -Descending | Select-Object -First 1
  if (-not $cmd) { return $null }
  [int]((Get-Date) - $cmd.CreationDate).TotalSeconds
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
  $taskRunning = (Get-ScheduledTask -TaskName $EvolutionTask -ErrorAction SilentlyContinue).State -eq 'Running'
  $ageSec = Get-TaskProcessAgeSec -TaskName $EvolutionTask

  # PENTING: `schtasks /end` mengirim Ctrl+C ke semua instance task, jadi salah
  # klasifikasi di sini memutus sesi WhatsApp yang sedang pulih.
  if ($taskRunning -and ($null -eq $ageSec -or $ageSec -lt $EvolutionStartGraceSec)) {
    $actions += ('evolution sedang boot (umur proses ' + $ageSec + 's) -> tunggu, tidak dibunuh')
    # Dicatat langsung: cabang ini bisa menunggu sampai 7 menit, dan tanpa ini
    # log-nya kosong selama menunggu sehingga sulit dibedakan dari macet.
    L ('    evolution sedang boot (umur proses ' + $ageSec + 's) -> tunggu, tidak dibunuh')
    if (-not (Wait-Listen -Port $EvolutionPort -Seconds $EvolutionStartGraceSec)) {
      $actions += ('evolution masih tidak listen setelah ' + $EvolutionStartGraceSec + 's -> end+start')
      L ('    evolution masih tidak listen setelah ' + $EvolutionStartGraceSec + 's -> end+start')
      & schtasks /end /tn $EvolutionTask 2>&1 | Out-Null
      Start-Sleep -Seconds 2
      Start-Task -Name $EvolutionTask
      if (-not (Wait-Listen -Port $EvolutionPort -Seconds $EvolutionStartGraceSec)) { $actions += 'evolution MASIH mati setelah restart' }
    }
  } else {
    if ($taskRunning) {
      $actions += ('task evolution Running ' + $ageSec + 's tanpa port -> end+start')
      L ('    task evolution Running ' + $ageSec + 's tanpa port -> end+start')
      & schtasks /end /tn $EvolutionTask 2>&1 | Out-Null
      Start-Sleep -Seconds 2
    }
    Start-Task -Name $EvolutionTask
    if (-not (Wait-Listen -Port $EvolutionPort -Seconds $EvolutionStartGraceSec)) { $actions += 'evolution MASIH mati' }
  }
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