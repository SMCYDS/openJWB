@echo off
setlocal enabledelayedexpansion
title openJWB Dashboard

set "ROOT_DIR=%~dp0"
set "SERVER_DIR=%ROOT_DIR%server"

echo [openJWB] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo [openJWB] Node.js not found.
    where winget >nul 2>&1
    if errorlevel 1 (
        echo [openJWB] winget is not available, cannot auto-install.
        echo [openJWB] Please install Node.js LTS from https://nodejs.org then run this script again.
        pause
        exit /b 1
    )
    echo [openJWB] Installing Node.js LTS via winget, please wait...
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    if errorlevel 1 (
        echo [openJWB] Auto-install failed. Please install Node.js manually from https://nodejs.org
        pause
        exit /b 1
    )
    echo [openJWB] Node.js installed. Please close this window and double-click start.bat again.
    pause
    exit /b 0
)

for /f "tokens=*" %%v in ('node -v') do echo [openJWB] Found Node.js %%v

cd /d "%SERVER_DIR%"

if not exist "node_modules" (
    echo [openJWB] First run, installing dependencies ^(needs internet^)...
    call npm install
    if errorlevel 1 (
        echo [openJWB] npm install failed. Check your network connection and try again.
        pause
        exit /b 1
    )
)

if not exist ".env" (
    echo [openJWB] Creating default .env from .env.example...
    copy /y ".env.example" ".env" >nul
)

set "PORT=18960"
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    if /i "%%a"=="PORT" set "PORT=%%b"
)

echo [openJWB] Starting server on port %PORT%...
start "" http://localhost:%PORT%
node server.js

if errorlevel 1 (
    echo [openJWB] Server exited with an error.
    pause
)
