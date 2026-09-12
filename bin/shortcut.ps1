<#
.SYNOPSIS
  Create Start Menu and Desktop shortcuts for the packaged DSH Desktop.

.DESCRIPTION
  The portable build is a folder, not an installer, so the shortcuts are the one
  piece of system integration that has to be made explicitly. They point at the
  packaged executable when it exists, and otherwise at the Electron runtime with
  the project directory as its argument, so a shortcut is useful before packaging
  too. Nothing is written outside the Start Menu and the Desktop.

.PARAMETER Name
  The shortcut's display name. Defaults to "DSH Desktop".

.PARAMETER DesktopOnly
  Create only the Desktop shortcut.

.PARAMETER Dev
  Force the development target (the Electron runtime plus this project directory)
  even when a packaged build exists.

.EXAMPLE
  pwsh -NoProfile -File bin/shortcut.ps1
#>
[CmdletBinding()]
param(
    [string]$Name = 'DSH Desktop',
    [switch]$DesktopOnly,
    [switch]$Dev
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$packagedExe = Join-Path $root 'dist\DSH Desktop\DSH Desktop.exe'
$devExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$packagedIcon = Join-Path $root 'dist\DSH Desktop\icon.ico'
$devIcon = Join-Path $root 'build\icon.ico'

if (-not $Dev -and (Test-Path -LiteralPath $packagedExe)) {
    $targetPath = $packagedExe
    $arguments = ''
    $workingDirectory = Split-Path -Parent $packagedExe
    $iconPath = if (Test-Path -LiteralPath $packagedIcon) { $packagedIcon } else { $devIcon }
    $mode = 'packaged'
}
elseif (Test-Path -LiteralPath $devExe) {
    $targetPath = $devExe
    $arguments = '"{0}"' -f $root
    $workingDirectory = $root
    $iconPath = $devIcon
    $mode = 'development'
}
else {
    Write-Error "Neither $packagedExe nor $devExe exists. Run 'npm install' (see RUNBOOK.md), then 'npm run pack'."
    exit 1
}

if (-not (Test-Path -LiteralPath $iconPath)) {
    Write-Warning "No icon at $iconPath - the shortcut will use the executable's own icon. Run 'npm run icon' to create it."
    $iconPath = $null
}

$destinations = @()
if (-not $DesktopOnly) {
    $destinations += (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
}
$destinations += [Environment]::GetFolderPath('Desktop')

$shell = New-Object -ComObject WScript.Shell
$created = @()
foreach ($directory in $destinations) {
    if (-not (Test-Path -LiteralPath $directory)) {
        Write-Warning "Skipping missing directory $directory"
        continue
    }
    $linkPath = Join-Path $directory "$Name.lnk"
    $link = $shell.CreateShortcut($linkPath)
    $link.TargetPath = $targetPath
    if ($arguments -ne '') { $link.Arguments = $arguments }
    $link.WorkingDirectory = $workingDirectory
    if ($null -ne $iconPath) { $link.IconLocation = "$iconPath,0" }
    $link.Description = 'DSH Desktop - DeepSeek Harness in a desktop window'
    $link.Save()

    if (Test-Path -LiteralPath $linkPath) {
        $created += $linkPath
        Write-Host "created  $linkPath"
    }
    else {
        Write-Error "Failed to create $linkPath"
    }
}

Write-Host ""
Write-Host "mode     : $mode"
Write-Host "target   : $targetPath"
if ($arguments -ne '') { Write-Host "arguments: $arguments" }
Write-Host "shortcuts: $($created.Count)"
