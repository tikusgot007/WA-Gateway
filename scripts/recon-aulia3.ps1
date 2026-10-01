<#
  recon-aulia3.ps1 -- read-only inventory of the gateway PC. Safe to re-run.
  Output: D:\kilo\recon.log
#>
$log = 'D:\kilo\recon.log'
New-Item -ItemType Directory -Path 'D:\kilo' -Force | Out-Null
Set-Content -LiteralPath $log -Value ''

function L {
  param([string]$Message)
  Add-Content -LiteralPath $log -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $Message)
}

L '=== RECON AULIA3 ==='
L ('computer: ' + $env:COMPUTERNAME + '  user: ' + $env:USERNAME)
L ('powershell: ' + $PSVersionTable.PSVersion.ToString())
L ('os: ' + (Get-CimInstance Win32_OperatingSystem).Caption)

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  L ('node on PATH: ' + $nodeCmd.Source + ' -> ' + ((& node -v) 2>&1 | Out-String).Trim())
} else {
  L 'node on PATH: False'
}
L ('node.exe bawaan WA-Gateway: ' + (Test-Path 'D:\WA-Gateway\node.exe'))

$pgSvc = @(Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue)
L ('service postgresql*: ' + $pgSvc.Count)
foreach ($s in $pgSvc) { L ('  svc ' + $s.Name + ' status=' + $s.Status + ' start=' + $s.StartType) }
L ('C:\Program Files\PostgreSQL ada: ' + (Test-Path 'C:\Program Files\PostgreSQL'))
if (Test-Path 'C:\Program Files\PostgreSQL') {
  foreach ($d in (Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue)) {
    L ('  versi terpasang: ' + $d.Name)
  }
}
$psql = Get-Command psql -ErrorAction SilentlyContinue
L ('psql on PATH: ' + $(if ($psql) { $psql.Source } else { 'False' }))

$wg = Get-Command winget -ErrorAction SilentlyContinue
L ('winget: ' + [bool]$wg)

Get-PSDrive -PSProvider FileSystem | ForEach-Object {
  L ('disk ' + $_.Name + ' free=' + [math]::Round($_.Free / 1GB, 1) + 'GB total=' + [math]::Round(($_.Free + $_.Used) / 1GB, 1) + 'GB')
}

foreach ($p in @(3000, 8080, 5432)) {
  $c = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
  if ($c.Count -gt 0) {
    $names = @($c | ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName })
    L ('port ' + $p + ' LISTEN pid=' + (($c | ForEach-Object { $_.OwningProcess }) -join ',') + ' proses=' + ($names -join ','))
  } else {
    L ('port ' + $p + ' bebas')
  }
}

foreach ($t in @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match 'WA-Gateway|Evolution|kilo' })) {
  L ('task ' + $t.TaskPath + $t.TaskName + ' state=' + $t.State)
}

foreach ($d in @('D:\evolution-gateway', 'D:\evolution-api-server', 'D:\WA-Gateway')) {
  L ('dir ' + $d + ': ' + (Test-Path $d))
}

L '=== SELESAI ==='