<#
  phase2-check.ps1 -- read-only check before installing the adapter stack.
  Output: D:\kilo\phase2-check.log
#>
$log = 'D:\kilo\phase2-check.log'
New-Item -ItemType Directory -Path 'D:\kilo' -Force | Out-Null
Set-Content -LiteralPath $log -Value ''
function L { param([string]$m) Add-Content -LiteralPath $log -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) }

function Test-Tcp {
  param([string]$Host_, [int]$Port, [int]$TimeoutMs = 4000)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $ar = $client.BeginConnect($Host_, $Port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($ar)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

L '=== PASE 2: CHECK SEBELUM INSTALL ADAPTER ==='

L ('node on PATH : ' + [bool](Get-Command node -ErrorAction SilentlyContinue))
L ('npm on PATH  : ' + [bool](Get-Command npm  -ErrorAction SilentlyContinue))
L ('npm.cmd di D:\WA-Gateway : ' + (Test-Path 'D:\WA-Gateway\npm.cmd'))
L ('node.exe di D:\WA-Gateway : ' + (Test-Path 'D:\WA-Gateway\node.exe'))

L '--- konektivitas internet ---'
foreach ($t in @(@('nodejs.org',443), @('registry.npmjs.org',443), @('github.com',443), @('1.1.1.1',53))) {
  L ($t[0] + ':' + $t[1] + ' = ' + (Test-Tcp -Host_ $t[0] -Port $t[1]))
}

L '--- repo adapter ---'
L ('D:\evolution-gateway ada      : ' + (Test-Path 'D:\evolution-gateway\package.json'))
L ('D:\evolution-gateway node_modules: ' + (Test-Path 'D:\evolution-gateway\node_modules'))
L ('D:\evolution-gateway .env      : ' + (Test-Path 'D:\evolution-gateway\.env'))
L ('D:\evolution-api-server .env   : ' + (Test-Path 'D:\evolution-api-server\.env'))

L '--- postgres ---'
$svc = @(Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue)
foreach ($s in $svc) { L ('service ' + $s.Name + ' = ' + $s.Status + ' (' + $s.StartType + ')') }

L '=== SELESAI ==='