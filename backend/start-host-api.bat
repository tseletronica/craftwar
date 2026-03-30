@echo off
setlocal

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8081"

set "BACKEND_DIR=%~dp0"
for %%I in ("%BACKEND_DIR%..") do set "ROOT_DIR=%%~fI"
set "LOG_DIR=%ROOT_DIR%\runtime\logs"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%BACKEND_DIR%start-host-api.ps1" -Port %PORT% 1>>"%LOG_DIR%\host-api-%PORT%.stdout.log" 2>>"%LOG_DIR%\host-api-%PORT%.stderr.log"
