param(
  [int]$Port = 8081
)

$ErrorActionPreference = "Stop"

$backendDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $backendDir
$envFile = Join-Path $rootDir ".env"
$entrypoint = Join-Path $backendDir "dist\\index.js"
$logDir = Join-Path $rootDir "runtime\\logs"
$launchLog = Join-Path $logDir "host-api-launch.log"
$nodeExe = "C:\\Program Files\\nodejs\\node.exe"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Add-Content -Path $launchLog -Value ("[{0}] bootstrap pid={1} port={2}" -f (Get-Date -Format s), $PID, $Port)

if (-not (Test-Path $envFile)) {
  throw "Arquivo .env nao encontrado em $rootDir"
}

if (-not (Test-Path $entrypoint)) {
  throw "Backend compilado nao encontrado em $entrypoint"
}

if (-not (Test-Path $nodeExe)) {
  $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
}

Get-Content $envFile | ForEach-Object {
  $line = $_.Trim()

  if (-not $line) {
    return
  }

  if ($line.StartsWith("#")) {
    return
  }

  if ($line.IndexOf("=") -lt 1) {
    return
  }

  $name, $value = $_ -split "=", 2
  Set-Item -Path ("Env:" + $name) -Value $value
}

$env:API_PORT = [string]$Port
Add-Content -Path $launchLog -Value ("[{0}] env loaded entrypoint={1} node={2}" -f (Get-Date -Format s), $entrypoint, $nodeExe)

Set-Location $backendDir

try {
  & $nodeExe $entrypoint
  $exitCode = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } else { 0 }
  Add-Content -Path $launchLog -Value ("[{0}] node exited code={1}" -f (Get-Date -Format s), $exitCode)
  exit $exitCode
} catch {
  Add-Content -Path $launchLog -Value ("[{0}] launcher error={1}" -f (Get-Date -Format s), $_.Exception.Message)
  throw
}
