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

$plugins = @("openrouter-lifecycle.js", "prompt-cache.js")
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

