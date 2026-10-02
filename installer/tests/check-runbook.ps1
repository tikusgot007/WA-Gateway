# check-runbook.ps1 -- AC-14/AC-15: panduan penggunaan lengkap dan memakai
# path/host netral (tanpa literal aulia3 / D:\).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Split-Path -Parent $here
$doc = Join-Path $installer 'petunjuk-penggunaan.md'
if (-not (Test-Path -LiteralPath $doc)) { Write-Host 'FAIL check-runbook: file tidak ada'; exit 1 }
$text = Get-Content -LiteralPath $doc -Raw

$sections = @(
  '## 1. Prasyarat', '## 2. Instalasi', '## 3. Start / Stop / Status',
  '## 4. Menautkan nomor WhatsApp', '## 5. Verifikasi',
  '## 6. Menyambungkan ke AuliaPos', '## 7. Perawatan dan keamanan',
  '## 8. Penanganan masalah'
)
$needed = @('inbox.gatewayBaseUrl', 'inbox.gatewayToken', 'scan QR', 'start.ps1', 'stop.ps1', 'status.ps1', 'install.ps1')
$forbidden = @('aulia3', 'AULIA3', 'AULIA-SERVER2', 'D:\')

$missing = @($sections + $needed | Where-Object { $text -notlike ('*' + $_ + '*') })
$bad = @($forbidden | Where-Object { $text -like ('*' + $_ + '*') })

if ($missing.Count -eq 0 -and $bad.Count -eq 0) { Write-Host 'PASS check-runbook (AC-14/AC-15)'; exit 0 }
Write-Host ('FAIL check-runbook (AC-14/AC-15): missing=[' + ($missing -join ', ') + '] forbidden=[' + ($bad -join ', ') + ']')
exit 1
