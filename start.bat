@echo off
REM Starts server in background and opens browser. Run by Startup shortcut at login.
setlocal ENABLEDELAYEDEXPANSION
cd /d "%~dp0"

if not exist venv (
  echo venv missing. Run install.bat first.
  pause
  exit /b 1
)

set "PORT=5005"
set "URL=http://127.0.0.1:%PORT%"

REM If health check passes, server already running -> just open browser
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 '%URL%/api/health')|Out-Null;exit 0}catch{exit 1}" >nul 2>&1
if %errorlevel%==0 (
  echo server already up
) else (
  echo starting server on %URL%
  start "" /B venv\Scripts\pythonw.exe server.py
  REM wait up to ~20s for healthy
  for /L %%i in (1,1,40) do (
    powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 '%URL%/api/health')|Out-Null;exit 0}catch{exit 1}" >nul 2>&1
    if !errorlevel!==0 goto :ready
    timeout /t 1 /nobreak >nul
  )
)
:ready
start "" "%URL%"
endlocal
