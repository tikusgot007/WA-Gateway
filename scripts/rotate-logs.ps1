<#
  rotate-logs.ps1 -- rotasi + prune log gateway (adapter/Evolusi).

  Dipakai dua cara:
  - Dari run-adapter.cmd / run-evolution.cmd SEBELUM node start: file log
    belum dipegang proses, jadi aman dipindah.
        rotate-logs.ps1 -LogName adapter.log
  - Sebagai task terjadwal (prune arsip saja, tanpa menyentuh log hidup):
        rotate-logs.ps1

  Kenapa rotasi saat boot: log gateway ditulis proses lewat `>>` sehingga file
  DIPEGANG proses hidup dan tidak bisa dipindah saat itu. PC gateway mati tiap
  malam, jadi setiap boot = satu file log baru (praktis rotasi harian) tanpa
  downtime tambahan. Task harian hanya merapikan arsip.

  Output: D:\kilo\rotate-logs.log
#>
[CmdletBinding()]
param(
  [string]$LogDir    = 'D:\kilo\logs',
  [string]$ArisipDir = 'D:\kilo\logs\arsip',
  [int]   $KeepDays  = 180,
  [string]$LogName   = '',
  [switch]$NoCompress,
  [string]$LogPath   = 'D:\kilo\rotate-logs.log'
)

$ErrorActionPreference = 'Continue'
New-Item -ItemType Directory -Path $ArisipDir -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null

function L { param([string]$m) Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) }

function Rotate-One {
  param([string]$Path, [string]$Stamp)

  if (-not (Test-Path -LiteralPath $Path)) { L ("skip (tidak ada): $Path"); return }
  $item = Get-Item -LiteralPath $Path
  if ($item.Length -le 0) { L ("skip (kosong): $Path"); return }

  $base = [IO.Path]::GetFileNameWithoutExtension($item.Name)
  $dest = Join-Path $ArisipDir ($base + '_' + $Stamp + '.log')

  try {
    Move-Item -LiteralPath $Path -Destination $dest -Force
    L ("rotasi: $($item.Name) ($($item.Length) B) -> $(Split-Path -Leaf $dest)")
  } catch {
    L ("GAGAL rotasi $($item.Name): " + $_.Exception.Message)
    return
  }

  if (-not $NoCompress) {
    try {
      Compress-Archive -LiteralPath $dest -DestinationPath ($dest + '.zip') -Force
      Remove-Item -LiteralPath $dest -Force
      L ("gzip: $(Split-Path -Leaf $dest).zip")
    } catch {
      L ("gagal gzip; arsip .log tetap: " + $_.Exception.Message)
    }
  }

  # File baru kosong supaya `>>` di runner punya target yang konsisten.
  New-Item -ItemType File -Path $Path -Force | Out-Null
}

function Prune {
  $cutoff = (Get-Date).AddDays(-$KeepDays)
  $old = @(Get-ChildItem -LiteralPath $ArisipDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt $cutoff })

  if ($old.Count -eq 0) { L ("prune: tidak ada arsip > $KeepDays hari"); return }

  foreach ($f in $old) {
    try { Remove-Item -LiteralPath $f.FullName -Force; L ("prune: " + $f.Name) }
    catch { L ("gagal prune " + $f.Name + ": " + $_.Exception.Message) }
  }
}

try {
  L '=== ROTATE LOGS ==='
  L ("computer: $env:COMPUTERNAME; logdir: $LogDir; keep: $KeepDays hari")

  $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
  if ($LogName) {
    Rotate-One -Path (Join-Path $LogDir $LogName) -Stamp $stamp
  } else {
    L 'mode: prune-only (log hidup tidak disentuh)'
  }

  Prune
  L '=== SELESAI ==='
} catch {
  L ('GAGAL: ' + $_.Exception.Message)
  exit 1
}
