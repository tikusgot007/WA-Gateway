# check-static.ps1 -- AC-12 (tanpa scheduled task) + AC-13 (tanpa literal aulia3
# di dalam paket installer).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Split-Path -Parent $here
$repo = Split-Path -Parent $installer

$problems = New-Object System.Collections.Generic.List[string]

# 1. Tidak ada registrasi scheduled task di dalam paket.
$taskPatterns = @('Register-ScheduledTask', 'New-ScheduledTaskAction', 'New-ScheduledTaskTrigger', 'schtasks')
# Kecualikan folder tests (skrip cek sendiri memuat kata kunci yang dicari).
# -Include diabaikan saat dipakai dengan -LiteralPath, jadi disaring manual.
$files = @(Get-ChildItem -LiteralPath $installer -Recurse -File |
  Where-Object { $_.Extension -in '.ps1', '.md', '.js' -and $_.FullName -notlike '*\tests\*' })
foreach ($f in $files) {
  $t = Get-Content -LiteralPath $f.FullName -Raw
  foreach ($p in $taskPatterns) {
    if ($t -like ('*' + $p + '*')) { $problems.Add('scheduled-task pattern "' + $p + '" di ' + $f.FullName) }
  }
}

# 2. Tidak ada literal aulia3 / drive D: di dalam paket installer.
$forbidden = @('aulia3', 'AULIA3', 'AULIA-SERVER2', 'D:\')
foreach ($f in $files) {
  $t = Get-Content -LiteralPath $f.FullName -Raw
  foreach ($p in $forbidden) {
    if ($t -like ('*' + $p + '*')) { $problems.Add('literal "' + $p + '" di ' + $f.FullName) }
  }
}

# 3. Task aulia3 tidak terdaftar di mesin ini.
foreach ($n in @('AuliaEvolution', 'AuliaAdapter', 'AuliaStackWatchdog')) {
  $task = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
  if ($task) { $problems.Add('scheduled task terdaftar: ' + $n) }
}

# 4. Script yang diubah bersih dari literal host/instance.
$instanceJs = Join-Path $repo 'scripts\setup-instance.js'
if (Test-Path -LiteralPath $instanceJs) {
  $t = Get-Content -LiteralPath $instanceJs -Raw
  foreach ($p in @('AULIA3', 'aulia-toko', 'D:\')) {
    if ($t -like ('*' + $p + '*')) { $problems.Add('literal "' + $p + '" di scripts\setup-instance.js') }
  }
}

if ($problems.Count -eq 0) { Write-Host 'PASS check-static (AC-12/AC-13)'; exit 0 }
Write-Host 'FAIL check-static (AC-12/AC-13):'
foreach ($p in $problems) { Write-Host ('  - ' + $p) }
exit 1
