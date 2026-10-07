<#
  check-service.ps1 -- AC-9: verifikasi Windows Service gateway terdaftar dan
  Running pada MESIN YANG SUDAH TERINSTAL. Berbeda dari check lain di folder
  ini: skrip ini TIDAK memakai fixture sandbox, dan karenanya TIDAK
  dimasukkan ke run-checks.ps1 (pola yang sama dengan test-send.js) --
  jalankan manual setelah install.ps1 selesai, sesuai petunjuk-penggunaan.md.
#>
[CmdletBinding()]
param(
  [string]$PgServiceName        = 'postgresql-auliagw',
  [string]$EvolutionServiceName = 'AuliaGatewayEvolution',
  [string]$AdapterServiceName   = 'AuliaGatewayAdapter'
)

$ErrorActionPreference = 'Continue'
$problems = New-Object System.Collections.Generic.List[string]

function Test-OneService {
  param([string]$Name, [bool]$RequireAutomatic)
  $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $svc) { $problems.Add($Name + ': TIDAK TERDAFTAR'); return }
  if ($svc.Status -ne 'Running') { $problems.Add($Name + ': status=' + $svc.Status + ' (seharusnya Running)') }
  if ($RequireAutomatic -and $svc.StartType -ne 'Automatic') {
    $problems.Add($Name + ': StartType=' + $svc.StartType + ' (seharusnya Automatic)')
  }
  Write-Host ('  ' + $Name + ': status=' + $svc.Status + ' start=' + $svc.StartType)
}

Write-Host '=== check-service (AC-9) ==='
Test-OneService -Name $PgServiceName -RequireAutomatic $false
Test-OneService -Name $EvolutionServiceName -RequireAutomatic $true
Test-OneService -Name $AdapterServiceName -RequireAutomatic $true

if ($problems.Count -eq 0) { Write-Host 'PASS check-service (AC-9)'; exit 0 }
Write-Host 'FAIL check-service (AC-9):'
foreach ($p in $problems) { Write-Host ('  - ' + $p) }
exit 1
