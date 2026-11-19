# whatRust one-line installer — Windows.
#
#   irm https://raw.githubusercontent.com/evdev/whatRust/master/install.ps1 | iex
#
# Downloads this fork's checked-in installer for this PC's CPU and runs it.
$ErrorActionPreference = 'Stop'
$repo = 'evdev/whatRust'
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

Write-Host "Installing $app from $repo..." -ForegroundColor Green
$arch = Get-InstallArch
Write-Host "CPU architecture: $arch"
# Update these together with the checked-in installers and SHA256SUMS.
$installers = @{
  arm64 = @{
    name = 'whatRust_0.6.16_arm64-setup.exe'
    sha256 = '46f8222182ea92ab09794797ae4797b133a8844da2ec809e5e58d656fe2e2b9f'
  }
  x64 = @{
    name = 'whatRust_0.6.16_x64-setup.exe'
    sha256 = '60ee1275c7d7fecf05d2cf43e907b535885e7436a3ac486e1ca64e97b163ed14'
  }
}
$name = $installers[$arch].name
$expected = $installers[$arch].sha256
$out = Join-Path $env:TEMP $name
Write-Host "Downloading $name..."
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/$repo/master/installers/$name" -OutFile $out -UseBasicParsing
$actual = (Get-FileHash -Algorithm SHA256 -Path $out).Hash
if ($actual -ne $expected) {
  throw "Checksum mismatch for ${name}: expected $expected, got $actual. The installer was not started."
}
Write-Host "SHA-256 verified: $actual"

Write-Host "Launching installer..."
$process = Start-Process -FilePath $out -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Installer exited with code $($process.ExitCode). It may have been cancelled or encountered an error." }
Write-Host "Done. Launch '$app' from the Start menu." -ForegroundColor Green
