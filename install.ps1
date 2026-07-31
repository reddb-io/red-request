<#
.SYNOPSIS
  Red Request — Windows installer / auto-upgrader.

.DESCRIPTION
  Resolves the latest GitHub release, downloads the NSIS setup for this machine's
  architecture, verifies its sha256 against the release's checksums.txt, and runs it
  silently. Re-run any time to upgrade; it no-ops when you're already on the latest tag.

  The Windows counterpart of install.sh (Linux/macOS). Same release assets, same
  checksum verification, same `rr` shortcut on PATH.

  Installs per-user (no admin prompt) — Tauri's NSIS bundle defaults to a
  current-user install under %LOCALAPPDATA%.

.EXAMPLE
  irm https://raw.githubusercontent.com/reddb-io/red-request/main/install.ps1 | iex

.EXAMPLE
  # With options, download first (a piped script can't take parameters):
  irm https://raw.githubusercontent.com/reddb-io/red-request/main/install.ps1 -OutFile install.ps1
  .\install.ps1 -Version v0.64.4 -Force

.NOTES
  When piped to `iex` you can still pass options through the environment:
    $env:RED_REQUEST_VERSION = 'v0.64.4'
    $env:RED_REQUEST_FORCE = '1'
#>
[CmdletBinding()]
param(
  # Install/upgrade to a specific release tag (default: latest).
  [string]$Version = $env:RED_REQUEST_VERSION,
  # Reinstall even when already on the latest tag.
  [switch]$Force = ($env:RED_REQUEST_FORCE -eq '1'),
  # Show the NSIS wizard instead of installing silently.
  [switch]$Interactive = ($env:RED_REQUEST_INTERACTIVE -eq '1'),
  # Don't add the install directory to the user PATH.
  [switch]$NoModifyPath = ($env:RED_REQUEST_NO_MODIFY_PATH -eq '1'),
  # Plain output (no colors) for CI logs.
  [switch]$NoColor = ($env:NO_COLOR -ne $null -and $env:NO_COLOR -ne '')
)

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest's progress bar makes large downloads several times slower on
# Windows PowerShell 5.1 — it repaints the console per chunk.
$ProgressPreference = 'SilentlyContinue'
# 5.1 defaults to TLS 1.0/1.1, which github.com refuses.
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$Repo = 'reddb-io/red-request'
$BinName = 'red-request'
$Shortcut = 'rr'
$ProductName = 'Red Request'

# ── ui ─────────────────────────────────────────────────────────────────────
$UseColor = -not $NoColor -and $Host.UI.RawUI -ne $null
function Write-Step($n, $total, $title) {
  Write-Host ''
  if ($UseColor) { Write-Host "Step $n/$total  $title" -ForegroundColor Magenta }
  else { Write-Host "Step $n/$total  $title" }
}
function Write-Say($msg) {
  if ($UseColor) { Write-Host "> $msg" -ForegroundColor DarkGray } else { Write-Host "> $msg" }
}
function Write-Ok($msg) {
  if ($UseColor) { Write-Host "OK $msg" -ForegroundColor Green } else { Write-Host "OK $msg" }
}
function Write-Warn2($msg) {
  if ($UseColor) { Write-Host "!  $msg" -ForegroundColor Yellow } else { Write-Host "!  $msg" }
}
function Write-Err($msg) { throw $msg }
function Write-Banner {
  if (-not $UseColor) { return }
  Write-Host ''
  Write-Host '  R E D  ·  R E Q U E S T' -ForegroundColor Red
  Write-Host '  Open-source API client · powered by recker + RedDB' -ForegroundColor DarkGray
}

# ── platform ───────────────────────────────────────────────────────────────
# Only x86_64 setups are published: RedDB ships no `red-windows-aarch64.exe` sidecar
# to embed, so there is nothing to build an arm64 bundle from. Windows 11 on ARM runs
# x64 binaries under emulation, so arm64 hosts get the x86_64 build with a note.
function Get-TargetArch {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
  switch ($arch) {
    'AMD64' { return 'x86_64' }
    'ARM64' {
      Write-Warn2 'arm64 Windows detected — installing the x86_64 build (runs under emulation).'
      Write-Warn2 'A native arm64 build needs an arm64 RedDB sidecar, which RedDB does not publish yet.'
      return 'x86_64'
    }
    'x86' { Write-Err '32-bit Windows is not supported — Red Request ships x86_64 only.' }
    default { Write-Err "Unsupported architecture: $arch" }
  }
}

