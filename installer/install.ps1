<#
  install.ps1 -- paket instalasi gateway WhatsApp untuk PC Windows baru
  (bootstrap ONLINE). Memasang: PostgreSQL 16 + Evolution API (tag terpin) +
  adapter evolution-gateway, lalu menyiapkan .env, database, patch view-once,
  firewall, instance, dan webhook.

  Prasyarat: Windows x64, PowerShell 5.1+, Administrator, akses internet.
  Start/stop manual: installer\start.ps1 / stop.ps1 / status.ps1.

  Contoh (token lewat file, tidak tampil di command line):
    powershell -ExecutionPolicy Bypass -File installer\install.ps1 `
      -Ci4BaseUrl "http://192.168.1.10/aulia-app" `
      -Ci4GatewayTokenFile "$env:TEMP\aulia-gateway-token.txt" `
      -LanSources "192.168.1.10"

  Idempotent: sumber yang sudah ada dilewati; langkah provisioning aman diulang.
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = 'C:\AuliaGateway',

  [Parameter(Mandatory = $true)][string]$Ci4BaseUrl,
  # Token CI4: isi lewat -Ci4GatewayToken, atau (lebih aman) lewat file dengan
  # -Ci4GatewayTokenFile supaya nilainya tidak tampil di command line proses.
  [string]$Ci4GatewayToken,
  [string]$Ci4GatewayTokenFile,
  [Parameter(Mandatory = $true)][string]$LanSources,

  [string]$InstanceName = 'aulia-toko',
  [int]$PgPort = 5432,
  [int]$EvolutionPort = 8080,
  [int]$AdapterPort = 3000,

  [string]$EvolutionRef = '2.3.7',
  [string]$AdapterRef = 'master',
  [string]$PgVersion = '16.15-1',
  [string]$ServiceName = 'postgresql-auliagw',

  [switch]$SkipPrereqs,
  [string]$LogPath
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'lib\common.ps1')

$root = $InstallRoot
$evoDir = Join-Path $root 'evolution-api-server'
$adapterDir = Join-Path $root 'evolution-gateway'
$pgRoot = Join-Path $root 'pgsql16'
$pgData = Join-Path $pgRoot 'data'
$dlDir = Join-Path $root 'downloads'
$logDir = Join-Path $root 'logs'
foreach ($d in @($root, $dlDir, $logDir)) {
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
if (-not $LogPath) { $LogPath = Join-Path $logDir 'install.log' }
Initialize-AuliaLog -Path $LogPath -Reset

function Invoke-ChildScript {
  param([string]$Script, [string[]]$ScriptArgs, [string]$Label)
  $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script) + $ScriptArgs
  $r = Invoke-Native -Exe 'powershell.exe' -NativeArgs $childArgs -Label $Label
  if ($r.Code -ne 0) { throw ($Label + ' gagal (exit ' + $r.Code + ')') }
}

function Get-ZipUrl {
  param([string]$Repo, [string]$Ref, [switch]$IsTag)
  if ($Ref -match '^[0-9a-fA-F]{40}$') { return ('https://codeload.github.com/' + $Repo + '/zip/' + $Ref) }
  if ($IsTag) { return ('https://codeload.github.com/' + $Repo + '/zip/refs/tags/' + $Ref) }
  return ('https://codeload.github.com/' + $Repo + '/zip/refs/heads/' + $Ref)
}

function Ensure-Node {
  $tools = Resolve-NodeTools
  if ($tools.Node -and $tools.Npm) {
    $v = (& $tools.Node.Source -v).ToString().Trim()
    $major = [int](($v -replace '^v', '') -split '\.')[0]
    if ($major -ge 20) { Write-Log ('node: sudah ada ' + $v); return }
    Write-Log ('node: versi ' + $v + ' < 20, akan di-upgrade lewat winget.')
  }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) { throw 'Node.js belum ada dan winget tidak tersedia. Pasang Node.js LTS manual, lalu ulangi dengan -SkipPrereqs.' }
  Write-Log 'node: memasang OpenJS.NodeJS.LTS lewat winget...'
  $null = Invoke-Native -Exe $winget.Source -NativeArgs @('install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements') -Label 'winget'
  $tools = Resolve-NodeTools
  if (-not $tools.Node -or -not $tools.Npm) { throw 'Node.js masih tidak ditemukan setelah winget install.' }
}

function Ensure-Postgres {
  $initdb = Join-Path $pgRoot 'bin\initdb.exe'
  if (Test-Path -LiteralPath $initdb) { Write-Log ('postgres: binari sudah ada di ' + $pgRoot); return }
  $zip = Join-Path $dlDir ('postgresql-' + $PgVersion + '-windows-x64-binaries.zip')
  if (-not (Test-Path -LiteralPath $zip)) {
    Get-RemoteFile -Url ('https://get.enterprisedb.com/postgresql/postgresql-' + $PgVersion + '-windows-x64-binaries.zip') -OutFile $zip -Label ('PostgreSQL ' + $PgVersion)
  }
  Expand-RepoZip -ZipPath $zip -DestDir $pgRoot
  if (-not (Test-Path -LiteralPath $initdb)) { throw 'binari PostgreSQL tidak ditemukan setelah ekstrak.' }
}

function Ensure-Source {
  param([string]$Dest, [string]$Url, [string]$Label)
  if (Test-Path -LiteralPath (Join-Path $Dest 'package.json')) { Write-Log ($Label + ': sumber sudah ada, dilewati.'); return }
  $zip = Join-Path $dlDir ($Label + '.zip')
  if (-not (Test-Path -LiteralPath $zip)) { Get-RemoteFile -Url $Url -OutFile $zip -Label $Label }
  Expand-RepoZip -ZipPath $zip -DestDir $Dest
}

try {
  Write-Log '=== INSTALL GATEWAY (bootstrap online) ==='
  Assert-Admin
  Write-Log ('computer: ' + $env:COMPUTERNAME + ' user: ' + $env:USERNAME)
  Write-Log ('install root: ' + $root)
  Write-Log ('ci4 base url: ' + $Ci4BaseUrl)
  Write-Log ('instance    : ' + $InstanceName)
  Write-Log 'token CI4   : (tidak dicetak)'

  # Token: dari parameter, atau dari file (tidak lewat command line).
  $token = $Ci4GatewayToken
  if (-not $token -and $Ci4GatewayTokenFile) {
    if (-not (Test-Path -LiteralPath $Ci4GatewayTokenFile)) { throw ('File token tidak ditemukan: ' + $Ci4GatewayTokenFile) }
    $token = (Get-Content -LiteralPath $Ci4GatewayTokenFile -Raw).Trim()
  }
  if (-not $token) { throw 'Token CI4 kosong. Isi -Ci4GatewayToken atau -Ci4GatewayTokenFile.' }

  # Preflight yang sadar-resume: port boleh sudah dipakai kalau itu komponen
  # kita sendiri (jalur pemulihan "stop.ps1 lalu install.ps1" tetap jalan,
  # karena stop.ps1 tidak menghentikan service PostgreSQL).
  if (Test-Listen -Port $PgPort) {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not ($svc -and $svc.Status -eq 'Running')) {
      throw ('Port ' + $PgPort + ' dipakai proses lain dan service ' + $ServiceName + ' tidak jalan. Hentikan dulu atau pilih -PgPort lain.')
    }
    Write-Log ('preflight: port ' + $PgPort + ' sudah dipakai service ' + $ServiceName + ' (dipakai ulang).')
  }
  $appPorts = @(
    @{ Port = $EvolutionPort; Label = 'evolution'; Pattern = 'evolution-api-server|src[\\/]main\.ts' },
    @{ Port = $AdapterPort; Label = 'adapter'; Pattern = 'evolution-gateway|src[\\/]app[\\/]evolution\.js' }
  )
  foreach ($item in $appPorts) {
    $p = [int]$item['Port']
    if (-not (Test-Listen -Port $p)) { continue }
    $ours = @(Get-PortOwners -Port $p | Where-Object { $_.Name -like 'node*' -and $_.CommandLine -and ($_.CommandLine -match $item['Pattern']) })
    if ($ours.Count -eq 0) {
      $who = @(Get-PortOwners -Port $p | ForEach-Object { ($_.Name + ':' + $_.Pid) }) -join ', '
      throw ('Port ' + $p + ' dipakai proses lain (' + $who + '). Hentikan dulu atau pilih port lain.')
    }
    Write-Log ('preflight: ' + $item['Label'] + ' sudah berjalan di port ' + $p + ' (dilewati).')
  }
  Write-Log 'preflight: selesai.'

  if ($SkipPrereqs) { Write-Log 'prereqs: dilewati (-SkipPrereqs).' }
  else {
    Ensure-Node
    Ensure-Postgres
  }

  $tools = Resolve-NodeTools
  if (-not $tools.Node -or -not $tools.Npm) { throw 'Node.js/npm tidak ditemukan di PATH.' }
  Write-Log ('node  : ' + $tools.Node.Source)
  Write-Log ('npm   : ' + $tools.Npm.Source)

  Ensure-Source -Dest $evoDir -Url (Get-ZipUrl -Repo 'evolution-foundation/evolution-api' -Ref $EvolutionRef -IsTag) -Label 'evolution-api'
  Ensure-Source -Dest $adapterDir -Url (Get-ZipUrl -Repo 'tikusgot007/WA-Gateway' -Ref $AdapterRef) -Label 'evolution-gateway'

  # Guard kecocokan versi: installer ini memanggil setup-env.ps1 dengan
  # dukungan -Ci4GatewayToken yang harus ada di ref adaptor yang diunduh.
  # Tanpa ini, ref yang bergerak (mis. master) bisa gagal binding parameter
  # dengan pesan yang membingungkan.
  $setupEnvPath = Join-Path $adapterDir 'scripts\setup-env.ps1'
  if (-not (Test-Path -LiteralPath $setupEnvPath)) { throw ('setup-env.ps1 tidak ditemukan di sumber adapter: ' + $setupEnvPath) }
  if ((Get-Content -LiteralPath $setupEnvPath -Raw) -notlike '*Ci4GatewayToken*') {
    throw ('Sumber adapter pada ref ''' + $AdapterRef + ''' tidak mendukung paket installer ini. Pin -AdapterRef ke commit yang memuat folder installer/ (lihat petunjuk-penggunaan.md).')
  }

  $env:HUSKY = '0'
  Write-Log 'npm ci: evolution-api...'
  $r = Invoke-Native -Exe $tools.Npm.Source -NativeArgs @('ci', '--no-audit', '--no-fund') -Label 'npm' -WorkDir $evoDir
  if ($r.Code -ne 0) { throw 'npm ci (evolution-api) gagal.' }
  Write-Log 'npm ci: adapter...'
  $r = Invoke-Native -Exe $tools.Npm.Source -NativeArgs @('ci', '--no-audit', '--no-fund') -Label 'npm' -WorkDir $adapterDir
  if ($r.Code -ne 0) { throw 'npm ci (adapter) gagal.' }

  Invoke-ChildScript -Script (Join-Path $here 'apply-viewonce-patch.ps1') -ScriptArgs @('-EvolutionDir', $evoDir, '-LogPath', (Join-Path $logDir 'apply-viewonce-patch.log')) -Label 'apply-viewonce-patch'

  # Token diteruskan lewat environment, bukan command line, supaya tidak
  # tampil di daftar proses. setup-env.ps1 membacanya dari variabel ini.
  $env:CI4_GATEWAY_TOKEN_INPUT = $token
  try {
    Invoke-ChildScript -Script (Join-Path $adapterDir 'scripts\setup-env.ps1') -ScriptArgs @(
      '-AdapterDir', $adapterDir,
      '-EvolutionDir', $evoDir,
      '-Ci4BaseUrl', $Ci4BaseUrl,
      '-InstanceName', $InstanceName,
      '-PgHost', '127.0.0.1', '-PgPort', "$PgPort",
      '-AdapterHost', '0.0.0.0', '-AdapterPort', "$AdapterPort",
      '-EvolutionPort', "$EvolutionPort",
      '-EvolutionUrl', ('http://127.0.0.1:' + $EvolutionPort),
      '-EvolutionEnvTemplate', (Join-Path $evoDir 'env.example'),
      '-LogPath', (Join-Path $logDir 'setup-env.log')
    ) -Label 'setup-env'
  } finally {
    Remove-Item Env:\CI4_GATEWAY_TOKEN_INPUT -ErrorAction SilentlyContinue
  }

  Invoke-ChildScript -Script (Join-Path $adapterDir 'scripts\install-postgres.ps1') -ScriptArgs @(
    '-PgRoot', $pgRoot, '-DataDir', $pgData,
    '-ServiceName', $ServiceName, '-Port', "$PgPort",
    '-AppUser', 'evolution_gw', '-AppDb', 'evolution_gateway_pg',
    '-EvolutionEnv', (Join-Path $evoDir '.env'),
    '-LogPath', (Join-Path $logDir 'install-postgres.log')
  ) -Label 'install-postgres'

  $srcMig = Join-Path $evoDir 'prisma\postgresql-migrations'
  $dstMig = Join-Path $evoDir 'prisma\migrations'
  if (Test-Path -LiteralPath $srcMig) {
    Remove-Item -LiteralPath $dstMig -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $srcMig -Destination $dstMig -Recurse -Force
  }
  $prismaCli = Join-Path $evoDir 'node_modules\prisma\build\index.js'
  if (-not (Test-Path -LiteralPath $prismaCli)) { throw ('Prisma CLI tidak ditemukan: ' + $prismaCli) }
  $null = Import-DotEnv -Path (Join-Path $evoDir '.env')
  $env:DATABASE_PROVIDER = 'postgresql'
  if (-not $env:DATABASE_CONNECTION_URI) { throw 'DATABASE_CONNECTION_URI kosong setelah memuat .env Evolution.' }

  $r = Invoke-Native -Exe $tools.Node.Source -NativeArgs @($prismaCli, 'generate', '--schema', 'prisma\postgresql-schema.prisma') -Label 'prisma generate' -WorkDir $evoDir
  if ($r.Code -ne 0) { throw 'prisma generate gagal.' }
  $r = Invoke-Native -Exe $tools.Node.Source -NativeArgs @($prismaCli, 'migrate', 'deploy', '--schema', 'prisma\postgresql-schema.prisma') -Label 'prisma migrate' -WorkDir $evoDir
  if ($r.Code -ne 0) { throw 'prisma migrate deploy gagal.' }

  Invoke-ChildScript -Script (Join-Path $here 'start.ps1') -ScriptArgs @(
    '-InstallRoot', $root, '-PgService', $ServiceName,
    '-PgPort', "$PgPort", '-EvolutionPort', "$EvolutionPort", '-AdapterPort', "$AdapterPort",
    '-NodeExe', $tools.Node.Source,
    '-LogPath', (Join-Path $logDir 'start.log')
  ) -Label 'start'

  Invoke-ChildScript -Script (Join-Path $adapterDir 'scripts\allow-lan-ports.ps1') -ScriptArgs @(
    '-Sources', $LanSources,
    '-Ports', ("$AdapterPort,$EvolutionPort"),
    '-LogPath', (Join-Path $logDir 'allow-lan-ports.log')
  ) -Label 'allow-lan-ports'

  $env:WEBHOOK_PUBLIC_URL = 'http://127.0.0.1:' + $AdapterPort + '/evolution/webhook'
  $r = Invoke-Native -Exe $tools.Node.Source -NativeArgs @('scripts\setup-instance.js') -Label 'setup-instance' -WorkDir $adapterDir
  if ($r.Code -ne 0) { throw 'setup-instance gagal.' }

  Invoke-ChildScript -Script (Join-Path $here 'status.ps1') -ScriptArgs @(
    '-InstallRoot', $root, '-PgService', $ServiceName,
    '-PgPort', "$PgPort", '-EvolutionPort', "$EvolutionPort", '-AdapterPort', "$AdapterPort",
    '-LogPath', (Join-Path $logDir 'status.log')
  ) -Label 'status'

  $lan = Get-LanIPv4
  $petunjukSrc = Join-Path $here 'petunjuk-penggunaan.md'
  if (Test-Path -LiteralPath $petunjukSrc) { Copy-Item -LiteralPath $petunjukSrc -Destination (Join-Path $root 'petunjuk-penggunaan.md') -Force }

  $summary = @(
    'RINGKASAN INSTALASI GATEWAY',
    ('Waktu         : ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')),
    ('InstallRoot   : ' + $root),
    ('Node          : ' + $tools.Node.Source),
    ('PostgreSQL    : ' + $pgRoot + ' (service ' + $ServiceName + ', port ' + $PgPort + ')'),
    ('Evolution API : ' + $evoDir + ' (port ' + $EvolutionPort + ')'),
    ('Adapter       : ' + $adapterDir + ' (port ' + $AdapterPort + ')'),
    ('Instance      : ' + $InstanceName),
    ('CI4 base URL  : ' + $Ci4BaseUrl),
    ('Webhook URL   : http://' + $lan + ':' + $AdapterPort + '/evolution/webhook'),
    '',
    'LANGKAH BERIKUTNYA:',
    ('1. Scan QR: http://127.0.0.1:' + $EvolutionPort + '/manager  (dari PC lain: http://' + $lan + ':' + $EvolutionPort + '/manager)'),
    '2. Di server AuliaPos, samakan:',
    ('   inbox.gatewayBaseUrl = http://' + $lan + ':' + $AdapterPort),
    '   inbox.gatewayToken   = (token yang Anda berikan saat instalasi)',
    '3. Start/stop/status manual: installer\start.ps1 | stop.ps1 | status.ps1',
    ('4. Panduan lengkap: ' + (Join-Path $root 'petunjuk-penggunaan.md'))
  )
  [IO.File]::WriteAllLines((Join-Path $root 'install-summary.txt'), $summary, (New-Object System.Text.UTF8Encoding($false)))
  Write-Log ('ringkasan ditulis: ' + (Join-Path $root 'install-summary.txt'))
  Write-Log '=== INSTALASI SELESAI ==='
  exit 0
} catch {
  Write-Log ('GAGAL: ' + $_.Exception.Message)
  if ($_.InvocationInfo -and $_.InvocationInfo.Line) { Write-Log ('  pada: ' + $_.InvocationInfo.Line.Trim()) }
  exit 1
}
