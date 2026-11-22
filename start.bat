@echo off
setlocal
cd /d "%~dp0"
set "OPENJWB_SCRIPT=%~dp0server\requestHandler.py"

where python >nul 2>&1
if errorlevel 1 (
    echo Python was not found. Install Python and add it to PATH.
    pause
    exit /b 1
)

powershell.exe -NoProfile -Command "& { $ErrorActionPreference = 'Stop'; $scriptPath = $env:OPENJWB_SCRIPT; $pattern = [regex]::Escape($scriptPath) + '(?=\s|\x22|$)'; $relative = '(?:^|[\s\x22])(?:server[/\\])?requestHandler\.py(?=\s|\x22|$)'; $owners = @(Get-NetTCPConnection -LocalPort 51896 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess); Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'python.exe', 'pythonw.exe' } | ForEach-Object { if ($_.CommandLine -match $pattern -or ($owners -contains $_.ProcessId -and $_.CommandLine -match $relative)) { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } }; for ($i = 0; $i -lt 20; $i++) { if (-not (Get-NetTCPConnection -LocalPort 51896 -State Listen -ErrorAction SilentlyContinue)) { exit 0 }; Start-Sleep -Milliseconds 250 }; throw 'Port 51896 is still occupied by another process.' }"
if errorlevel 1 (
    echo Unable to stop the previous server or port 51896 is in use.
    pause
    exit /b 1
)

python -m pip install -r "%~dp0server\requirements.txt"
if errorlevel 1 (
    echo Could not install Python dependencies.
    pause
    exit /b 1
)

if not defined OPENJWB_NO_BROWSER (
    start "" /min powershell.exe -NoProfile -WindowStyle Hidden -Command "for ($i = 0; $i -lt 40; $i++) { try { $response = Invoke-WebRequest 'http://127.0.0.1:51896/' -UseBasicParsing -TimeoutSec 1; if ($response.StatusCode -eq 200) { Start-Process 'http://127.0.0.1:51896/'; break } } catch {} ; Start-Sleep -Milliseconds 250 }"
)
python -B "%OPENJWB_SCRIPT%"
if errorlevel 1 (
    echo Server exited with an error.
    pause
)
