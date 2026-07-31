<#
.SYNOPSIS
  Red Request — Windows uninstaller.

.DESCRIPTION
  Runs the registered NSIS uninstaller and cleans up what install.ps1 added on top of
  it: the `rr.cmd` forwarder and the user PATH entry. The Windows counterpart of
  uninstall.sh.

  App data under <project>\.red\request and %USERPROFILE%\.red\request is left
  untouched — delete those by hand if you also want to wipe your requests/collections.

.EXAMPLE
  irm https://raw.githubusercontent.com/reddb-io/red-request/main/uninstall.ps1 | iex
#>
[CmdletBinding()]
param(
  # Show the uninstall wizard instead of removing silently.
  [switch]$Interactive = ($env:RED_REQUEST_INTERACTIVE -eq '1')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Shortcut = 'rr'
$ProductName = 'Red Request'
$removed = $false

function Get-InstalledEntry {
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    foreach ($key in Get-ChildItem $root -ErrorAction SilentlyContinue) {
      $props = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
      if ($props.DisplayName -eq $ProductName) { return $props }
    }
  }
  return $null
}

$entry = Get-InstalledEntry
$installDir = if ($entry) { $entry.InstallLocation } else { $null }

# Drop the `rr.cmd` forwarder first — it lives inside the install dir, which the
# uninstaller may refuse to remove while it holds unexpected files.
if ($installDir -and (Test-Path $installDir)) {
  $cmd = Join-Path $installDir "$Shortcut.cmd"
  if (Test-Path $cmd) {
    Remove-Item $cmd -Force -ErrorAction SilentlyContinue
    Write-Host "OK removed $cmd" -ForegroundColor Green
    $removed = $true
  }
}

if ($entry) {
  # QuietUninstallString is the vendor-provided silent form; fall back to appending /S
  # to the plain UninstallString (Tauri's NSIS uninstaller accepts it).
  $uninstall = if ($Interactive) { $entry.UninstallString }
               elseif ($entry.QuietUninstallString) { $entry.QuietUninstallString }
               else { "$($entry.UninstallString) /S" }
  if ($uninstall) {
    Write-Host "> running the uninstaller..." -ForegroundColor DarkGray
    # UninstallString is a command line, not a bare path — hand it to cmd so quoted
    # paths and trailing flags are parsed the way the registry intends.
    $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $uninstall -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
      Write-Host "!  uninstaller exited with code $($proc.ExitCode)" -ForegroundColor Yellow
    } else {
      Write-Host "OK removed $ProductName" -ForegroundColor Green
      $removed = $true
    }
  }
} else {
  Write-Host "!  $ProductName is not installed (no uninstall entry found)" -ForegroundColor Yellow
}

# Strip the PATH entry install.ps1 added. Only our install dir — never rewrite the rest.
if ($installDir) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($current) {
    $trimmed = $installDir.TrimEnd('\')
    $entries = $current -split ';' | Where-Object { $_ -ne '' -and $_.TrimEnd('\') -ne $trimmed }
    $updated = $entries -join ';'
    if ($updated -ne $current) {
      [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
      Write-Host "OK removed $installDir from your user PATH" -ForegroundColor Green
      $removed = $true
    }
  }
}

if (-not $removed) { Write-Host 'Nothing to remove.' }
else {
  Write-Host ''
  Write-Host 'Your requests/collections under .red\request were left untouched.'
}
