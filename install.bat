@echo off
REM Idiot-proof installer for Windows.
REM   - Finds Python (3.9+)
REM   - Builds venv, installs deps, pre-fetches ML model
REM   - Adds shortcut to Startup folder so server runs every login

setlocal ENABLEDELAYEDEXPANSION
cd /d "%~dp0"

echo =============================================
echo  Passport Photo Editor - Windows installer
echo  dir: %CD%
echo =============================================

REM 1. Find Python via py launcher first, then python.exe
set "PY="
for %%V in (3.12 3.11 3.10 3.9) do (
  if not defined PY (
    py -%%V -V >nul 2>&1 && set "PY=py -%%V"
  )
)
if not defined PY (
  python --version >nul 2>&1 && set "PY=python"
)

if not defined PY (
  echo.
  echo ERROR: Python 3.9 or newer is not installed.
  echo Install it from: https://www.python.org/downloads/
  echo During install CHECK the box "Add Python to PATH".
  echo Then double-click install.bat again.
  pause
  exit /b 1
)
echo Using: %PY%
%PY% -c "import sys;print('Python',sys.version)"

REM 2. Create venv (recreate if mismatched)
if not exist venv (
  echo Creating virtualenv...
  %PY% -m venv venv || ( echo Failed to create venv & pause & exit /b 1 )
)
call venv\Scripts\activate.bat

REM 3. Install deps
echo Upgrading pip...
python -m pip install --upgrade pip wheel >nul
echo Installing packages (a few minutes; ~500MB)...
pip install -r requirements.txt || ( echo Pip install failed & pause & exit /b 1 )

REM 4. Pre-fetch rembg model
echo Pre-fetching background-removal model (~170MB, one time)...
python -c "from rembg import new_session; new_session('u2net'); print('rembg ready')" || ( echo Model fetch failed & pause & exit /b 1 )

REM 5. Verify imports
python -c "import flask,PIL,numpy,cv2,rembg,onnxruntime;print('imports OK')" || ( echo Import check failed & pause & exit /b 1 )

REM 6. Autostart: place shortcut in Startup folder
echo Installing autostart shortcut...
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%STARTUP%\PassportEditor.lnk');" ^
  "$s.TargetPath='%CD%\start.bat';" ^
  "$s.WorkingDirectory='%CD%';" ^
  "$s.WindowStyle=7;" ^
  "$s.Save()"

echo.
echo =============================================
echo  DONE. Launching now...
echo =============================================
call start.bat
endlocal
