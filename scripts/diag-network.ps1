<#
  diag-network.ps1 -- bounded network/DNS diagnosis on aulia3.
  Every check is time-bounded so a broken resolver cannot hang the script.

  Output: D:\kilo\diag-network.log
#>
$log = 'D:\kilo\diag-network.log'
New-Item -ItemType Directory -Path 'D:\kilo' -Force | Out-Null
Set-Content -LiteralPath $log -Value ''
function L { param([string]$m) Add-Content -LiteralPath $log -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) }

function Test-TcpBounded {
  param([string]$Target, [int]$Port, [int]$TimeoutMs = 3000)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $client.BeginConnect($Target, $Port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return 'TIMEOUT' }
    $client.EndConnect($ar)
    return 'OK'
  } catch {
    return ('ERR: ' + $_.Exception.InnerException.Message)
  } finally { $client.Close() }
}

function Resolve-Bounded {
  param([string]$Name_, [int]$TimeoutMs = 3000)
  try {
    $task = [System.Net.Dns]::BeginGetHostAddresses($Name_, $null, $null)
    if (-not $task.AsyncWaitHandle.WaitOne($TimeoutMs)) { return 'TIMEOUT' }
    $addrs = [System.Net.Dns]::EndGetHostAddresses($task)
    return (($addrs | ForEach-Object { $_.IPAddressToString }) -join ',')
  } catch {
    return ('ERR: ' + $_.Exception.Message)
  }
}

L '=== DIAG NETWORK AULIA3 ==='
L ('computer: ' + $env:COMPUTERNAME)

L '--- resolusi nama (bounded 3s) ---'
foreach ($n in @('localhost', 'AULIA3', 'AULIA-SERVER2', 'nodejs.org')) {
  L ('  dns ' + $n + ' -> ' + (Resolve-Bounded -Name_ $n -TimeoutMs 3000))
}

L '--- tcp (bounded 3s) ---'
foreach ($t in @(@('127.0.0.1', 8080), @('127.0.0.1', 3000), @('192.168.1.10', 80), @('AULIA-SERVER2', 80), @('AULIA3', 8080), @('1.1.1.1', 443))) {
  L ('  tcp ' + $t[0] + ':' + $t[1] + ' -> ' + (Test-TcpBounded -Target $t[0] -Port $t[1] -TimeoutMs 3000))
}

L '--- hosts file ---'
$hosts = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
if (Test-Path $hosts) {
  Get-Content $hosts | Where-Object { $_ -and -not $_.StartsWith('#') } | ForEach-Object { L ('  ' + $_) }
} else { L '  (hosts tidak ada)' }

L '--- test HTTP lokal ke Evolution (127.0.0.1) ---'
$envKey = Select-String -LiteralPath 'D:\evolution-api-server\.env' -Pattern '^AUTHENTICATION_API_KEY=' | Select-Object -First 1
if ($envKey) {
  $key = (($envKey.Line -split '=', 2)[1]).Trim().Trim("'")
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8080' -Headers @{ apikey = $key } -TimeoutSec 10
    L ('  GET / -> ' + ($r | Out-String).Trim())
  } catch {
    L ('  GET / gagal: ' + $_.Exception.Message)
  }
  try {
    $r2 = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/instance/fetchInstances' -Headers @{ apikey = $key } -TimeoutSec 10
    L ('  fetchInstances -> ' + (($r2 | ForEach-Object { $_.name + '=' + $_.connectionStatus }) -join ', '))
  } catch {
    L ('  fetchInstances gagal: ' + $_.Exception.Message)
  }
}
L '=== SELESAI ==='