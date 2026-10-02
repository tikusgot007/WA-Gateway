# check-firewall.ps1 -- AC-10: firewall menolak daftar sumber kosong dan aturan
# yang dibuat terbatas (RemoteAddress + profil Private).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Split-Path -Parent $here
$repo = Split-Path -Parent $installer
$fw = Join-Path $repo 'scripts\allow-lan-ports.ps1'

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('fw-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
# Sumber berisi spasi (bukan string kosong) supaya argumen tidak hilang saat
# diteruskan ke proses anak, dan guard "Daftar sumber kosong" benar-benar diuji.
# EAP dilonggarkan selama pemanggilan native: stderr anak menjadi ErrorRecord
# dan dengan EAP=Stop itu menghentikan skrip ini sebelum penilaian.
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $fw -Sources ' ' -LogPath (Join-Path $tmp 'fw.log') 2>&1 | Out-String
$emptyCode = $LASTEXITCODE
$ErrorActionPreference = $prev
$guarded = ($out -like '*sumber kosong*')

$text = Get-Content -LiteralPath $fw -Raw
$restricted = ($text -like '*-RemoteAddress*') -and ($text -like "*'Private'*" -or $text -like '*$Profile*')

Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
if ($emptyCode -ne 0 -and $guarded -and $restricted) { Write-Host 'PASS check-firewall (AC-10)'; exit 0 }
Write-Host ("FAIL check-firewall (AC-10): exit=$emptyCode guarded=$guarded restricted=$restricted")
exit 1
