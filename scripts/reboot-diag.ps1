<#
  reboot-diag.ps1 -- kenapa stack tidak naik setelah reboot aulia3.

  Hanya cmdlet (tanpa socket mentah). Output: D:\kilo\reboot-diag.log
#>
$log = 'D:\kilo\reboot-diag.log'
New-Item -ItemType Directory -Path 'D:\kilo' -Force | Out-Null
Set-Content -LiteralPath $log -Value ''
function L { param([string]$m) Add-Content -LiteralPath $log -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) }

$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
L '=== REBOOT DIAG ==='
L ('boot: ' + $boot)

L '--- service postgresql-aulia3 ---'
$svc = Get-CimInstance Win32_Service -Filter "Name='postgresql-aulia3'" -ErrorAction SilentlyContinue
if ($svc) {
  L ('  state=' + $svc.State + ' startMode=' + $svc.StartMode + ' exitCode=' + $svc.ExitCode)
  L ('  path=' + $svc.PathName)
  L ('  logonAccount=' + $svc.StartName)
} else { L '  (service tidak ada)' }

L '--- proses postgres.exe ---'
foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" -ErrorAction SilentlyContinue)) {
  L ('  pid ' + $p.ProcessId + ' lahir ' + $p.CreationDate + ' cmd=' + ($p.CommandLine -replace '\s+', ' '))
}

L '--- proses node.exe ---'
foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)) {
  L ('  pid ' + $p.ProcessId + ' lahir ' + $p.CreationDate + ' ppid=' + $p.ParentProcessId + ' cmd=' + ($p.CommandLine -replace '\s+', ' '))
}

L '--- proses cmd.exe (pembungkus task) ---'
foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue)) {
  L ('  pid ' + $p.ProcessId + ' lahir ' + $p.CreationDate + ' cmd=' + ($p.CommandLine -replace '\s+', ' '))
}

L '--- trigger/setting task AuliaAdapter ---'
try {
  $xml = Export-ScheduledTask -TaskName 'AuliaAdapter' -ErrorAction Stop
  foreach ($m in [regex]::Matches($xml, '<(StartBoundary|Enabled|Delay|ExecutionTimeLimit|RestartOnFailure|Enabled|MultipleInstances|DisallowStartIfOnBatteries|StopIfGoingOnBatteries|StartWhenAvailable|UserId|RunLevel|Command|Arguments|WorkingDirectory)>?(.*?)</\1>|<(StartBoundary|Enabled|Delay)[^>]*/?>')) {
    $t = $m.Value.Trim()
    if ($t.Length -lt 220) { L ('  ' + $t) }
  }
} catch { L ('  gagal baca XML: ' + $_.Exception.Message) }

L '--- event TaskScheduler untuk Aulia* sejak boot ---'
try {
  $ev = Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-TaskScheduler/Operational'; StartTime = $boot } -MaxEvents 120 -ErrorAction Stop
  $hit = @($ev | Where-Object { $_.Message -match 'Aulia(Adapter|Evolution)' })
  if ($hit.Count -eq 0) { L '  (tidak ada event untuk task Aulia*)' }
  foreach ($e in ($hit | Select-Object -First 25)) { L ('  ' + $e.TimeCreated.ToString('HH:mm:ss') + ' id=' + $e.Id + ' ' + (($e.Message -split "`n")[0])) }
} catch { L ('  log TaskScheduler tidak bisa dibaca: ' + $_.Exception.Message) }

L '--- event System penting sejak boot (SCM / boot / update) ---'
try {
  $ev = Get-WinEvent -FilterHashtable @{ LogName = 'System'; StartTime = $boot; Id = @(41, 1074, 6005, 6006, 6008, 7000, 7009, 7011, 7024, 7031, 7034, 7036, 7045, 19) } -MaxEvents 200 -ErrorAction Stop
  foreach ($e in ($ev | Sort-Object TimeCreated)) {
    $msg = (($e.Message -split "`n")[0]) -replace '\s+', ' '
    if ($msg.Length -gt 150) { $msg = $msg.Substring(0, 150) }
    if ($e.Id -eq 7036 -and $msg -notmatch 'postgres|Evolution|Aulia') { continue }
    L ('  ' + $e.TimeCreated.ToString('HH:mm:ss') + ' id=' + $e.Id + ' [' + $e.ProviderName + '] ' + $msg)
  }
} catch { L ('  gagal baca event System: ' + $_.Exception.Message) }

L '--- 3 file log terakhir PostgreSQL ---'
$pglog = 'D:\pgsql16\data\log'
if (Test-Path $pglog) {
  foreach ($f in @(Get-ChildItem $pglog -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 2)) {
    L ('  == ' + $f.Name + ' ==')
    Get-Content $f.FullName -Tail 15 | ForEach-Object { L ('    ' + $_) }
  }
} else { L '  (tidak ada folder log PG)' }

L '=== SELESAI ==='