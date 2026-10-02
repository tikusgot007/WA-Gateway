# check-viewonce-patch.ps1 -- AC-4: patch view-once idempotent.
# Terapkan ke fixture dua kali; penanda harus tetap 1 blok, backup 1.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Split-Path -Parent $here

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('vw-' + [guid]::NewGuid().ToString('N'))
$evo = Join-Path $tmp 'evolution-api-server'
$relDir = Join-Path $evo 'src\api\integrations\channel\whatsapp'
New-Item -ItemType Directory -Path $relDir -Force | Out-Null
$file = Join-Path $relDir 'whatsapp.baileys.service.ts'
$fixture = @(
  'export class S {',
  '  async handler(received: any) {',
  "    if ((type !== 'notify' && type !== 'append') || editedMessage || !received?.message) {",
  '      continue;',
  '    }',
  '  }',
  '}'
)
[IO.File]::WriteAllLines($file, $fixture, (New-Object System.Text.UTF8Encoding($false)))

$patch = Join-Path $installer 'apply-viewonce-patch.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $patch -EvolutionDir $evo -LogPath (Join-Path $tmp 'p1.log') | Out-Null
$c1 = @(Select-String -LiteralPath $file -Pattern 'PATCH-ADAPTER' -SimpleMatch).Count
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $patch -EvolutionDir $evo -LogPath (Join-Path $tmp 'p2.log') | Out-Null
$c2 = @(Select-String -LiteralPath $file -Pattern 'PATCH-ADAPTER' -SimpleMatch).Count
$backups = @(Get-ChildItem -LiteralPath $relDir -Filter '*.orig-*' -ErrorAction SilentlyContinue).Count

Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
if ($c1 -eq 1 -and $c2 -eq 1 -and $backups -eq 1) { Write-Host 'PASS check-viewonce-patch (AC-4)'; exit 0 }
Write-Host ("FAIL check-viewonce-patch (AC-4): marker1=$c1 marker2=$c2 backups=$backups")
exit 1
