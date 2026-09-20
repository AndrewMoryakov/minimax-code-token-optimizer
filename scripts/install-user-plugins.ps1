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

  # A UTF-8 BOM here breaks every JSON.parse reader, including this repo's own
  # scripts, so read past it and write the file back without one.
  $raw = [IO.File]::ReadAllText($opencodeConfig)
  $raw = $raw -replace "^\uFEFF", ""
  try {
    $json = $raw | ConvertFrom-Json
  } catch {
    throw "opencode config does not parse: $opencodeConfig`n$($_.Exception.Message)"
  }
  $managed = @("openrouter-lifecycle", "prompt-surface", "request-guard", "prompt-cache")
  $existing = @()
  if ($json.PSObject.Properties.Name -contains "plugin" -and $json.plugin) {
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
  # Assigning to a property the object does not have throws on Windows
  # PowerShell 5.1, so add it when the config had no plugin list at all.
  if ($json.PSObject.Properties.Name -contains "plugin") {
    $json.plugin = @($result)
  } else {
    $json | Add-Member -MemberType NoteProperty -Name plugin -Value @($result)
  }
  $text = ($json | ConvertTo-Json -Depth 20)
  [IO.File]::WriteAllText($opencodeConfig, $text + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
  Write-Output "registered_plugins=$opencodeConfig"
  Write-Output "plugin_order=$($result -join ',')"
} else {
  Write-Output "opencode_config_missing=$opencodeConfig"
}
