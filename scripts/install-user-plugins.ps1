param(
  [string]$MavisRoot = "$env:USERPROFILE\.mavis\agents\mavis",
  [switch]$NoBackup
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$sourceDir = Join-Path $repoRoot "plugins"
$targetDir = Join-Path $MavisRoot "opencode\plugins"

if (-not (Test-Path -LiteralPath $sourceDir)) {
  throw "source plugin dir not found: $sourceDir"
}

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

$plugins = @("openrouter-lifecycle.js", "prompt-surface.js", "request-guard.js", "prompt-cache.js")
foreach ($plugin in $plugins) {
  $source = Join-Path $sourceDir $plugin
  $target = Join-Path $targetDir $plugin

  if (-not $NoBackup -and (Test-Path -LiteralPath $target)) {
    $backupDir = Join-Path $targetDir "backups"
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backup = Join-Path $backupDir "$plugin.before-token-optimizer.$stamp"
    Copy-Item -LiteralPath $target -Destination $backup -Force
    Write-Output "backup=$backup"
  }

  Copy-Item -LiteralPath $source -Destination $target -Force
  Write-Output "installed=$target"
}

$opencodeConfig = Join-Path $MavisRoot "opencode\opencode.json"
if (Test-Path -LiteralPath $opencodeConfig) {
  if (-not $NoBackup) {
    $backupDir = Join-Path (Split-Path -Parent $opencodeConfig) "backups"
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backup = Join-Path $backupDir "opencode.json.before-token-optimizer.$stamp"
    Copy-Item -LiteralPath $opencodeConfig -Destination $backup -Force
    Write-Output "backup=$backup"
  }

  $json = Get-Content -LiteralPath $opencodeConfig -Raw | ConvertFrom-Json
  $managed = @("openrouter-lifecycle", "prompt-surface", "request-guard", "prompt-cache")
  $existing = @()
  if ($json.plugin) {
    $existing = @($json.plugin | Where-Object { $managed -notcontains $_ })
  }
  if ($existing -notcontains "mavis") {
    $existing = @("mavis") + $existing
  }
  $result = New-Object System.Collections.Generic.List[string]
  foreach ($item in $existing) {
    [void]$result.Add([string]$item)
    if ($item -eq "mavis") {
      foreach ($pluginName in $managed) { [void]$result.Add($pluginName) }
    }
  }
  $json.plugin = @($result)
  $json | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $opencodeConfig -Encoding UTF8
  Write-Output "registered_plugins=$opencodeConfig"
  Write-Output "plugin_order=$($result -join ',')"
} else {
  Write-Output "opencode_config_missing=$opencodeConfig"
}
