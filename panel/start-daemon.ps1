$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config.json'
$node = ''

try {
  $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($config -and $config.nodeExe) { $node = [string]$config.nodeExe }
} catch {}

if (-not $node -or -not (Test-Path -LiteralPath $node)) {
  $candidates = @(
    (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'),
    'D:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { $node = $candidate; break }
  }
}

if (-not $node -or -not (Test-Path -LiteralPath $node)) {
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
}

if (-not $node -or -not (Test-Path -LiteralPath $node)) { exit 1 }

$cli = Join-Path $root 'guardian.mjs'
if (-not (Test-Path -LiteralPath $cli)) { exit 1 }
Start-Process -FilePath $node -ArgumentList @($cli, 'start') -WorkingDirectory $root -WindowStyle Hidden
