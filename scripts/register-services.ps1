<#
  register-services.ps1 -- daftarkan ulang task service + watchdog dengan
  setelan yang benar (dijalankan DI aulia3 sebagai SYSTEM).

  Kenapa didaftarkan ulang: task adapter sebelumnya dibuat lewat `schtasks`
  biasa sehingga memakai default yang rapuh -- DisallowStartIfOnBatteries=true,
  StopIfGoingOnBatteries=true, tanpa StartWhenAvailable dan tanpa restart saat
  gagal. Terbukti di lapangan: setelah mati mendadak, task adapter tidak jalan.

  Task yang didaftarkan:
    AuliaEvolution     : run-evolution.cmd  (AtStartup, SYSTEM)
    AuliaAdapter       : run-adapter.cmd    (AtStartup, SYSTEM)
    AuliaStackWatchdog : watchdog-stack.ps1 (AtStartup + tiap 5 menit, SYSTEM)
    AuliaLogRotate     : rotate-logs.ps1    (harian 09:00, prune arsip, SYSTEM)

  Hanya cmdlet + schtasks (tanpa socket mentah). Output: D:\kilo\register-services.log
#>
[CmdletBinding()]
param(
  [string]$LogPath = 'D:\kilo\register-services.log'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null
New-Item -ItemType Directory -Path 'D:\kilo\logs' -Force | Out-Null
Set-Content -LiteralPath $LogPath -Value ''
function L { param([string]$m) Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) }

function New-AppSettings {
  New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
}

function Register-AppTask {
  param([string]$TaskName, [string]$CmdFile, [string]$WorkDir)
  $action    = New-ScheduledTaskAction -Execute $CmdFile -WorkingDirectory $WorkDir
  $trigger   = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings (New-AppSettings) -Force | Out-Null
  L ("  $TaskName didaftarkan (AtStartup, SYSTEM, StartWhenAvailable, restart 3x/1m, cwd=$WorkDir)")
}

function Register-Watchdog {
  param([string]$TaskName, [string]$ScriptPath)
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $ScriptPath + '" -Quiet')
  $trigger = New-ScheduledTaskTrigger -AtStartup
  # Ulangi tiap 5 menit mulai dari sekarang.
  $rep = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)).Repetition
  $trigger.Repetition = $rep
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings (New-AppSettings) -Force | Out-Null
  L ("  $TaskName didaftarkan (AtStartup + tiap 5 menit, SYSTEM)")
}

function Register-LogRotate {
  param([string]$TaskName, [string]$ScriptPath)
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $ScriptPath + '"')
  $trigger = New-ScheduledTaskTrigger -Daily -At '09:00'
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings (New-AppSettings) -Force | Out-Null
  L ("  $TaskName didaftarkan (harian 09:00, prune arsip, SYSTEM)")
}

try {
  L '=== REGISTER SERVICES + WATCHDOG ==='
  L ('computer: ' + $env:COMPUTERNAME)

  Register-AppTask -TaskName 'AuliaEvolution' -CmdFile 'D:\evolution-gateway\scripts\run-evolution.cmd' -WorkDir 'D:\evolution-api-server'
  Register-AppTask -TaskName 'AuliaAdapter'   -CmdFile 'D:\evolution-gateway\scripts\run-adapter.cmd'   -WorkDir 'D:\evolution-gateway'
  Register-Watchdog -TaskName 'AuliaStackWatchdog' -ScriptPath 'D:\evolution-gateway\scripts\watchdog-stack.ps1'
  Register-LogRotate -TaskName 'AuliaLogRotate' -ScriptPath 'D:\evolution-gateway\scripts\rotate-logs.ps1'

  L '--- verifikasi task ---'
  foreach ($n in @('AuliaEvolution', 'AuliaAdapter', 'AuliaStackWatchdog', 'AuliaLogRotate')) {
    $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
    if (-not $t) { L ("  $n : TIDAK ADA"); continue }
    $trg = ($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ','
    L ("  $n : state=$($t.State) user=$($t.Principal.UserId) trigger=$trg")
  }

  L '--- jalankan watchdog sekali sekarang ---'
  & schtasks /run /tn 'AuliaStackWatchdog' 2>&1 | ForEach-Object { L ('  ' + $_.ToString().Trim()) }

  L '=== SELESAI ==='
} catch {
  L ('GAGAL: ' + $_.Exception.Message)
  if ($_.InvocationInfo -and $_.InvocationInfo.Line) { L ('  pada: ' + $_.InvocationInfo.Line.Trim()) }
  exit 1
}