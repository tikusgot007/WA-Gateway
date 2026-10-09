# check-git-source.ps1 -- AC-1/AC-2/AC-3/AC-7: Ensure-GitSource clone sekali,
# fetch+checkout berikutnya, gitignored files selamat lewat update, dan dua
# sumber independen satu sama lain. Semua terhadap repo bare LOKAL (tidak ada
# akses jaringan/GitHub, tidak perlu admin) -- aman dijalankan di PC dev mana
# pun, sama seperti check-viewonce-patch.ps1. Memanggil fungsi PRODUKSI
# Ensure-GitSource langsung (lewat parameter -Url untuk menunjuk ke remote
# lokal), bukan reimplementasi logikanya.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Split-Path -Parent $here
. (Join-Path $installer 'lib\common.ps1')

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('gitsrc-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
Initialize-AuliaLog -Path (Join-Path $tmp 'test.log') -Reset

$problems = New-Object System.Collections.Generic.List[string]

function Invoke-GitRaw {
  param([string]$WorkDir, [string[]]$GitArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = @(& git -C $WorkDir @GitArgs 2>&1 | ForEach-Object { $_.ToString() })
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  if ($code -ne 0) { throw ('git ' + ($GitArgs -join ' ') + ' gagal (exit ' + $code + '): ' + ($out -join "`n")) }
  return [pscustomobject]@{ Output = $out; Code = $code }
}

try {
  # --- Siapkan 2 "remote" lokal independen (meniru Evolution + adapter),
  # masing-masing dengan commit v1 lalu v2, dan sebuah tag.
  $remoteA = Join-Path $tmp 'remoteA.git'
  $remoteB = Join-Path $tmp 'remoteB.git'
  $workA = Join-Path $tmp 'workA-seed'
  $workB = Join-Path $tmp 'workB-seed'

  foreach ($pair in @(@{ Remote = $remoteA; Work = $workA; Tag = 'v1' }, @{ Remote = $remoteB; Work = $workB; Tag = 'v1' })) {
    New-Item -ItemType Directory -Path $pair.Remote -Force | Out-Null
    Invoke-GitRaw -WorkDir $pair.Remote -GitArgs @('init', '--bare', '-q') | Out-Null
    New-Item -ItemType Directory -Path $pair.Work -Force | Out-Null
    Invoke-GitRaw -WorkDir $pair.Work -GitArgs @('init', '-q') | Out-Null
    Invoke-GitRaw -WorkDir $pair.Work -GitArgs @('config', 'user.email', 'test@example.com') | Out-Null
    Invoke-GitRaw -WorkDir $pair.Work -GitArgs @('config', 'user.name', 'Test') | Out-Null
    Set-Content -LiteralPath (Join-Path $pair.Work 'package.json') -Value '{"version":"1.0.0"}'
    Invoke-GitRaw -WorkDir $pair.Work -GitArgs @('add', '.') | Out-Null
    Invoke-GitRaw -WorkDir $pair.Work -GitArgs @('commit', '-q', '-m', 'v1') | Out-Null
    Invoke-GitRaw -WorkDir $pair.Work -GitArgs @('tag', $pair.Tag) | Out-Null
    Invoke-GitRaw -WorkDir $pair.Work -GitArgs @('remote', 'add', 'origin', $pair.Remote) | Out-Null
    Invoke-GitRaw -WorkDir $pair.Work -GitArgs @('push', 'origin', 'HEAD:refs/heads/master', '-q') | Out-Null
    Invoke-GitRaw -WorkDir $pair.Work -GitArgs @('push', 'origin', $pair.Tag, '-q') | Out-Null
  }

  # --- AC-1: fresh clone+checkout ke ref v1, lewat Ensure-GitSource ASLI ---
  $destA = Join-Path $tmp 'destA'
  $r1 = Ensure-GitSource -Dest $destA -Repo 'local/fixtureA' -Ref 'v1' -Label 'fixtureA' -Url $remoteA
  if (-not (Test-Path -LiteralPath (Join-Path $destA '.git'))) { $problems.Add('AC-1: .git tidak ada setelah clone pertama') }
  $expectedV1 = (Invoke-GitRaw -WorkDir $workA -GitArgs @('rev-parse', 'v1')).Output[0].Trim()
  if ($r1.NewHead -ne $expectedV1) { $problems.Add('AC-1: HEAD setelah clone (' + $r1.NewHead + ') tidak sama dengan tag v1 (' + $expectedV1 + ')') }
  if ($null -ne $r1.OldHead) { $problems.Add('AC-1: OldHead seharusnya null pada clone pertama (dapat: ' + $r1.OldHead + ')') }

  # Simulasikan file gitignored (.env) yang harus selamat lewat update.
  $envMarker = Join-Path $destA '.env'
  Set-Content -LiteralPath $envMarker -Value 'SECRET=jangan-hilang'

  # --- AC-2: re-run tanpa ganti ref -> tidak re-clone, marker selamat ---
  $r2 = Ensure-GitSource -Dest $destA -Repo 'local/fixtureA' -Ref 'v1' -Label 'fixtureA' -Url $remoteA
  if ($r2.Changed) { $problems.Add('AC-2: Changed seharusnya false saat ref tidak berubah (OldHead=' + $r2.OldHead + ' NewHead=' + $r2.NewHead + ')') }
  if (-not (Test-Path -LiteralPath $envMarker)) { $problems.Add('AC-2: file .env (gitignored) hilang setelah re-run tanpa perubahan ref') }
  if ((Get-Content -LiteralPath $envMarker -Raw) -notlike '*jangan-hilang*') { $problems.Add('AC-2: isi .env berubah setelah re-run') }

  # --- AC-3: ganti ke v2 -> checkout saja, marker tetap selamat, HEAD berubah ---
  Set-Content -LiteralPath (Join-Path $workA 'package.json') -Value '{"version":"2.0.0"}'
  Invoke-GitRaw -WorkDir $workA -GitArgs @('add', '.') | Out-Null
  Invoke-GitRaw -WorkDir $workA -GitArgs @('commit', '-q', '-m', 'v2') | Out-Null
  Invoke-GitRaw -WorkDir $workA -GitArgs @('tag', 'v2') | Out-Null
  Invoke-GitRaw -WorkDir $workA -GitArgs @('push', 'origin', 'HEAD:refs/heads/master', '-q') | Out-Null
  Invoke-GitRaw -WorkDir $workA -GitArgs @('push', 'origin', 'v2', '-q') | Out-Null

  $r3 = Ensure-GitSource -Dest $destA -Repo 'local/fixtureA' -Ref 'v2' -Label 'fixtureA' -Url $remoteA
  if (-not $r3.Changed) { $problems.Add('AC-3: Changed seharusnya true saat ref berganti v1->v2') }
  $expectedV2 = (Invoke-GitRaw -WorkDir $workA -GitArgs @('rev-parse', 'v2')).Output[0].Trim()
  if ($r3.NewHead -ne $expectedV2) { $problems.Add('AC-3: HEAD setelah checkout v2 (' + $r3.NewHead + ') tidak sama dengan tag v2 (' + $expectedV2 + ')') }
  if (-not (Test-Path -LiteralPath $envMarker)) { $problems.Add('AC-3: file .env (gitignored) hilang setelah checkout ke ref baru') }
  if ((Get-Content -LiteralPath $envMarker -Raw) -notlike '*jangan-hilang*') { $problems.Add('AC-3: isi .env berubah setelah checkout ke ref baru') }
  $content = Get-Content -LiteralPath (Join-Path $destA 'package.json') -Raw
  if ($content -notlike '*2.0.0*') { $problems.Add('AC-3: isi package.json tidak ter-update ke v2') }

  # --- AC-7: update sumber A tidak menyentuh sumber B (independen) ---
  $destB = Join-Path $tmp 'destB'
  $rb1 = Ensure-GitSource -Dest $destB -Repo 'local/fixtureB' -Ref 'v1' -Label 'fixtureB' -Url $remoteB
  $headBBefore = $rb1.NewHead
  $null = Ensure-GitSource -Dest $destA -Repo 'local/fixtureA' -Ref 'v1' -Label 'fixtureA' -Url $remoteA
  $headBAfter = (Invoke-GitRaw -WorkDir $destB -GitArgs @('rev-parse', 'HEAD')).Output[0].Trim()
  if ($headBBefore -ne $headBAfter) { $problems.Add('AC-7: HEAD sumber B berubah akibat operasi pada sumber A') }

} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($problems.Count -eq 0) { Write-Host 'PASS check-git-source (AC-1/AC-2/AC-3/AC-7)'; exit 0 }
Write-Host 'FAIL check-git-source (AC-1/AC-2/AC-3/AC-7):'
foreach ($p in $problems) { Write-Host ('  - ' + $p) }
exit 1
