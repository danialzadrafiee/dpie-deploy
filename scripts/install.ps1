# Install the `deploy` CLI from the latest GitHub release (Windows).
#   irm https://raw.githubusercontent.com/danialzadrafiee/dpie-deploy/main/scripts/install.ps1 | iex
$ErrorActionPreference = "Stop"

$Repo = if ($env:DPIE_REPO) { $env:DPIE_REPO } else { "danialzadrafiee/dpie-deploy" }
$Version = if ($env:DPIE_VERSION) { $env:DPIE_VERSION } else { "latest" }
$Url = if ($Version -eq "latest") {
  "https://github.com/$Repo/releases/latest/download/deploy-windows-x64.exe"
} else {
  "https://github.com/$Repo/releases/download/$Version/deploy-windows-x64.exe"
}

$Dir = Join-Path $env:LOCALAPPDATA "dpie-deploy"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$Exe = Join-Path $Dir "deploy.exe"

Write-Host "Downloading $Url"
Invoke-WebRequest -Uri $Url -OutFile $Exe -UseBasicParsing

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not ($UserPath -split ";" | Where-Object { $_ -eq $Dir })) {
  [Environment]::SetEnvironmentVariable("Path", "$UserPath;$Dir", "User")
  Write-Host "Added $Dir to your PATH. Open a new terminal."
}
Write-Host "Installed: $Exe ($(& $Exe --version))"