# Must match the names release.yml stages onto the release.
function Get-AssetName($arch) { "$BinName-windows-$arch-setup.exe" }

# ── release resolution ─────────────────────────────────────────────────────
# /releases/latest 302-redirects to /releases/tag/<tag>; read the final URL instead of
# hitting the rate-limited JSON API, exactly like install.sh. Fall back to the API when
# the redirect can't be read (proxies, odd PowerShell hosts).
function Resolve-Tag {
  if ($Version) { return $Version }
  try {
    $res = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" -UseBasicParsing
    $final = $null
    # PowerShell 7 exposes the final URI on the request message; 5.1 on ResponseUri.
    if ($res.BaseResponse.PSObject.Properties.Name -contains 'RequestMessage') {
      $final = $res.BaseResponse.RequestMessage.RequestUri.AbsoluteUri
    } elseif ($res.BaseResponse.PSObject.Properties.Name -contains 'ResponseUri') {
      $final = $res.BaseResponse.ResponseUri.AbsoluteUri
    }
    if ($final -and $final -match '/releases/tag/(.+)$') { return $Matches[1] }
  } catch { }
  try {
    $json = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" `
      -UseBasicParsing -Headers @{ 'User-Agent' = 'red-request-install' }
    if ($json.tag_name) { return $json.tag_name }
  } catch { }
  Write-Err 'could not resolve the latest release tag'
}

function Get-AssetUrl($tag, $asset) { "https://github.com/$Repo/releases/download/$tag/$asset" }

# ── installed-state probe ──────────────────────────────────────────────────
# Scan the per-user and machine uninstall hives for our DisplayName rather than
# guessing NSIS's key name (Tauri has changed it between versions). Returns the
# registry entry so callers get DisplayVersion and InstallLocation together.
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

# The installed launcher. Tauri names the exe from the bundle config, which has changed
# across versions, so find it rather than hardcode: the only top-level .exe in the install
# dir that isn't the uninstaller. Prefer an exact `red-request.exe` when it's there.
function Get-InstalledExe($installLocation) {
  if (-not $installLocation -or -not (Test-Path $installLocation)) { return $null }
  $exact = Join-Path $installLocation "$BinName.exe"
  if (Test-Path $exact) { return $exact }
  $candidates = Get-ChildItem -Path $installLocation -Filter '*.exe' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch '^uninstall' }
  if ($candidates) { return $candidates[0].FullName }
  return $null
}

# ── download + verify ──────────────────────────────────────────────────────
function Get-File($url, $dest, $label) {
  Write-Say $label
  try {
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
  } catch {
    Write-Err "download failed: $url`n  $($_.Exception.Message)"
  }
}

# checksums.txt lines are "<hex>  <name>", written by sha256sum in the release workflow.
#
# Fetched with -OutFile and read back off disk rather than using the response's .Content:
# GitHub serves release assets as application/octet-stream, and for a non-text content type
# Invoke-WebRequest hands back a byte[], not a string. Splitting that yields no lines, so
# every asset silently "had no checksum" and verification was skipped.
function Test-Checksum($file, $tag, $asset, $tmpDir) {
  $text = $null
  try {
    $sums = Join-Path $tmpDir 'checksums.txt'
    Invoke-WebRequest -Uri (Get-AssetUrl $tag 'checksums.txt') -OutFile $sums -UseBasicParsing
    $text = Get-Content -Path $sums -Raw
  } catch {
    Write-Warn2 "no checksums.txt in $tag — skipping verify"
    return
  }
  $want = $null
  foreach ($line in ($text -split "`n")) {
    $parts = ($line.Trim() -split '\s+')
    if ($parts.Count -ge 2 -and ($parts[1] -eq $asset -or $parts[1] -eq "*$asset")) {
      $want = $parts[0].ToLower(); break
    }
  }
  if (-not $want) { Write-Warn2 "no checksum for $asset in checksums.txt — skipping verify"; return }
  $got = (Get-FileHash -Path $file -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $want) {
    Write-Err "checksum mismatch for $asset`n   expected $want`n   got      $got"
  }
  Write-Ok 'sha256 verified'
}

# ── PATH + `rr` shortcut ───────────────────────────────────────────────────
# The NSIS bundle installs the app and its sidecars but doesn't touch PATH, so
# `red-request` / `rr .` wouldn't work from a terminal. Mirror what install.sh does on
# Linux: put the install dir on the *user* PATH and drop an `rr.cmd` forwarder next to
# the exe. Both are per-user, so no elevation is needed.
function Add-ToUserPath($dir) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $current) { $current = '' }
  $entries = $current -split ';' | Where-Object { $_ -ne '' }
  if ($entries -contains $dir) { return }
  $updated = (@($entries) + $dir) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
  # Make it usable in this session too, not just new terminals.
  $env:Path = "$env:Path;$dir"
  Write-Ok "added $dir to your user PATH — open a new terminal to pick it up"
}

