<#
  install.ps1 -- paket instalasi gateway WhatsApp untuk PC Windows baru
  (bootstrap ONLINE). Memasang: PostgreSQL 16 + Evolution API (tag terpin) +
  adapter evolution-gateway, lalu menyiapkan .env, database, patch view-once,
  firewall, instance, dan webhook. Evolution + adapter didaftarkan sebagai
  Windows Service (WinSW): auto-start saat boot, auto-restart saat crash.

  Prasyarat: Windows x64, PowerShell 5.1+, Administrator, akses internet.
  Start/stop/status manual: installer\start.ps1 / stop.ps1 / status.ps1.
  Verifikasi service: installer\tests\check-service.ps1.

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

  # Windows Service (WinSW) untuk Evolution + adapter. Dua nama service ini
  # dipakai oleh start.ps1/stop.ps1/status.ps1 dan check-service.ps1.
  [string]$WinswVersion = '2.12.0',
  [string]$EvolutionServiceName = 'AuliaGatewayEvolution',
  [string]$AdapterServiceName = 'AuliaGatewayAdapter',

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
  # Output dialihkan ke FILE, bukan pipe. Dua jebakan yang sudah terbukti di
  # Windows PowerShell 5.1:
  #  - menangkap lewat pipeline (`| ForEach-Object`) menggantung, karena
  #    start.ps1 meninggalkan proses adapter hidup yang memegang handle pipe;
  #  - `Start-Process -Wait` ikut menunggu proses TURUNAN (uji: 31s pada
  #    proses tidur 30s), jadi juga menggantung.
  # Native call dengan redirection `*>` ke file: tidak menunggu turunan dan
  # tetap memberi exit code lewat $LASTEXITCODE.
  $outFile = Join-Path $logDir ($Label + '.out.log')
  $childArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script) + $ScriptArgs
  & powershell.exe @childArgs *> $outFile
  $code = $LASTEXITCODE
  Write-Log ($Label + ' [exit=' + $code + ']')
  if (Test-Path -LiteralPath $outFile) {
    Get-Content -LiteralPath $outFile | ForEach-Object { Write-Log ('  ' + $Label + ': ' + $_) }
  }
  if ($code -ne 0) { throw ($Label + ' gagal (exit ' + $code + ')') }
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

# Unduh biner WinSW (Windows Service Wrapper) sekali ke folder downloads.
# Dipin ke satu versi supaya hasil instalasi reproducible, sama seperti pin
# versi PostgreSQL/Evolution di atas.
function Ensure-WinSW {
  param([string]$Version)
  $exe = Join-Path $dlDir ('WinSW-' + $Version + '.exe')
  if (Test-Path -LiteralPath $exe) { Write-Log ('winsw: sudah ada ' + $exe); return $exe }
  $url = 'https://github.com/winsw/winsw/releases/download/v' + $Version + '/WinSW-x64.exe'
  Get-RemoteFile -Url $url -OutFile $exe -Label ('WinSW ' + $Version)
  return $exe
}

