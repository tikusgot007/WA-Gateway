<#
  status-stack.ps1 -- status lengkap stack Evolution/adapter di aulia3.

  Hanya memakai cmdlet (Get-Service/Get-ScheduledTask/Get-NetTCPConnection/
  Get-Process). TIDAK memakai socket mentah: panggilan TcpClient di host ini
  menggantung saat jalan sebagai SYSTEM.

  Output: D:\kilo\status-stack.log
#>
$log = 'D:\kilo\status-stack.log'
New-Item -ItemType Directory -Path 'D:\kilo' -Force | Out-Null
Set-Content -LiteralPath $log -Value ''
function L { param([string]$m) Add-Content -LiteralPath $log -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) }

L '=== STATUS STACK EVOLUTION GATEWAY ==='
L ('waktu    : ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
$os = Get-CimInstance Win32_OperatingSystem
L ('boot     : ' + $os.LastBootUpTime.ToString('yyyy-MM-dd HH:mm:ss') + '  (uptime ' + [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1) + ' jam)')

L '--- service PostgreSQL ---'
$pg = @(Get-Service -Name 'postgresql-aulia3' -ErrorAction SilentlyContinue)
if ($pg.Count -eq 0) { L '  postgresql-aulia3: TIDAK ADA' }
else { L ('  postgresql-aulia3: ' + $pg[0].Status + ' (start=' + $pg[0].StartType + ')') }

L '--- scheduled task ---'
foreach ($n in @('AuliaEvolution', 'AuliaAdapter', 'WA-Gateway')) {
  $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
  if (-not $t) { L ('  ' + $n + ': tidak terdaftar'); continue }
  $i = Get-ScheduledTaskInfo -TaskName $n -ErrorAction SilentlyContinue
  L ('  ' + $n + ': ' + $t.State + '  lastRun=' + $(if ($i) { $i.LastRunTime } else { '-' }) + '  lastResult=' + $(if ($i) { $i.LastTaskResult } else { '-' }))
}

L '--- proses node ---'
$nodes = @(Get-Process -Name node -ErrorAction SilentlyContinue)
if ($nodes.Count -eq 0) { L '  (tidak ada proses node)' }
foreach ($n in $nodes) {
  L ('  pid ' + $n.Id + ' mulai ' + $n.StartTime.ToString('HH:mm:ss') + '  RAM ' + [math]::Round($n.WorkingSet64 / 1MB, 0) + ' MB')
}

L '--- port listen ---'
foreach ($p in @(5432, 8080, 3000)) {
  $c = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
  if ($c.Count -eq 0) { L ('  ' + $p + ': TIDAK listen') }
  else {
    $names = @($c | ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName })
    L ('  ' + $p + ': LISTEN pid=' + (($c | ForEach-Object { $_.OwningProcess }) -join ',') + ' (' + (($names | Select-Object -Unique) -join ',') + ')')
  }
}

L '--- disk C/D ---'
Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Name -in @('C', 'D') } | ForEach-Object {
  L ('  ' + $_.Name + ': free ' + [math]::Round($_.Free / 1GB, 1) + ' GB / ' + [math]::Round(($_.Free + $_.Used) / 1GB, 1) + ' GB')
}

L '--- 8 baris terakhir adapter.log ---'
if (Test-Path 'D:\kilo\logs\adapter.log') {
  Get-Content 'D:\kilo\logs\adapter.log' -Tail 8 | ForEach-Object { L ('  ' + $_) }
} else { L '  (tidak ada adapter.log)' }

L '--- state terakhir yang dilihat adapter ---'
if (Test-Path 'D:\kilo\logs\adapter.log') {
  $st = Get-Content 'D:\kilo\logs\adapter.log' | Select-String -Pattern 'EVOLUTION-STATE' | Select-Object -Last 1
  L ('  ' + $(if ($st) { $st.Line } else { '(belum ada)' }))
}

L '--- error terakhir di evolution.log ---'
if (Test-Path 'D:\kilo\logs\evolution.log') {
  $errs = Get-Content 'D:\kilo\logs\evolution.log' | Select-String -Pattern '"level":(50|60)' | Select-Object -Last 3
  if ($errs) { $errs | ForEach-Object { L ('  ' + ($_.Line -replace "`e\[[0-9;]*m", '')) } } else { L '  (tidak ada error level 50/60)' }
}

L '--- log peringatan webhook/AUTH adapter ---'
if (Test-Path 'D:\kilo\logs\adapter.log') {
  $w = Get-Content 'D:\kilo\logs\adapter.log' | Select-String -Pattern '\[AUTH\]|gagal' | Select-Object -Last 5
  if ($w) { $w | ForEach-Object { L ('  ' + $_.Line) } } else { L '  (tidak ada)' }
}

L '=== SELESAI ==='