# check-static.ps1 -- AC-12 (tanpa scheduled task, tanpa NSSM) + AC-13 (tanpa
# literal aulia3 di dalam paket installer) + AC-8 (service WinSW WAJIB ada:
# template, install.ps1, start.ps1/stop.ps1 berbasis Start-Service/Stop-Service).
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

# 3b. Installer tidak boleh memuat SELURUH .env Evolution ke environment proses
# (LOG_LEVEL dkk terbawa ke proses anak/adapter dan membuat pino gagal).
foreach ($f in $files) {
  $t = Get-Content -LiteralPath $f.FullName -Raw
  if ($t -like '*Import-DotEnv*') { $problems.Add('Import-DotEnv (memuat .env penuh) di ' + $f.FullName) }
}

# 4. Script yang diubah bersih dari literal host/instance.
$instanceJs = Join-Path $repo 'scripts\setup-instance.js'
if (Test-Path -LiteralPath $instanceJs) {
  $t = Get-Content -LiteralPath $instanceJs -Raw
  foreach ($p in @('AULIA3', 'aulia-toko', 'D:\')) {
    if ($t -like ('*' + $p + '*')) { $problems.Add('literal "' + $p + '" di scripts\setup-instance.js') }
  }
}

# 5. Mekanisme service WAJIB ada (AC-1/AC-8): template XML WinSW ada,
#    install.ps1 mendaftarkan lewat WinSW, start/stop memakai
#    Start-Service/Stop-Service (bukan lagi Start-Process / pencarian port).
$evoTemplate = Join-Path $installer 'services\evolution-service.xml.template'
$adapterTemplate = Join-Path $installer 'services\adapter-service.xml.template'
if (-not (Test-Path -LiteralPath $evoTemplate)) { $problems.Add('template service Evolution tidak ada: ' + $evoTemplate) }
if (-not (Test-Path -LiteralPath $adapterTemplate)) { $problems.Add('template service adapter tidak ada: ' + $adapterTemplate) }

$installPs1Path = Join-Path $installer 'install.ps1'
$installPs1 = Get-Content -LiteralPath $installPs1Path -Raw
foreach ($token in @('Ensure-WinSW', 'Install-WinSwService')) {
  if ($installPs1 -notlike ('*' + $token + '*')) { $problems.Add('install.ps1 tidak memuat ' + $token + ' (mekanisme service hilang)') }
}

$startPs1Path = Join-Path $installer 'start.ps1'
$startPs1 = Get-Content -LiteralPath $startPs1Path -Raw
if ($startPs1 -notlike '*Start-Service*') { $problems.Add('start.ps1 tidak memakai Start-Service') }
if ($startPs1 -like '*Start-Process*') { $problems.Add('start.ps1 masih memakai Start-Process (seharusnya service-based)') }

$stopPs1Path = Join-Path $installer 'stop.ps1'
$stopPs1 = Get-Content -LiteralPath $stopPs1Path -Raw
if ($stopPs1 -notlike '*Stop-Service*') { $problems.Add('stop.ps1 tidak memakai Stop-Service') }

# 6. NSSM secara eksplisit tidak dipakai (keputusan user; WinSW saja).
foreach ($f in $files) {
  $t = Get-Content -LiteralPath $f.FullName -Raw
  foreach ($p in @('nssm', 'NSSM')) {
    if ($t -like ('*' + $p + '*')) { $problems.Add('literal "' + $p + '" di ' + $f.FullName + ' (NSSM tidak dipakai, hanya WinSW)') }
  }
}

if ($problems.Count -eq 0) { Write-Host 'PASS check-static (AC-8/AC-12/AC-13)'; exit 0 }
Write-Host 'FAIL check-static (AC-8/AC-12/AC-13):'
foreach ($p in $problems) { Write-Host ('  - ' + $p) }
exit 1
