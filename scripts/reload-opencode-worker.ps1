$ErrorActionPreference = "Stop"

$bridge = Join-Path $env:USERPROFILE ".mavis\agents\mavis\bridge\bridge.mjs"
if (-not (Test-Path -LiteralPath $bridge)) {
  throw "bridge.mjs not found at $bridge"
}

$status = node $bridge status | ConvertFrom-Json
foreach ($server in $status.servers) {
  Write-Output "stopping opencode serve pid=$($server.pid) port=$($server.port)"
  Stop-Process -Id $server.pid -Force
}

Start-Sleep -Seconds 8
node $bridge status

