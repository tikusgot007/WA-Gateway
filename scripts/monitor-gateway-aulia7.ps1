<#
  monitor-gateway-aulia7.ps1 -- lightweight periodic health/trend monitor for the
  aulia7 Evolution gateway stack (Windows Service / WinSW).

  Adaptation of monitor-aulia3.ps1 for aulia7:
    - adapter log : AuliaPosGatewayAdapter.out.log (JSON/pino)
    - evolution log: AuliaPosGatewayEvolution.out.log (plaintext + ANSI, NOT JSON)
    - process state: Windows services (AuliaPosGatewayEvolution/Adapter), not tasks
    - log rotation : WinSW roll-by-size (*.<n>.out.log)
    - base paths   : C:\AuliaPosGateway\logs

  Read-only; append-only one summary line per run (a detail block on WARN).
  Exit 1 on WARN/CRITICAL so the Scheduled Task LastTaskResult is visible.

  Register the task once, ON aulia7 (every 15 minutes):
    powershell -NoProfile -ExecutionPolicy Bypass -File <path> -InstallTask

  Manual dry-run (no log write):
    powershell -NoProfile -ExecutionPolicy Bypass -File <path> -NoWrite
#>
[CmdletBinding()]
param(
  [string]$LogDir            = 'C:\AuliaPosGateway\logs',
  [string]$OutLog            = 'C:\AuliaPosGateway\logs\monitor-gateway-aulia7.log',
  [string]$RemoteHost        = '',
  [int]   $PgPort            = 5432,
  [int]   $EvolutionPort     = 8080,
  [int]   $AdapterPort       = 3000,
  [string]$EvolutionService  = 'AuliaPosGatewayEvolution',
  [string]$AdapterService    = 'AuliaPosGatewayAdapter',
  [int]   $WindowHours       = 24,
  [int]   $KeepAliveWarn     = 3,
  [int]   $F10WindowMinutes  = 15,
  [int]   $F10CriticalDecrypt = 10,
  [int]   $F10CriticalStub   = 5,
  [switch]$InstallTask,
  [switch]$NoWrite,
  [switch]$Quiet
)

$ErrorActionPreference = 'Continue'

function Install-MonitorTask {
  param([string]$ScriptPath, [int]$Window)
  $tr = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $ScriptPath + '" -WindowHours ' + $Window
  $out = & schtasks /create /tn 'AuliaPosGatewayMonitor' /tr $tr /sc MINUTE /mo 15 /ru SYSTEM /rl HIGHEST /f 2>&1
  Write-Host (($out | ForEach-Object { $_.ToString() }) -join "`n")
  exit $LASTEXITCODE
}

if ($InstallTask) { Install-MonitorTask -ScriptPath $MyInvocation.MyCommand.Path -Window $WindowHours }

$now       = Get-Date
$cutoff    = $now.AddHours(-$WindowHours)
$f10Cutoff = $now.AddMinutes(-$F10WindowMinutes)
$ansi      = "\x1B\[[0-9;]*[mK]"

function Test-PortUp {
  param([int]$Port)
  if ($RemoteHost) {
    return [bool](Test-NetConnection -ComputerName $RemoteHost -Port $Port -WarningAction SilentlyContinue).TcpTestSucceeded
  }
  return (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -gt 0)
}

