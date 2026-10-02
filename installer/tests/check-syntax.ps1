# check-syntax.ps1 -- parse semua skrip PowerShell paket + script yang diubah
# tanpa menjalankannya (menangkap salah ketik/sintaks).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Split-Path -Parent $here
$repo = Split-Path -Parent $installer

$files = @(Get-ChildItem -LiteralPath $installer -Recurse -File |
  Where-Object { $_.Extension -eq '.ps1' -and $_.FullName -notlike '*\tests\*' })
$setupEnv = Join-Path $repo 'scripts\setup-env.ps1'
if (Test-Path -LiteralPath $setupEnv) { $files += Get-Item -LiteralPath $setupEnv }

$bad = 0
foreach ($f in $files) {
  $errs = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$errs)
  if ($errs -and $errs.Count -gt 0) {
    $bad++
    Write-Host ('  ERROR ' + $f.Name + ': ' + $errs[0].Message)
  }
}
if ($bad -eq 0) { Write-Host ('PASS check-syntax (' + $files.Count + ' file)'); exit 0 }
Write-Host ('FAIL check-syntax: ' + $bad + ' file bermasalah')
exit 1
