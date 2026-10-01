<#
  status-firewall.ps1 -- diagnosa kenapa port 3000/8080 tidak terjangkau dari LAN.

  Hanya cmdlet (tidak ada socket mentah). Output: D:\kilo\status-firewall.log
#>
$log = 'D:\kilo\status-firewall.log'
New-Item -ItemType Directory -Path 'D:\kilo' -Force | Out-Null
Set-Content -LiteralPath $log -Value ''
function L { param([string]$m) Add-Content -LiteralPath $log -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) }

L '=== STATUS FIREWALL AULIA3 ==='

L '--- produk keamanan terdaftar ---'
foreach ($ns in @('root/SecurityCenter2')) {
  foreach ($cls in @('FirewallProduct', 'AntiVirusProduct')) {
    try {
      Get-CimInstance -Namespace $ns -ClassName $cls -ErrorAction Stop | ForEach-Object {
        L ('  ' + $cls + ': ' + $_.displayName + '  state=0x' + ('{0:X}' -f $_.productState))
      }
    } catch { L ('  ' + $cls + ': (tidak bisa dibaca) ' + $_.Exception.Message) }
  }
}

L '--- profil jaringan aktif ---'
Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object {
  L ('  ' + $_.InterfaceAlias + ': ' + $_.NetworkCategory + '  (IPv4 ' + $_.IPv4Connectivity + ')')
}

L '--- profil Windows Firewall ---'
Get-NetFirewallProfile -ErrorAction SilentlyContinue | ForEach-Object {
  L ('  ' + $_.Name + ': enabled=' + $_.Enabled + '  inbound=' + $_.DefaultInboundAction + '  outbound=' + $_.DefaultOutboundAction)
}

L '--- listener 3000/8080: alamat bind ---'
foreach ($p in @(3000, 8080)) {
  $c = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
  if ($c.Count -eq 0) { L ('  ' + $p + ': tidak listen') }
  foreach ($x in $c) { L ('  ' + $p + ': ' + $x.LocalAddress + ' pid=' + $x.OwningProcess) }
}

L '--- rule firewall untuk port 3000/8080 (aktif) ---'
foreach ($p in @(3000, 8080)) {
  $rules = @(Get-NetFirewallPortFilter -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq $p })
  $n = 0
  foreach ($r in $rules) {
    $rule = Get-NetFirewallRule -AssociatedNetFirewallPortFilter $r -ErrorAction SilentlyContinue
    if ($rule) { foreach ($x in $rule) { $n++; L ('  port ' + $p + ' -> ' + $x.DisplayName + ' [' + $x.Direction + ' ' + $x.Action + ' enabled=' + $x.Enabled + ' profile=' + $x.Profile + ']') } }
  }
  if ($n -eq 0) { L ('  port ' + $p + ': TIDAK ADA rule khusus') }
}

L '--- rule firewall untuk node.exe ---'
$nodes = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -like '*node.exe*' })
if ($nodes.Count -eq 0) { L '  (tidak ada rule untuk node.exe)' }
foreach ($a in $nodes) {
  $rule = Get-NetFirewallRule -AssociatedNetFirewallApplicationFilter $a -ErrorAction SilentlyContinue
  foreach ($x in $rule) { L ('  ' + $x.DisplayName + ' [' + $x.Direction + ' ' + $x.Action + ' enabled=' + $x.Enabled + ' profile=' + $x.Profile + ']') }
}

L '=== SELESAI ==='