# --- adapter log (JSON/pino) ----------------------------------------------
$adapterPath   = Join-Path $LogDir 'AuliaPosGatewayAdapter.out.log'
$lastState     = '(belum ada)'
$lastStateTime = $null
$flaps = 0; $authReject = 0; $lvl40 = 0; $delivered = 0; $sent = 0
$adapterNotes  = @()
if (Test-Path -LiteralPath $adapterPath) {
  foreach ($ln in (Get-Content -LiteralPath $adapterPath -ErrorAction SilentlyContinue)) {
    $o = $null
    try { $o = $ln | ConvertFrom-Json } catch { continue }
    $t = $null
    if ($o.time -and $o.time -match '^20') { try { $t = ([datetime]$o.time).ToLocalTime() } catch {} }
    if ($o.msg -like '*EVOLUTION-STATE*') {
      $lastState = ([string]$o.status) + $(if ($o.phone) { '(' + $o.phone + ')' } else { '' })
      if ($t) { $lastStateTime = $t }
      if ($t -and $t -ge $cutoff -and $o.status -ne 'connected') { $flaps++ }
    }
    if (-not $t -or $t -lt $cutoff) { continue }
    if ($o.level -ge 40) { $lvl40++ }
    if ($ln -match '\[AUTH\]|ditolak|secret tidak cocok|secret absen') { $authReject++ }
    if ($o.msg -like '*pesan masuk berhasil diteruskan*') { $delivered++ }
    if ($o.msg -like '*kirim berhasil*') { $sent++ }
  }
} else { $adapterNotes += 'adapter log tidak ada' }

# --- evolution log (plaintext + ANSI; WinSW roll) -------------------------
$evoCur   = Join-Path $LogDir 'AuliaPosGatewayEvolution.out.log'
$evoFiles = @()
if (Test-Path -LiteralPath $evoCur) { $evoFiles += $evoCur }
$evoFiles += @(Get-ChildItem -LiteralPath $LogDir -Filter 'AuliaPosGatewayEvolution.*.out.log' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 3 | ForEach-Object { $_.FullName })

$keepAlive = 0; $streamErr = 0; $initErr = 0; $handleErr = 0; $evoLevel50 = 0; $cacheErr = 0
$f10DecryptFail = 0; $f10SessionNoMatch = 0; $f10StubIgnored = 0; $f10MessageCounter = 0
$f10RecentDecryptFail = 0; $f10RecentSessionNoMatch = 0; $f10RecentStubIgnored = 0; $f10RecentMessageCounter = 0
$f10LastEventLocal = $null; $f10LastEventType = $null
$tsRe = '(\w{3} \w{3} \d{2} \d{4} \d{2}:\d{2}:\d{2})'
foreach ($fp in $evoFiles) {
  foreach ($raw in (Get-Content -LiteralPath $fp -ErrorAction SilentlyContinue)) {
    $ln = $raw -replace $ansi, ''
    $t = $null
    $mm = [regex]::Match($ln, $tsRe)
    if ($mm.Success) {
      try { $t = [datetime]::ParseExact($mm.Groups[1].Value, 'ddd MMM dd yyyy HH:mm:ss', [System.Globalization.CultureInfo]::InvariantCulture) } catch {}
    }
    if ($t -and $t -lt $cutoff) { continue }
    if ($ln -match 'error in sending keep alive') { $keepAlive++ }
    if ($ln -match 'stream errored out') { $streamErr++ }
    if ($ln -match "unexpected error in 'init queries'") { $initErr++ }
    if ($ln -match 'error in handling message') { $handleErr++ }
    if ($ln -match '"level":(50|60)') { $evoLevel50++ }
    if ($ln -match 'saveOnWhatsappCache') { $cacheErr++ }

    $f10Type = $null
    if ($ln -match 'No matching sessions found for message') { $f10SessionNoMatch++; $f10Type = 'SESSION_NO_MATCH' }
    elseif ($ln -match 'failed to decrypt message|failed to decrypt|decryption failed') { $f10DecryptFail++; $f10Type = 'DECRYPT_FAIL' }
    elseif ($ln -match 'Message ignored with messageStubParameters') { $f10StubIgnored++; $f10Type = 'STUB_IGNORED' }
    elseif ($ln -match 'MessageCounterError') { $f10MessageCounter++; $f10Type = 'MESSAGE_COUNTER' }

    if ($f10Type) {
      if ($t) {
        if (-not $f10LastEventLocal -or $t -gt $f10LastEventLocal) { $f10LastEventLocal = $t; $f10LastEventType = $f10Type }
      }
      if ($t -and $t -ge $f10Cutoff) {
        switch ($f10Type) {
          'SESSION_NO_MATCH' { $f10RecentSessionNoMatch++ }
          'DECRYPT_FAIL'     { $f10RecentDecryptFail++ }
          'STUB_IGNORED'     { $f10RecentStubIgnored++ }
          'MESSAGE_COUNTER'  { $f10RecentMessageCounter++ }
        }
      }
    }
  }
}

