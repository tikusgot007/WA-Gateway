# check-setup-instance-redaction.ps1 -- memastikan setup-instance.js tidak
# mencetak respons mentah (QR/pairing code dan header webhook secret).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Split-Path -Parent $here
$repo = Split-Path -Parent $installer
$js = Join-Path $repo 'scripts\setup-instance.js'
if (-not (Test-Path -LiteralPath $js)) { Write-Host 'FAIL check-setup-instance-redaction: file tidak ada'; exit 1 }

$t = Get-Content -LiteralPath $js -Raw
$bad = @('body: created.json', 'body: restarted.json', 'result }')
$found = @($bad | Where-Object { $t -like ('*' + $_ + '*') })

if ($found.Count -eq 0) { Write-Host 'PASS check-setup-instance-redaction'; exit 0 }
Write-Host ('FAIL check-setup-instance-redaction: pola log mentah ditemukan: ' + ($found -join ', '))
exit 1
