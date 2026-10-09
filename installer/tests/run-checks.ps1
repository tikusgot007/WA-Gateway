# run-checks.ps1 -- jalankan semua cek yang bisa dieksekusi tanpa PC baru.
# Keluar 1 kalau ada yang gagal.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$checks = @(
  'check-viewonce-patch.ps1',
  'check-lid-preservation-patch.ps1',
  'check-git-source.ps1',
  'check-env-parity.ps1',
  'check-firewall.ps1',
  'check-runbook.ps1',
  'check-static.ps1',
  'check-setup-instance-redaction.ps1',
  'check-syntax.ps1'
)
$failed = 0
foreach ($c in $checks) {
  $path = Join-Path $here $c
  Write-Host ('--- ' + $c + ' ---')
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $path
  if ($LASTEXITCODE -ne 0) { $failed++ }
}
Write-Host ('=== ' + ($checks.Count - $failed) + '/' + $checks.Count + ' cek lulus ===')
if ($failed -gt 0) { exit 1 }
exit 0