$evoSize = -1; $evoAgeMin = -1
if (Test-Path -LiteralPath $evoCur) {
  $fi = Get-Item -LiteralPath $evoCur
  $evoSize = $fi.Length
  $evoAgeMin = [math]::Round(($now - $fi.LastWriteTime).TotalMinutes, 0)
}

# --- ports ----------------------------------------------------------------
$pgChecked = -not $RemoteHost
$pgUp  = if ($pgChecked) { Test-PortUp -Port $PgPort } else { $true }
$evoUp = Test-PortUp -Port $EvolutionPort
$adUp  = Test-PortUp -Port $AdapterPort

# --- windows services (local only) ----------------------------------------
$svcInfo = @()
$svcBad  = @()
if (-not $RemoteHost) {
  foreach ($n in @($EvolutionService, $AdapterService)) {
    $s = Get-Service -Name $n -ErrorAction SilentlyContinue
    if (-not $s) { $svcInfo += ($n + '=tidak_terdaftar'); $svcBad += $n; continue }
    $svcInfo += ($n + '=' + $s.Status)
    if ($s.Status -ne 'Running') { $svcBad += $n }
  }
} else { $svcInfo += 'svc=skip(remote)' }

# --- decide status --------------------------------------------------------
$reasons = @()
if ($pgChecked -and -not $pgUp) { $reasons += 'postgres tidak listen' }
if (-not $evoUp) { $reasons += 'evolution tidak listen' }
if (-not $adUp)  { $reasons += 'adapter tidak listen' }
foreach ($n in $svcBad) { $reasons += ('service ' + $n + ' tidak Running') }
if ($lastState -ne '(belum ada)' -and $lastState -notlike 'connected*') { $reasons += 'state terakhir bukan connected (' + $lastState + ')' }
if ($authReject -gt 0) { $reasons += ('AUTH/webhook ditolak: ' + $authReject) }
if ($keepAlive -ge $KeepAliveWarn) { $reasons += ('keep-alive berulang: ' + $keepAlive) }

$f10RecentTotal = $f10RecentDecryptFail + $f10RecentSessionNoMatch + $f10RecentStubIgnored + $f10RecentMessageCounter
$f10Critical = ($f10RecentDecryptFail -ge $F10CriticalDecrypt -or $f10RecentStubIgnored -ge $F10CriticalStub)
if ($f10RecentTotal -gt 0) {
  $reasons += ('F10 ingress failure: recent=' + $f10RecentTotal + ' decrypt=' + $f10RecentDecryptFail + ' sessionNoMatch=' + $f10RecentSessionNoMatch + ' stubIgnored=' + $f10RecentStubIgnored + ' messageCounter=' + $f10RecentMessageCounter)
}
$evoStale = ($evoSize -eq 0)
if ($evoStale -and $delivered -gt 0) { $reasons += 'evolution log 0 byte padahal ada trafik (blind spot)' }

$status = if ($f10Critical) { 'CRITICAL' } elseif ($reasons.Count -gt 0) { 'WARN' } else { 'OK' }

