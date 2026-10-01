<#
  status-pg.ps1 -- read-only status check for the PostgreSQL install on aulia3.
  Output: D:\kilo\status-pg.log
#>
$log = 'D:\kilo\status-pg.log'
New-Item -ItemType Directory -Path 'D:\kilo' -Force | Out-Null
Set-Content -LiteralPath $log -Value ''
function L { param([string]$m) Add-Content -LiteralPath $log -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) }

$data = 'D:\pgsql16\data'
L ('PG_VERSION ada    : ' + (Test-Path "$data\PG_VERSION"))
L ('superuser.pwd ada: ' + (Test-Path 'D:\pgsql16\superuser.pwd'))
if (Test-Path "$data\postgresql.conf") {
  L ('conf listen      : ' + ((Select-String -LiteralPath "$data\postgresql.conf" -Pattern '^\s*#?\s*listen_addresses' | Select-Object -First 1).Line))
  L ('conf port        : ' + ((Select-String -LiteralPath "$data\postgresql.conf" -Pattern '^\s*#?\s*port\s*=' | Select-Object -First 1).Line))
}
$svc = @(Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue)
L ('service postgresql*: ' + $svc.Count)
foreach ($s in $svc) { L ('  ' + $s.Name + ' status=' + $s.Status + ' start=' + $s.StartType) }

if (Test-Path 'D:\pgsql16\bin\pg_isready.exe') {
  & 'D:\pgsql16\bin\pg_isready.exe' -h localhost -p 5432 -U postgres 2>&1 | ForEach-Object { L ('pg_isready: ' + $_) }
  L ('exit code: ' + $LASTEXITCODE)
}
foreach ($f in @('D:\kilo\install-postgres.log')) {
  if (Test-Path $f) {
    L ('--- 6 baris terakhir ' + $f + ' ---')
    Get-Content $f -Tail 6 | ForEach-Object { L ('  ' + $_) }
  }
}
L '=== SELESAI ==='