# Render satu service WinSW dari template: tulis XML, salin biner WinSW (hanya
# sekali -- biner yang sedang Running tidak bisa ditimpa), lalu `install`
# lewat SCM kalau belum terdaftar. Idempotent: dipanggil ulang tiap kali
# install.ps1 jalan, XML selalu disegarkan supaya path/port yang berubah ikut
# terbawa; biner & registrasi SCM hanya disentuh sekali.
function Install-WinSwService {
  param(
    [Parameter(Mandatory = $true)][string]$WinswExe,
    [Parameter(Mandatory = $true)][string]$ServiceId,
    [Parameter(Mandatory = $true)][string]$DisplayName,
    [Parameter(Mandatory = $true)][string]$TemplatePath,
    [Parameter(Mandatory = $true)][string]$DestDir,
    [Parameter(Mandatory = $true)][hashtable]$Tokens,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (-not (Test-Path -LiteralPath $DestDir)) { New-Item -ItemType Directory -Path $DestDir -Force | Out-Null }
  $svcExe = Join-Path $DestDir ($ServiceId + '.exe')
  $svcXml = Join-Path $DestDir ($ServiceId + '.xml')

  if (-not (Test-Path -LiteralPath $svcExe)) {
    Copy-Item -LiteralPath $WinswExe -Destination $svcExe -Force
    Write-Log ($Label + ': biner WinSW disalin ke ' + $svcExe)
  } else {
    Write-Log ($Label + ': biner WinSW sudah ada, dilewati (' + $svcExe + ').')
  }

  $xml = Get-Content -LiteralPath $TemplatePath -Raw
  foreach ($key in $Tokens.Keys) { $xml = $xml.Replace(('__' + $key + '__'), [string]$Tokens[$key]) }
  [IO.File]::WriteAllText($svcXml, $xml, (New-Object System.Text.UTF8Encoding($false)))
  Write-Log ($Label + ': konfigurasi ditulis -> ' + $svcXml)

  $existing = Get-Service -Name $ServiceId -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Log ($Label + ': service ' + $ServiceId + ' sudah terdaftar (dilewati install, config disegarkan).')
  } else {
    $r = Invoke-Native -Exe $svcExe -NativeArgs @('install') -Label ($Label + ' install')
    if ($r.Code -ne 0) { throw ($Label + ': gagal mendaftarkan service (exit ' + $r.Code + ').') }
    Write-Log ($Label + ': service ' + $ServiceId + ' terdaftar.')
  }
  Set-Service -Name $ServiceId -StartupType Automatic
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

  # npm ci idempotent: kalau node_modules sudah ada, lewati (mempercepat
  # jalur pemulihan setelah kegagalan di langkah berikutnya).
  $env:HUSKY = '0'
  foreach ($pair in @(
    @{ Dir = $evoDir; Label = 'evolution-api' },
    @{ Dir = $adapterDir; Label = 'adapter' }
  )) {
    $dir = $pair['Dir']
    if (Test-Path -LiteralPath (Join-Path $dir 'node_modules')) {
      Write-Log ('npm ci (' + $pair['Label'] + '): node_modules sudah ada, dilewati.')
      continue
    }
    Write-Log ('npm ci: ' + $pair['Label'] + '...')
    $r = Invoke-Native -Exe $tools.Npm.Source -NativeArgs @('ci', '--no-audit', '--no-fund') -Label 'npm' -WorkDir $dir
    if ($r.Code -ne 0) { throw ('npm ci (' + $pair['Label'] + ') gagal.') }
  }
  Remove-Item Env:\HUSKY -ErrorAction SilentlyContinue

  Invoke-ChildScript -Script (Join-Path $here 'apply-viewonce-patch.ps1') -ScriptArgs @('-EvolutionDir', $evoDir, '-LogPath', (Join-Path $logDir 'apply-viewonce-patch.log')) -Label 'apply-viewonce-patch'
  Invoke-ChildScript -Script (Join-Path $here 'apply-lid-preservation-patch.ps1') -ScriptArgs @('-EvolutionDir', $evoDir, '-LogPath', (Join-Path $logDir 'apply-lid-preservation-patch.log')) -Label 'apply-lid-preservation-patch'

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
  # Hanya dua variabel ini yang dibutuhkan Prisma. JANGAN memuat seluruh .env
  # Evolution ke environment proses ini: variabel seperti LOG_LEVEL akan ikut
  # terbawa ke proses anak (start.ps1 -> adapter) dan membuat adapter gagal
  # (pino: "default level ... must be included in custom levels").
  $env:DATABASE_PROVIDER = 'postgresql'
  $dbUri = Get-EnvValue -Path (Join-Path $evoDir '.env') -Key 'DATABASE_CONNECTION_URI'
  if (-not $dbUri) { throw 'DATABASE_CONNECTION_URI tidak ditemukan di .env Evolution.' }
  $env:DATABASE_CONNECTION_URI = $dbUri

  # prisma generate idempotent: lewati kalau query engine sudah tergenerasi.
  # Ini juga mencegah EPERM saat resume, karena proses Evolution yang sedang
  # jalan memegang query_engine-windows.dll.node.
  $prismaEngine = Join-Path $evoDir 'node_modules\.prisma\client\query_engine-windows.dll.node'
  if (Test-Path -LiteralPath $prismaEngine) {
    Write-Log 'prisma generate: client sudah ada, dilewati.'
  } else {
    $r = Invoke-Native -Exe $tools.Node.Source -NativeArgs @($prismaCli, 'generate', '--schema', 'prisma\postgresql-schema.prisma') -Label 'prisma generate' -WorkDir $evoDir
    if ($r.Code -ne 0) { throw 'prisma generate gagal.' }
  }
  $r = Invoke-Native -Exe $tools.Node.Source -NativeArgs @($prismaCli, 'migrate', 'deploy', '--schema', 'prisma\postgresql-schema.prisma') -Label 'prisma migrate' -WorkDir $evoDir
  if ($r.Code -ne 0) { throw 'prisma migrate deploy gagal.' }

  # Daftarkan Evolution + adapter sebagai Windows Service (WinSW), agar
  # auto-start saat boot dan auto-restart saat proses node mati (onfailure).
  # PostgreSQL sudah lebih dulu berupa service native (install-postgres.ps1);
  # Evolution bergantung padanya lewat <depend> supaya SCM tidak menyalakan
  # Evolution sebelum PostgreSQL siap menerima koneksi.
  $winswExe = Ensure-WinSW -Version $WinswVersion
  $servicesDir = Join-Path $root 'services'

  Install-WinSwService -WinswExe $winswExe -ServiceId $EvolutionServiceName `
    -DisplayName 'Evolution API (Aulia Gateway)' `
    -TemplatePath (Join-Path $here 'services\evolution-service.xml.template') `
    -DestDir $servicesDir -Label 'service-evolution' `
    -Tokens @{
      SERVICE_ID           = $EvolutionServiceName
      SERVICE_DISPLAY_NAME = 'Evolution API (Aulia Gateway)'
      NODE_EXE             = $tools.Node.Source
      WORKDIR              = $evoDir
      PG_SERVICE_NAME      = $ServiceName
      LOG_DIR              = $logDir
    }

  Install-WinSwService -WinswExe $winswExe -ServiceId $AdapterServiceName `
    -DisplayName 'Adapter evolution-gateway (Aulia Gateway)' `
    -TemplatePath (Join-Path $here 'services\adapter-service.xml.template') `
    -DestDir $servicesDir -Label 'service-adapter' `
    -Tokens @{
      SERVICE_ID           = $AdapterServiceName
      SERVICE_DISPLAY_NAME = 'Adapter evolution-gateway (Aulia Gateway)'
      NODE_EXE             = $tools.Node.Source
      WORKDIR              = $adapterDir
      EVOLUTION_SERVICE_ID = $EvolutionServiceName
      LOG_DIR              = $logDir
    }

  Invoke-ChildScript -Script (Join-Path $here 'start.ps1') -ScriptArgs @(
    '-InstallRoot', $root, '-PgService', $ServiceName,
    '-EvolutionServiceName', $EvolutionServiceName, '-AdapterServiceName', $AdapterServiceName,
    '-PgPort', "$PgPort", '-EvolutionPort', "$EvolutionPort", '-AdapterPort', "$AdapterPort",
    '-LogPath', (Join-Path $logDir 'start.log')
  ) -Label 'start'

  $fwScript = Join-Path $adapterDir 'scripts\allow-lan-ports.ps1'
  if (-not (Test-Path -LiteralPath $fwScript)) { throw ('allow-lan-ports.ps1 tidak ditemukan: ' + $fwScript) }
  $fwArgs = @('-Sources', $LanSources, '-LogPath', (Join-Path $logDir 'allow-lan-ports.log'))
  if ((Get-Content -LiteralPath $fwScript -Raw) -like '*PortList*') {
    # -PortList (string dipisah koma): powershell -File tidak bisa mengirim
    # array int[] dengan benar.
    $fwArgs += @('-PortList', "$AdapterPort,$EvolutionPort")
  } elseif ($AdapterPort -ne 3000 -or $EvolutionPort -ne 8080) {
    throw ('allow-lan-ports.ps1 di ref ''' + $AdapterRef + ''' belum mendukung -PortList (hanya port default 3000/8080). Pin -AdapterRef ke commit yang lebih baru untuk port kustom.')
  }
  Invoke-ChildScript -Script $fwScript -ScriptArgs $fwArgs -Label 'allow-lan-ports'

  $env:WEBHOOK_PUBLIC_URL = 'http://127.0.0.1:' + $AdapterPort + '/evolution/webhook'
  $r = Invoke-Native -Exe $tools.Node.Source -NativeArgs @('scripts\setup-instance.js') -Label 'setup-instance' -WorkDir $adapterDir
  if ($r.Code -ne 0) { throw 'setup-instance gagal.' }

  Invoke-ChildScript -Script (Join-Path $here 'status.ps1') -ScriptArgs @(
    '-InstallRoot', $root, '-PgService', $ServiceName,
    '-EvolutionServiceName', $EvolutionServiceName, '-AdapterServiceName', $AdapterServiceName,
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
    ('3. Service (auto-start saat boot, auto-restart saat crash): ' + $EvolutionServiceName + ', ' + $AdapterServiceName),
    '   Start/stop/status manual tetap bisa: installer\start.ps1 | stop.ps1 | status.ps1',
    '   Verifikasi service: installer\tests\check-service.ps1',
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