function Add-Shortcut($exe) {
  $dir = Split-Path -Parent $exe
  $cmd = Join-Path $dir "$Shortcut.cmd"
  # %* forwards args, so `rr .` opens the current folder as a project like on Linux.
  Set-Content -Path $cmd -Encoding ASCII -Value "@echo off`r`n`"$exe`" %*"
  Write-Ok "created $Shortcut -> $(Split-Path -Leaf $exe) ($cmd)"
}

# ── verify ─────────────────────────────────────────────────────────────────
# Print the versions so a broken bundled sidecar surfaces here, at install time, rather
# than as a blank window on first launch (mirrors install.sh's verify_install).
function Test-Install($exe) {
  Write-Say 'verifying...'
  if (-not $exe -or -not (Test-Path $exe)) { Write-Warn2 "$BinName not found after install"; return }
  try {
    $v = (& $exe --version 2>$null | Select-Object -First 1)
    if ($v) { Write-Ok $v }
    else { Write-Warn2 "$BinName --version produced no output (build older than this installer expects)" }
  } catch {
    Write-Warn2 "could not run $exe --version: $($_.Exception.Message)"
  }
  $red = Join-Path (Split-Path -Parent $exe) 'red.exe'
  if (Test-Path $red) {
    try {
      $rv = (& $red --version 2>&1 | Select-Object -First 1)
      Write-Ok $rv
    } catch {
      Write-Warn2 'the embedded reddb sidecar (red.exe) failed to run — the app would open to a blank screen'
    }
  }
}

# ── main ───────────────────────────────────────────────────────────────────
Write-Banner

$arch = Get-TargetArch
$asset = Get-AssetName $arch
$tag = Resolve-Tag
$installed = Get-InstalledEntry
$current = if ($installed) { $installed.DisplayVersion } else { $null }

# Release tags are `vX.Y.Z`; NSIS records DisplayVersion as the bare `X.Y.Z`.
if ($current -and "v$current" -eq $tag -and -not $Force) {
  Write-Ok "$ProductName $current is already the latest - nothing to do. (-Force to reinstall)"
  return
}

Write-Step 1 4 'Resolving latest release'
if ($current) { Write-Say "upgrading $current -> $tag (windows/$arch)" }
else { Write-Say "installing $tag (windows/$arch)" }

Write-Step 2 4 'Downloading + verifying'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("red-request-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  $setup = Join-Path $tmp $asset
  Get-File (Get-AssetUrl $tag $asset) $setup "downloading $asset"
  Test-Checksum $setup $tag $asset $tmp

  Write-Step 3 4 'Installing'
  # Tauri's NSIS installer: /S is silent, /P shows a passive progress bar. Silent is the
  # default here so the one-liner completes unattended; -Interactive gives the wizard.
  $nsisArgs = if ($Interactive) { @() } else { @('/S') }
  Write-Say $(if ($Interactive) { 'launching the setup wizard...' } else { 'running the setup silently...' })
  $proc = Start-Process -FilePath $setup -ArgumentList $nsisArgs -Wait -PassThru
  if ($proc.ExitCode -ne 0) { Write-Err "setup exited with code $($proc.ExitCode)" }
  Write-Ok "$ProductName $tag installed"
} finally {
  Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

$installed = Get-InstalledEntry
$exe = Get-InstalledExe $installed.InstallLocation
if ($exe) {
  Add-Shortcut $exe
  if (-not $NoModifyPath) { Add-ToUserPath (Split-Path -Parent $exe) }
  else { Write-Warn2 "add $(Split-Path -Parent $exe) to your PATH to run $BinName from a terminal" }
} else {
  Write-Warn2 'could not locate the installed binary; skipping the PATH + rr shortcut wiring'
}

Write-Step 4 4 'Verifying'
Test-Install $exe

Write-Host ''
Write-Ok "$ProductName $tag ready"
Write-Host ''
Write-Host "  $BinName        # run the desktop app"
Write-Host "  $Shortcut .              # open the current folder as a project"
Write-Host ''
Write-Host 'Remove it from Settings > Apps > Installed apps, or with uninstall.ps1.'
