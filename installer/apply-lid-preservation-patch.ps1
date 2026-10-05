<#
  apply-lid-preservation-patch.ps1 -- pertahankan LID asli saat Evolution
  mengubah remoteJid LID menjadi PN sebelum webhook MESSAGES_UPSERT.

  Tujuan F8:
  - remoteJid tetap PN agar kontrak Inbox tidak berubah.
  - LID asli disimpan di key.remoteJidLid sebagai metadata internal.
  - remoteJidAlt TIDAK dipakai ulang/diubah artinya.
  - raw message logging dihapus dari jalur ini.

  Idempotent: bila marker sudah ada, tidak menulis ulang.
  Membuat backup .orig-<timestamp> sebelum perubahan pertama.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$EvolutionDir,
  [string]$LogPath
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'lib\common.ps1')

if (-not $LogPath) {
  $logDir = Join-Path (Split-Path -Parent $EvolutionDir) 'logs'
  if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  $LogPath = Join-Path $logDir 'apply-lid-preservation-patch.log'
}
Initialize-AuliaLog -Path $LogPath -Reset

$marker = 'PATCH-ADAPTER-LID (2026-10-04)'
$rel = 'src\api\integrations\channel\whatsapp\whatsapp.baileys.service.ts'
$target = Join-Path $EvolutionDir $rel
$anchor = "if (messageRaw.key.remoteJid?.includes('@lid') && messageRaw.key.remoteJidAlt) {"
$assignment = 'messageRaw.key.remoteJid = messageRaw.key.remoteJidAlt;'

try {
  Write-Log '=== APPLY LID PRESERVATION PATCH ==='
  if (-not (Test-Path -LiteralPath $target)) { throw ('Berkas target tidak ditemukan: ' + $target) }

  $lines = @(Get-Content -LiteralPath $target)

  foreach ($l in $lines) {
    if ($l -like ('*' + $marker + '*')) {
      Write-Log 'patch LID: sudah terpasang (dilewati).'
      Write-Log '=== SELESAI ==='
      exit 0
    }
  }

  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -eq $anchor) { $idx = $i; break }
  }
  if ($idx -lt 0) {
    throw ('Anchor LID tidak ditemukan di ' + $target + ' -- versi Evolution mungkin berbeda.')
  }
  if ($idx + 2 -ge $lines.Count) {
    throw 'Blok remoteJid LID terpotong; abort agar patch tidak salah lokasi.'
  }
  if ($lines[$idx + 1].Trim() -ne $assignment) {
    throw ('Baris remoteJid setelah anchor tidak sesuai; abort untuk mencegah patch pada kode yang berbeda.')
  }

  $indent = $lines[$idx] -replace '\S.*$', ''
  $new = New-Object System.Collections.Generic.List[string]

  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]

    if ($i -eq $idx) {
      $new.Add($indent + '// ' + $marker + ': preserve original customer LID before PN normalization')
      $new.Add($indent + '// remoteJid remains PN for existing Inbox/chat consumers; the LID')
      $new.Add($indent + '// is carried only as adapter metadata for MESSAGE_EDIT key derivation.')
      $new.Add($line)
      $new.Add($indent + '  (messageRaw.key as any).remoteJidLid = messageRaw.key.remoteJid;')
      continue
    }

    if ($line.Trim() -eq 'console.log(messageRaw);') { continue }
    if ($line.Trim() -eq 'this.logger.verbose(messageRaw);') { continue }
    $new.Add($line)
  }

  $backup = $target + '.orig-' + (Get-Date -Format 'yyyyMMddHHmmss')
  Copy-Item -LiteralPath $target -Destination $backup
  Write-Log ('patch LID: backup -> ' + $backup)

  [IO.File]::WriteAllLines($target, $new, (New-Object System.Text.UTF8Encoding($false)))

  $after = @(Get-Content -LiteralPath $target)
  $markerCount = @($after | Where-Object { $_ -like ('*' + $marker + '*') }).Count
  $lidCount = @($after | Where-Object { $_ -like '*(messageRaw.key as any).remoteJidLid = messageRaw.key.remoteJid;*' }).Count
  $consoleCount = @($after | Where-Object { $_.Trim() -eq 'console.log(messageRaw);' }).Count
  $verboseCount = @($after | Where-Object { $_.Trim() -eq 'this.logger.verbose(messageRaw);' }).Count

  if ($markerCount -lt 1 -or $lidCount -ne 1 -or $consoleCount -ne 0 -or $verboseCount -ne 0) {
    throw ('Verifikasi patch gagal: marker=' + $markerCount + ' lid=' + $lidCount + ' console=' + $consoleCount + ' verbose=' + $verboseCount)
  }

  Write-Log 'patch LID: terpasang; remoteJid tetap PN, remoteJidLid menyimpan LID, raw logging dihapus.'
  Write-Log '=== SELESAI ==='
  exit 0
} catch {
  Write-Log ('GAGAL: ' + $_.Exception.Message)
  exit 1
}