# Stop background Agy Remote
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot "agy-remote.pid"

if (Test-Path $pidFile) {
    $targetPid = Get-Content $pidFile -Raw
    if ($targetPid) {
        $proc = Get-Process -Id $targetPid.Trim() -ErrorAction SilentlyContinue
        if ($proc) {
            Stop-Process -Id $proc.Id -Force
            Write-Host "Stopped Agy Remote (PID $($proc.Id))."
        } else {
            Write-Host "No running process with PID $targetPid."
        }
    }
    Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
} else {
    Write-Host "No running Agy Remote pid file found."
}
