param([ValidateSet('arm64', 'x64')][string]$Architecture = 'arm64')

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$model = 'ggml-org/Qwen3-ASR-0.6B-GGUF:Q8_0'
$modelRepo = 'ggml-org/Qwen3-ASR-0.6B-GGUF'

function Find-GenieX {
  $paths = @(
    (Join-Path $env:LOCALAPPDATA 'GenieX CLI\geniex.exe'),
    (Join-Path $env:ProgramFiles 'GenieX CLI\geniex.exe')
  )
  $found = Get-Command geniex.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $paths += $found.Source }
  foreach ($path in $paths) { if (Test-Path -LiteralPath $path -PathType Leaf) { return $path } }
  return $null
}

function Find-InstalledProgram($name) {
  $keys = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')
  return @(Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq $name }).Count -gt 0
}

function Get-VerifiedInstaller($url, $sha256, $destination) {
  Write-Output "Downloading $([IO.Path]::GetFileName($destination))..."
  Invoke-WebRequest -Uri $url -OutFile $destination -UseBasicParsing
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash
  if ($actual -ne $sha256) { throw 'The transcription installer checksum did not match; it was not run.' }
}

function Has-Q8Model($exe) {
  $json = & $exe --skip-update list --format json | Out-String
  if ($LASTEXITCODE -ne 0) { throw 'The installed GenieX CLI did not list its models. Update GenieX manually and retry in whatRust settings.' }
  # Wrapping the JSON preserves an empty or single-element array in both
  # Windows PowerShell 5.1 and PowerShell 7.
  try { $models = (ConvertFrom-Json -InputObject ('{"models":' + $json + '}')).models } catch { throw 'The installed GenieX CLI returned an incompatible model list. Update it manually.' }
  if ($models -isnot [array]) { throw 'The installed GenieX CLI returned an incompatible model list. Update it manually.' }
  foreach ($entry in $models) {
    if ($entry.name -eq $modelRepo -and @($entry.precisions) -contains 'Q8_0') { return $true }
  }
  return $false
}

function Install-Q8Model($exe) {
  & $exe --skip-update pull $model --model-type vlm
  if ($LASTEXITCODE -ne 0 -or -not (Has-Q8Model $exe)) { throw 'Qwen3-ASR Q8 download failed. Retry in whatRust Settings > Transcription.' }
}

function Install-Transcription([string]$Architecture) {
  if ($Architecture -eq 'arm64') {
    $exe = Find-GenieX
    if (-not $exe) {
      if (Find-InstalledProgram 'GenieX CLI') { throw 'GenieX is registered but its executable was not found. Check its installation and retry in whatRust settings.' }
      $setup = Join-Path $env:TEMP 'whatrust-geniex-v0.12.0-setup.exe'
      Get-VerifiedInstaller 'https://github.com/qualcomm/GenieX/releases/download/v0.12.0/geniex-cli-setup-windows-arm64-v0.12.0.exe' '1d9de0144c42456cb89f7306e3f4885d5a5898def6c5dacd0f49cc91d07c10ce' $setup
      Write-Output 'Installing GenieX CLI...'
      $process = Start-Process -FilePath $setup -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-' -Wait -PassThru
      if ($process.ExitCode -ne 0) { throw "GenieX setup exited with code $($process.ExitCode)." }
      $exe = Find-GenieX
      if (-not $exe) { throw 'GenieX setup completed but its executable was not found.' }
    } else { Write-Output 'Using the existing GenieX CLI.' }
    if (Has-Q8Model $exe) { Write-Output 'Qwen3-ASR Q8 is already installed.' }
    else {
      Write-Output 'Downloading Qwen3-ASR Q8 (about 1.1 GiB); this may take several minutes...'
      Install-Q8Model $exe
    }
    Write-Output 'GenieX and the Q8 model are ready. A supported Snapdragon NPU is required.'
  } else {
    $fluid = Join-Path $env:LOCALAPPDATA 'FluidVoice\fluidvoice.exe'
    if ((Test-Path -LiteralPath $fluid -PathType Leaf) -or (Find-InstalledProgram 'FluidVoice')) {
      Write-Output 'Using the existing FluidVoice installation.'
    } else {
      $setup = Join-Path $env:TEMP 'whatrust-fluidvoice-0.0.13-setup.exe'
      Get-VerifiedInstaller 'https://github.com/altic-dev/FluidVoice/releases/download/windows-v0.0.13/FluidVoice_0.0.13_x64-setup.exe' 'c6c9253c689bf6e6376ad133e1a09251ce146a1060b601ded46d2837efad391f' $setup
      Write-Output 'Installing FluidVoice for Windows...'
      $process = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru
      if ($process.ExitCode -ne 0) { throw "FluidVoice setup exited with code $($process.ExitCode)." }
      if (-not (Test-Path -LiteralPath $fluid -PathType Leaf) -and -not (Find-InstalledProgram 'FluidVoice')) { throw 'FluidVoice setup completed but the app was not found.' }
    }
    Write-Output 'Open FluidVoice, complete its model setup, and enable its local API before using transcription in whatRust.'
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  try {
    Install-Transcription $Architecture
    exit 0
  } catch {
    Write-Output "Transcription setup failed: $($_.Exception.Message)"
    exit 1
  }
}
