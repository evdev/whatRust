# Run from any directory: pwsh scripts/test-windows-bootstrap.ps1
# No installer is executed; the process and download are replaced by test doubles.
$ErrorActionPreference = 'Stop'
$sourceDir = Split-Path -Parent $PSScriptRoot
$env:TEMP = Join-Path $env:TEMP 'whatrust-bootstrap-test'
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
$source = Get-Content (Join-Path $sourceDir 'install.ps1') -Raw
foreach ($testArch in @('arm64', 'x64')) {
  $installer = @(Get-ChildItem -LiteralPath (Join-Path $sourceDir 'installers') -Filter "*_${testArch}-setup.exe")
  if ($installer.Count -ne 1) { throw "Expected one installer for $testArch" }
  $script:expectedFile = $installer[0].Name
  $script:started = $false
  function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing)
    if ($Uri -notlike "*/installers/$script:expectedFile") { throw "Wrong installer URL: $Uri" }
    Copy-Item -LiteralPath (Join-Path $sourceDir "installers\$script:expectedFile") -Destination $OutFile -Force
  }
  function Start-Process {
    param($FilePath, [switch]$Wait, [switch]$PassThru)
    if ((Split-Path $FilePath -Leaf) -ne $script:expectedFile) { throw 'Wrong executable started' }
    $script:started = $true
    [pscustomobject]@{ ExitCode = 0 }
  }
  $test = $source.Replace('$arch = Get-InstallArch', "`$arch = '$testArch'")
  Invoke-Expression $test
  if (-not $script:started) { throw "Installer not started for $testArch" }
}

# A corrupt download must never reach Start-Process.
$script:started = $false
function Invoke-WebRequest {
  param($Uri, $OutFile, [switch]$UseBasicParsing)
  Set-Content -LiteralPath $OutFile -Value 'not an installer'
}
$rejected = $false
try { Invoke-Expression $test } catch { $rejected = $_.Exception.Message -like '*Checksum mismatch*' }
if (-not $rejected -or $script:started) { throw 'Corrupt installer was not rejected' }
Write-Output 'Bootstrap selection, checksum and rejection checks passed.'
