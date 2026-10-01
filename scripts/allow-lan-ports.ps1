<#
  allow-lan-ports.ps1 -- buka inbound TCP 3000 (adapter) dan 8080 (Evolution
  Manager) HANYA dari host tepercaya, pada profil firewall Private.

  Kenapa ketat:
  - Port 3000 melayani /evolution/webhook. Kalau EVOLUTION_WEBHOOK_SECRET
    kosong, endpoint itu TANPA validasi -- membukanya ke seluruh subnet berarti
    host LAN mana pun bisa menyuntikkan pesan "masuk" palsu ke Inbox POS.
  - Port 8080 adalah API/admin Evolution; adapter sendiri menghubunginya lewat
    127.0.0.1, jadi LAN hanya perlu kalau operator memang membuka Manager dari
    komputer lain (tambahkan IP-nya ke -Sources, mis. "192.168.1.10,192.168.1.120").
  - -Profile Private: jaringan toko terdeteksi Private; membuka di profil
    Public berarti membuka juga saat laptop tersambung ke jaringan asing.

  Idempotent dan tanpa jendela "terhapus": rule yang sudah ada DIPERBARUI di
  tempat (tidak dihapus-dulu-baru-dibuat). Kalau ada rule yang tidak bisa
  dipastikan ada+aktif di akhir, skrip keluar dengan kode 1 supaya task
  terjadwal tidak melaporkan sukses palsu.

  Output: D:\kilo\allow-lan-ports.log
#>
[CmdletBinding()]
param(
  # Daftar IP yang diizinkan, dipisah koma. Sengaja STRING (bukan array):
  # argumen array tidak terbaca benar ketika skrip dipanggil lewat
  # `schtasks ... -File`, sehingga "a,b" sampai sebagai satu alamat tak valid.
  [string]  $Sources   = '192.168.1.10',
  [int[]]   $Ports     = @(3000, 8080),
  [string]  $Profile   = 'Private',
  [string]  $LogPath   = 'D:\kilo\allow-lan-ports.log'
)

$ErrorActionPreference = 'Continue'
$AllowFrom = @($Sources -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($AllowFrom.Count -eq 0) { throw 'Daftar sumber kosong.' }
New-Item -ItemType Directory -Path (Split-Path -Parent $LogPath) -Force | Out-Null
Set-Content -LiteralPath $LogPath -Value ''
function L { param([string]$m) Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) }

$ruleName = @{
  3000 = 'AuliaPos Gateway Adapter (TCP 3000)'
  8080 = 'Evolution API Manager (TCP 8080)'
}

$gagal = 0

L '=== ALLOW LAN PORTS ==='
L ('sumber diizinkan : ' + ($AllowFrom -join ', '))
L ('profil firewall  : ' + $Profile)

foreach ($port in $Ports) {
  $name = $ruleName[$port]
  if (-not $name) { $name = "AuliaPos adapter (TCP $port)" }

  $existing = @(Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)

  try {
    if ($existing.Count -gt 0) {
      # Perbarui di tempat: tidak ada momen port tertutup.
      foreach ($r in $existing) {
        Set-NetFirewallRule -Name $r.Name -Enabled True -Action Allow -Direction Inbound -Profile $Profile -ErrorAction Stop
        $r | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress $AllowFrom -ErrorAction Stop
        $r | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $port -ErrorAction Stop
      }
      L ("  $name : diperbarui")
    } else {
      New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP `
        -LocalPort $port -RemoteAddress $AllowFrom -Profile $Profile -Enabled True -ErrorAction Stop | Out-Null
      L ("  $name : dibuat")
    }
  } catch {
    L ("  $name : GAGAL -- " + $_.Exception.Message)
    $gagal += 1
  }
}

L '--- verifikasi ---'
foreach ($port in $Ports) {
  $name = $ruleName[$port]
  if (-not $name) { $name = "AuliaPos adapter (TCP $port)" }
  $rules = @(Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)
  if ($rules.Count -eq 0) { L ("  $name : TIDAK ADA"); $gagal += 1; continue }

  $ok = $true
  foreach ($r in $rules) {
    $af = $r | Get-NetFirewallAddressFilter
    $pf = $r | Get-NetFirewallPortFilter
    $addrOk = (@($af.RemoteAddress) -join ',') -eq ($AllowFrom -join ',')
    L ("  $name : enabled=$($r.Enabled) action=$($r.Action) profil=$($r.Profile) port=$($pf.LocalPort) remote=$(@($af.RemoteAddress) -join ',')")
    if ($r.Enabled -ne 'True' -or $r.Action -ne 'Allow' -or -not $addrOk) { $ok = $false }
  }
  if (-not $ok) { L ("  $name : TIDAK sesuai harapan"); $gagal += 1 }
}

if ($gagal -gt 0) {
  L ("=== SELESAI DENGAN $gagal MASALAH -- periksa firewall ===")
  exit 1
}
L '=== SELESAI ==='
exit 0