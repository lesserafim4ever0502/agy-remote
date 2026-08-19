# Start Agy Remote in background with separate stdout / stderr logs
$projectRoot = Split-Path -Parent $PSScriptRoot
$outLog = Join-Path $projectRoot "agy-remote.out.log"
$errLog = Join-Path $projectRoot "agy-remote.err.log"
$pidFile = Join-Path $projectRoot "agy-remote.pid"

if (Test-Path $pidFile) {
    $existingPid = Get-Content $pidFile -Raw
    if ($existingPid -and (Get-Process -Id $existingPid.Trim() -ErrorAction SilentlyContinue)) {
        Write-Host "Agy Remote is already running with PID $existingPid"
        exit 0
    }
}

$env:AGY_BACKGROUND = "1"
$p = Start-Process -FilePath "node" -ArgumentList "apps/bridge/src/server.js" -WorkingDirectory $projectRoot -PassThru -RedirectStandardOutput $outLog -RedirectStandardError $errLog -WindowStyle Hidden
$p.Id | Set-Content -Path $pidFile -Force
Write-Host "Agy Remote started in background with PID $($p.Id)."
Write-Host "Stdout log: $outLog"
Write-Host "Stderr log: $errLog"
