# Exercises setup decisions without installing software or downloading a model.
$ErrorActionPreference = 'Stop'
$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri\windows\transcription-setup.ps1'
. $source

function Assert($value, $message) { if (-not $value) { throw $message }; Write-Output "ok: $message" }

# The real downloader must reject corrupt data before it can be executed.
function Invoke-WebRequest { param($Uri, $OutFile, [switch]$UseBasicParsing); Set-Content -LiteralPath $OutFile -Value 'corrupt' }
$badFile = Join-Path $env:TEMP 'whatrust-transcription-hash-test.tmp'
$rejected = $false
try { Get-VerifiedInstaller 'https://invalid.example/test.exe' ('0' * 64) $badFile } catch { $rejected = $_.Exception.Message -like '*checksum*' }
Assert $rejected 'a corrupt download is rejected'

$script:genieExists = $false
$script:modelExists = $false
$script:fluidExists = $false
$script:registered = $false
$script:downloads = @()
$script:starts = @()
$script:pulls = 0
$script:exitCode = 0
function Find-GenieX { if ($script:genieExists) { return 'mock-geniex.exe' }; return $null }
function Find-InstalledProgram($name) { return $script:registered }
function Get-VerifiedInstaller($url, $sha256, $destination) {
  $script:downloads += [pscustomobject]@{ Url = $url; Hash = $sha256 }
}
function Start-Process {
  param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru)
  $script:starts += [pscustomobject]@{ File = $FilePath; Args = @($ArgumentList) }
  if ($script:exitCode -eq 0) { $script:genieExists = $true; $script:fluidExists = $true }
  return [pscustomobject]@{ ExitCode = $script:exitCode }
}
function Has-Q8Model($exe) { return $script:modelExists }
function Install-Q8Model($exe) { $script:pulls++; $script:modelExists = $true }
function Test-Path {
  param($LiteralPath, $PathType)
  if ($LiteralPath -like '*FluidVoice\fluidvoice.exe') { return $script:fluidExists }
  return Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath -PathType $PathType
}

Install-Transcription arm64
Assert ($script:downloads.Count -eq 1 -and $script:downloads[0].Url -match 'qualcomm/GenieX/.+v0\.11\.0' -and $script:downloads[0].Hash -eq '8470b8a1d51ae3a41040c831c76ec7e9e5fed72c51b49ef8a0f1bf2580cfb57f') 'fresh ARM64 setup downloads the pinned GenieX installer'
Assert ($script:starts.Count -eq 1 -and $script:starts[0].Args -contains '/VERYSILENT' -and $script:pulls -eq 1) 'fresh ARM64 setup installs GenieX and downloads Q8'
Install-Transcription arm64
Assert ($script:downloads.Count -eq 1 -and $script:starts.Count -eq 1 -and $script:pulls -eq 1) 'existing GenieX and Q8 are not replaced or downloaded again'
$script:modelExists = $false
Install-Transcription arm64
Assert ($script:downloads.Count -eq 1 -and $script:starts.Count -eq 1 -and $script:pulls -eq 2) 'existing GenieX receives only the missing Q8 model'

$script:genieExists = $false; $script:registered = $true
$rejected = $false
try { Install-Transcription arm64 } catch { $rejected = $_.Exception.Message -like '*registered*' }
Assert ($rejected -and $script:starts.Count -eq 1) 'a registered GenieX installation is not overwritten when its executable cannot be found'

$script:registered = $false; $script:fluidExists = $false
$script:downloads = @(); $script:starts = @()
Install-Transcription x64
Assert ($script:downloads.Count -eq 1 -and $script:downloads[0].Url -match 'altic-dev/FluidVoice/.+windows-v0\.0\.13' -and $script:downloads[0].Hash -eq 'c6c9253c689bf6e6376ad133e1a09251ce146a1060b601ded46d2837efad391f') 'fresh x64 setup downloads the pinned FluidVoice installer'
Assert ($script:starts.Count -eq 1 -and $script:starts[0].Args -contains '/S') 'fresh x64 setup launches the FluidVoice installer'
Install-Transcription x64
Assert ($script:starts.Count -eq 1) 'existing FluidVoice is not reinstalled'

$script:genieExists = $false; $script:fluidExists = $false; $script:exitCode = 23
$rejected = $false
try { Install-Transcription x64 } catch { $rejected = $_.Exception.Message -like '*code 23*' }
Assert $rejected 'an installer failure is reported'
Write-Output 'Transcription setup tests passed.'
