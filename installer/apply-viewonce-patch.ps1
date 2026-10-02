<#
  apply-viewonce-patch.ps1 -- terapkan patch Evolution agar pesan view-once
  diteruskan ke webhook. Sumber: docs/evolution-viewonce-patch.md (TODO-F3).

  Idempotent: kalau penanda PATCH-ADAPTER sudah ada, tidak menulis apa pun.
  Membuat backup .orig-<tanggal> SEKALI sebelum mengubah.

  Butuh: -EvolutionDir (folder sumber Evolution API hasil unduhan).
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
  $LogPath = Join-Path $logDir 'apply-viewonce-patch.log'
}
Initialize-AuliaLog -Path $LogPath -Reset

$marker = 'PATCH-ADAPTER (2026-10-01)'
$rel = 'src\api\integrations\channel\whatsapp\whatsapp.baileys.service.ts'
$target = Join-Path $EvolutionDir $rel
$anchor = "if ((type !== 'notify' && type !== 'append') || editedMessage || !received?.message) {"

try {
  Write-Log '=== APPLY VIEW-ONCE PATCH ==='
  if (-not (Test-Path -LiteralPath $target)) { throw ('Berkas target tidak ditemukan: ' + $target) }

  $lines = @(Get-Content -LiteralPath $target)

  $already = $false
  foreach ($l in $lines) { if ($l -like ('*' + $marker + '*')) { $already = $true; break } }
  if ($already) {
    Write-Log 'patch view-once: sudah terpasang (dilewati).'
    Write-Log '=== SELESAI ==='
    exit 0
  }

  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -eq $anchor) { $idx = $i; break }
  }
  if ($idx -lt 0) { throw ('Baris anchor tidak ditemukan di ' + $target + ' -- versi Evolution mungkin berbeda.') }

  # Ambil indentasi baris anchor (spasi awal saja).
  $indent = $lines[$idx] -replace '\S.*$', ''

  $block = @(
    ($indent + '// ' + $marker + ': view-once dari HP tiba sebagai stanza'),
    ($indent + '// <unavailable type="view_once"> -- TANPA `message`, hanya'),
    ($indent + '// key.isViewOnce. Tanpa rekonstruksi ini Evolution membuang pesannya'),
    ($indent + '// dan webhook MESSAGES_UPSERT tidak pernah dikirim, sehingga pesan'),
    ($indent + '// hilang senyap. Isi kosong diisi placeholder agar prepareMessage() aman.'),
    ($indent + 'if (!received?.message && received?.key?.isViewOnce) {'),
    ($indent + "  received.message = { conversation: '' } as any;"),
    ($indent + '}')
  )

  $backup = $target + '.orig-' + (Get-Date -Format 'yyyyMMddHHmmss')
  Copy-Item -LiteralPath $target -Destination $backup
  Write-Log ('patch view-once: backup -> ' + $backup)

  $new = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($i -eq $idx) { foreach ($b in $block) { $new.Add($b) } }
    $new.Add($lines[$i])
  }
  [IO.File]::WriteAllLines($target, $new, (New-Object System.Text.UTF8Encoding($false)))

  $count = 0
  foreach ($l in (Get-Content -LiteralPath $target)) { if ($l -like ('*' + $marker + '*')) { $count++ } }
  if ($count -lt 1) { throw 'Patch ditulis tetapi penanda tidak ditemukan setelah penulisan.' }
  Write-Log ('patch view-once: terpasang (penanda muncul ' + $count + ' kali).')
  Write-Log '=== SELESAI ==='
  exit 0
} catch {
  Write-Log ('GAGAL: ' + $_.Exception.Message)
  exit 1
}
