@echo off
REM Removes the autostart shortcut. Leaves files & venv intact.
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
if exist "%STARTUP%\PassportEditor.lnk" (
  del "%STARTUP%\PassportEditor.lnk"
  echo Autostart removed.
) else (
  echo No autostart shortcut found.
)
pause
