# whatRust one-line installer — Windows.
#
#   irm https://raw.githubusercontent.com/karem505/whatRust/master/install.ps1 | iex
#
# Downloads the latest published GitHub release installer for this PC's CPU
# (x64 or ARM64; NSIS .exe, falling back to the .msi) and runs it.
$ErrorActionPreference = 'Stop'
$repo = 'karem505/whatRust'
$app  = 'whatRust'

# IsWow64Process2 reports the OS CPU even when this PowerShell is itself emulated.
# GetNativeSystemInfo does not: under emulation it describes the emulated CPU.
# The decision stays in C#. PowerShell's [ref] does not reliably update an
# `out ushort`, so a successful call can come back as machine type 0.
function Get-InstallArch {
  $native = ''
  try {
    if (-not ('WhatRustArch' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WhatRustArch {
  [DllImport("kernel32.dll")]
  public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);
  public static string Native() {
    ushort processMachine = 0;
    ushort nativeMachine = 0;
    if (!IsWow64Process2(GetCurrentProcess(), out processMachine, out nativeMachine)) {
      return "";
    }
    if (nativeMachine == 43620) return "arm64";
    if (nativeMachine == 34404) return "x64";
    return "other:" + nativeMachine.ToString("X4");
  }
}
'@ | Out-Null
    }
    $native = [WhatRustArch]::Native()
  } catch {
    $native = ''
  }
  switch ($native) {
    'arm64' { return 'arm64' }
    'x64' { return 'x64' }
  }
  if ($native -like 'other:*') {
    throw "This installer supports 64-bit x64 and ARM64 Windows. This PC reports machine type 0x$($native.Substring(6))."
  }
  $pa = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $pa = $env:PROCESSOR_ARCHITEW6432 }
  switch ($pa) {
    'ARM64' { return 'arm64' }
    'AMD64' { return 'x64' }
    default { throw "This installer supports 64-bit x64 and ARM64 Windows (PROCESSOR_ARCHITECTURE=$pa)." }
  }
}

Write-Host "Installing $app (latest)..." -ForegroundColor Green

try {
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" `
    -Headers @{ 'User-Agent' = 'whatrust-installer' }
} catch {
  throw "Couldn't reach the GitHub release. Is $repo public with a published release? ($_)"
}

$arch = Get-InstallArch
Write-Host "CPU architecture: $arch"
$token = "_$arch"
$asset = $rel.assets | Where-Object { $_.name -like "*$token-setup.exe" } | Select-Object -First 1
if (-not $asset) {
  $asset = $rel.assets | Where-Object { $_.name -like "*$token*.msi" } | Select-Object -First 1
}
if (-not $asset) {
  $hint = if ($arch -eq 'arm64') {
    ' ARM64 builds are attached a few minutes after each release. The x64 installer on the release page runs under emulation, and that copy keeps receiving x64 updates. Run this script again after the ARM64 file is up to install the native build.'
  } else {
    ' The build may still be running.'
  }
  throw "No $arch installer (.exe or .msi) in the latest release.$hint"
}

$out = Join-Path $env:TEMP $asset.name
Write-Host "Downloading $($asset.name)..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $out -UseBasicParsing

# GitHub publishes a SHA-256 digest for each release asset; refuse a mismatch.
$expected = if ($asset.digest -match '^sha256:(?<h>[0-9a-fA-F]{64})$') { $Matches.h } else { $null }
$actual = (Get-FileHash -Algorithm SHA256 -Path $out).Hash
if ($expected) {
  if ($actual -ne $expected) {
    Remove-Item -Force $out
    throw "Checksum mismatch for $($asset.name): expected $expected, got $actual. Aborting."
  }
  Write-Host "SHA-256 verified: $actual"
} else {
  Write-Warning "GitHub published no digest for this asset; SHA-256 is $actual. Compare it with the release notes before trusting the installer."
}

Write-Host "Launching installer..."
if ($asset.name -match '\.msi$') {
  Start-Process msiexec.exe -ArgumentList "/i `"$out`"" -Wait
} else {
  Start-Process -FilePath $out -Wait
}
Write-Host "Done. Launch '$app' from the Start menu." -ForegroundColor Green