# --- write ----------------------------------------------------------------
$stamp = $now.ToString('yyyy-MM-dd HH:mm:ss')
$summary = ($stamp + ' | ' + $status +
  ' | pg=' + $(if (-not $pgChecked) { 'n/a' } elseif ($pgUp) { 'up' } else { 'DOWN' }) +
  ' evo=' + $(if ($evoUp) { 'up' } else { 'DOWN' }) +
  ' adapter=' + $(if ($adUp) { 'up' } else { 'DOWN' }) +
  ' | state=' + $lastState +
  ' | flaps=' + $flaps + ' keepAlive=' + $keepAlive + ' authReject=' + $authReject +
  ' | f10_24h=' + ($f10DecryptFail + $f10SessionNoMatch + $f10StubIgnored + $f10MessageCounter) +
  ' f10_recent=' + $f10RecentTotal +
  ' decrypt=' + $f10RecentDecryptFail + ' sessionNoMatch=' + $f10RecentSessionNoMatch +
  ' stubIgnored=' + $f10RecentStubIgnored + ' msgCounter=' + $f10RecentMessageCounter +
  ' lvl40adapter=' + $lvl40 + ' evo50=' + $evoLevel50 + ' cacheErr=' + $cacheErr +
  ' hdlErr=' + $handleErr + ' streamErr=' + $streamErr + ' initErr=' + $initErr +
  ' | delivered=' + $delivered + ' sent=' + $sent +
  ' | evolution.log=' + $(if ($evoSize -ge 0) { '' + $evoSize + 'B age=' + $evoAgeMin + 'min' + $(if ($evoStale) { ' STALE' } else { '' }) } else { 'tidak ada' }) +
  ' | window=' + $WindowHours + 'h')

$detail = @()
$detail += '===== DETIL ' + $stamp + ' (' + $status + ') ====='
$detail += 'port        : pg=' + $(if ($pgChecked) { $pgUp } else { 'n/a' }) + ' evolution=' + $evoUp + ' adapter=' + $adUp
$detail += 'service     : ' + ($svcInfo -join '; ')
$detail += 'state       : ' + $lastState + $(if ($lastStateTime) { '  (jam ' + $lastStateTime.ToString('yyyy-MM-dd HH:mm') + ' WIB)' } else { '' })
$detail += 'tren ' + $WindowHours + 'j   : flaps=' + $flaps + ' keepAlive=' + $keepAlive + ' authReject=' + $authReject + ' adapterLvl40=' + $lvl40 + ' evo50=' + $evoLevel50 + ' cacheErr=' + $cacheErr + ' handleErr=' + $handleErr + ' streamErr=' + $streamErr + ' initErr=' + $initErr
$detail += 'F10         : 24h=' + ($f10DecryptFail + $f10SessionNoMatch + $f10StubIgnored + $f10MessageCounter) + ' recent=' + $f10RecentTotal + ' decrypt=' + $f10RecentDecryptFail + ' sessionNoMatch=' + $f10RecentSessionNoMatch + ' stubIgnored=' + $f10RecentStubIgnored + ' messageCounter=' + $f10RecentMessageCounter + ' last=' + $(if ($f10LastEventLocal) { $f10LastEventLocal.ToString('yyyy-MM-dd HH:mm:ss') + ' WIB/' + $f10LastEventType } else { 'none' }) + ' window=' + $F10WindowMinutes + 'm'
$detail += 'trafik      : delivered=' + $delivered + ' sent=' + $sent
$detail += 'evolution.log: size=' + $evoSize + 'B age=' + $evoAgeMin + 'min stale=' + $evoStale
foreach ($n in $adapterNotes) { $detail += 'catatan     : ' + $n }
if ($reasons.Count -gt 0) { $detail += 'ALASAN WARN : ' + ($reasons -join '; ') }
$detail += ''

if ($NoWrite) {
  Write-Host $summary
  if (-not $Quiet) { $detail | ForEach-Object { Write-Host $_ } }
} else {
  Add-Content -LiteralPath $OutLog -Value $summary
  if ($status -ne 'OK') { Add-Content -LiteralPath $OutLog -Value $detail }
  if (-not $Quiet) { Write-Host $summary }
}

if ($status -ne 'OK') { exit 1 }
exit 0
