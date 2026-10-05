# check-lid-preservation-patch.ps1
# AC: patch LID idempotent, mempertahankan LID di field khusus, dan
# menghapus logging raw message tanpa mengubah remoteJid PN.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Split-Path -Parent $here

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('lid-' + [guid]::NewGuid().ToString('N'))
$evo = Join-Path $tmp 'evolution-api-server'
$relDir = Join-Path $evo 'src\api\integrations\channel\whatsapp'
New-Item -ItemType Directory -Path $relDir -Force | Out-Null
$file = Join-Path $relDir 'whatsapp.baileys.service.ts'

$fixture = @(
  'export class S {',
  '  async handler(messageRaw: any) {',
  '    this.logger.verbose(messageRaw);',
  "    if (messageRaw.key.remoteJid?.includes('@lid') && messageRaw.key.remoteJidAlt) {",
  '      messageRaw.key.remoteJid = messageRaw.key.remoteJidAlt;',
  '    }',
  '    console.log(messageRaw);',
  '    this.sendDataWebhook(Events.MESSAGES_UPSERT, messageRaw);',
  '  }',
  '}'
)
[IO.File]::WriteAllLines($file, $fixture, (New-Object System.Text.UTF8Encoding($false)))

$patch = Join-Path $installer 'apply-lid-preservation-patch.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $patch -EvolutionDir $evo -LogPath (Join-Path $tmp 'p1.log') | Out-Null
$c1 = @(Select-String -LiteralPath $file -Pattern 'PATCH-ADAPTER-LID' -SimpleMatch).Count
$content1 = Get-Content -LiteralPath $file -Raw
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $patch -EvolutionDir $evo -LogPath (Join-Path $tmp 'p2.log') | Out-Null
$c2 = @(Select-String -LiteralPath $file -Pattern 'PATCH-ADAPTER-LID' -SimpleMatch).Count
$content2 = Get-Content -LiteralPath $file -Raw
$backups = @(Get-ChildItem -LiteralPath $relDir -Filter '*.orig-*' -ErrorAction SilentlyContinue).Count

$ok = (
  $c1 -gt 0 -and
  $c2 -eq $c1 -and
  $backups -eq 1 -and
  $content1 -match '\(messageRaw\.key as any\)\.remoteJidLid = messageRaw\.key\.remoteJid' -and
  $content1 -match 'messageRaw.key.remoteJid = messageRaw.key.remoteJidAlt' -and
  $content1 -notmatch 'console\.log\(messageRaw\)' -and
  $content1 -notmatch 'this\.logger\.verbose\(messageRaw\)' -and
  $content2 -eq $content1
)

Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
if ($ok) { Write-Host 'PASS check-lid-preservation-patch'; exit 0 }
Write-Host 'FAIL check-lid-preservation-patch'
exit 1