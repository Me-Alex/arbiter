# live-rescan-verify.ps1
# Start the server, scrape every book, and scan immediately after the scrape
# settles. The scan gates on a 10-minute prematch freshness window, so the
# scrape and the scan have to be one sequence -- a gap long enough to let the
# captures age out returns an honest but empty scan.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:PORT = '3022'
$server = Start-Process -FilePath 'node' -ArgumentList 'src/server.mjs' -PassThru -WindowStyle Hidden
Write-Output "server pid=$($server.Id)"

try {
  $base = 'http://127.0.0.1:3022'
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    try { Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 3 | Out-Null; break } catch {}
  }
  Write-Output 'health ok'

  $token = (Invoke-RestMethod -Uri "$base/api/csrf").token
  $null = Invoke-RestMethod -Uri "$base/api/scrape" -Method Post `
    -Headers @{ 'x-arbiter-token' = $token } -ContentType 'application/json' `
    -Body '{"bookIds":[]}' -TimeoutSec 120
  Write-Output 'scrape launched'

  for ($i = 0; $i -lt 180; $i++) {
    Start-Sleep -Seconds 10
    $s = (Invoke-RestMethod -Uri "$base/api/scrape/state").state
    Write-Output "$((Get-Date).ToString('HH:mm:ss')) status=$($s.status) jobs=$($s.jobs.Count)"
    if ($s.status -ne 'running') { break }
  }

  $token = (Invoke-RestMethod -Uri "$base/api/csrf").token
  Invoke-RestMethod -Uri "$base/api/scan" -Method Post `
    -Headers @{ 'x-arbiter-token' = $token } -ContentType 'application/json' `
    -Body '{}' -TimeoutSec 900 -OutFile 'live-rescan.json'
  Write-Output 'scan written'
}
finally {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}