$ErrorActionPreference = 'Continue'

$root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')
Set-Location -LiteralPath $root.Path

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "== $Message =="
}

function Test-DockerReady {
  docker info *> $null
  return $LASTEXITCODE -eq 0
}

function Start-DockerDesktop {
  $dockerDesktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
  if (Test-Path -LiteralPath $dockerDesktop) {
    Start-Process -FilePath $dockerDesktop -WindowStyle Hidden
  }
}

function Wait-DockerReady {
  param([int]$TimeoutSeconds = 120)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-DockerReady) {
      return $true
    }
    Start-Sleep -Seconds 3
  }
  return $false
}

Write-Step "Starting Docker Desktop"
if (-not (Test-DockerReady)) {
  Start-DockerDesktop
}

if (Wait-DockerReady -TimeoutSeconds 120) {
  Write-Step "Starting local SenseVoice ASR"
  npm run asr:start
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "SenseVoice ASR did not start. Text chat can still work, but voice input may fail."
  }
} else {
  Write-Warning "Docker is not ready. Text chat can still work, but voice input may fail."
}

Write-Step "Starting CodexMobile"
npm run start:bg
if ($LASTEXITCODE -ne 0) {
  Write-Warning "CodexMobile start command returned a non-zero exit code."
}

Write-Host ""
if ($env:CODEXMOBILE_PUBLIC_URL) {
  Write-Host "CodexMobile URL: $env:CODEXMOBILE_PUBLIC_URL"
} else {
  Write-Host "CodexMobile URL: https://<your-device>.<your-tailnet>.ts.net:3443/"
}
Start-Sleep -Seconds 3
