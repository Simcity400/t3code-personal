@echo off
rem Compatibility launcher for the one installed personal T3 Code app.
setlocal
set "APP=%LOCALAPPDATA%\Programs\t3code\T3 Code (Nightly).exe"
if not exist "%APP%" (
  echo Your personal T3 Code app is not installed. Run "Setup T3 Code (My Version).cmd".
  pause
  exit /b 1
)
start "" "%APP%"
