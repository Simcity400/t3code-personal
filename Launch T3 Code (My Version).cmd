@echo off
rem Launches your personal build of T3 Code.
rem If it fails to start, run "Update T3 Code (My Version).cmd" first to rebuild.
cd /d "%~dp0"
call pnpm start:desktop
if errorlevel 1 (
  echo.
  echo T3 Code failed to start. Run "Update T3 Code (My Version).cmd" to rebuild, then try again.
  pause
)
