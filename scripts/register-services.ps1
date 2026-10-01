<#
  register-services.ps1 -- run ON aulia3 (as SYSTEM via scheduled task).

  Registers the two long-running components as real Windows scheduled tasks
  that start at boot, then starts them and verifies both HTTP ports answer.

    AuliaEvolution -> Evolution API          (port 8080)
    AuliaAdapter   -> evolution-gateway adapter (port 3000)

  Working directory is set explicitly on each task: Evolution loads its .env
  from the working directory, and the adapter resolves ./data relative to it.

  Output: D:\kilo\register-services.log
#>
[CmdletBinding()]
param(
  [string]$LogPath   = 'D:\kilo\register-services.log',
  [int]   $EvolutionPort = 8080,
  [int]   $AdapterPort   = 3000
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null
New-Item -ItemType Directory -Path 'D:\kilo\logs' -Force | Out-Null
Set-Content -LiteralPath $LogPath -Value ''
function L { param([string]$m) Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) }

function Test-Port {
  param([int]$Port)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne(2000)) { return $false }
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

function Register-AppTask {
  param([string]$TaskName, [string]$CmdFile, [string]$WorkDir, [int]$Port)
  $action    = New-ScheduledTaskAction -Execute $CmdFile -WorkingDirectory $WorkDir
  $trigger   = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                 -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
                 -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName ${TaskName} -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
  L ("task: ${TaskName} terdaftar (AtStartup, SYSTEM, restart 3x/menit, cwd=$WorkDir)")

  if (Test-Port -Port $Port) { L "${TaskName}: port $Port sudah listen, tidak perlu start ulang."; return }
  Start-ScheduledTask -TaskName $TaskName
  L "${TaskName}: dijalankan; menunggu port $Port..."
  if (Wait-Port -Port $Port -Seconds 120) { L "${TaskName}: port $Port SIAP." }
  else { L "${TaskName}: GAGAL listen di $Port setelah 120 detik."; throw "${TaskName} gagal start" }
}

try {
  L '=== REGISTER SERVICES (evolution + adapter) ==='
  L ('computer: ' + $env:COMPUTERNAME + ' user: ' + $env:USERNAME)

  # Remove leftovers from earlier manual attempts so only one instance runs.
  foreach ($stale in @('kilo-start', 'kilo-start2')) {
    $t = Get-ScheduledTask -TaskName $stale -ErrorAction SilentlyContinue
    if ($t) { Unregister-ScheduledTask -TaskName $stale -Confirm:$false; L "task lama $stale dihapus." }
  }
  $stray = @(Get-Process -Name node -ErrorAction SilentlyContinue)
  if ($stray.Count -gt 0) {
    L ('proses node liar: ' + $stray.Count + ' -> dihentikan')
    $stray | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }

  Register-AppTask -TaskName 'AuliaEvolution' -CmdFile 'D:\evolution-gateway\scripts\run-evolution.cmd' -WorkDir 'D:\evolution-api-server' -Port $EvolutionPort
  Register-AppTask -TaskName 'AuliaAdapter'   -CmdFile 'D:\evolution-gateway\scripts\run-adapter.cmd'   -WorkDir 'D:\evolution-gateway'     -Port $AdapterPort

  $svc = @(Get-Service -Name 'postgresql-aulia3' -ErrorAction SilentlyContinue)
  L ('postgresql-aulia3: ' + $(if ($svc) { $svc[0].Status } else { 'TIDAK ADA' }))

  L '=== SELESAI ==='
} catch {
  L ('GAGAL: ' + $_.Exception.Message)
  if ($_.InvocationInfo -and $_.InvocationInfo.Line) { L ('  pada: ' + $_.InvocationInfo.Line.Trim()) }
  foreach ($f in @('D:\kilo\logs\evolution.log', 'D:\kilo\logs\adapter.log')) {
    if (Test-Path $f) { L ('--- ' + $f + ' (15 baris terakhir) ---'); Get-Content $f -Tail 15 | ForEach-Object { L ('  ' + $_) } }
  }
  exit 1
}