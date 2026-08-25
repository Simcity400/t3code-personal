@echo off
rem Local replacement for the billing-blocked fork-sync.yml workflow: registers a
rem Windows Task Scheduler job that runs scripts\local-fork-sync.ts every 2 hours.
rem
rem   register-local-fork-sync.cmd         registers (or refreshes) the task
rem   register-local-fork-sync.cmd --run   what the scheduled task itself executes
rem
rem The task runs as the logged-on user with an interactive token (/it), so no
rem password is stored anywhere and git/gh keep the credentials they already use.
rem It therefore only fires while that user is logged on, which is exactly when
rem the publisher could run anyway.
setlocal
if /i "%~1"=="--run" goto :run

set "TASK_NAME=T3 Personal Fork Sync"
set "SELF=%~f0"
for %%I in ("%~dp0..") do set "REPO=%%~fI"

if not exist "%REPO%\scripts\local-fork-sync.ts" (
  echo Could not find "%REPO%\scripts\local-fork-sync.ts".
  goto :fail
)
rem The trailing backslash makes this a directory test, so a stray FILE named
rem .logs is caught here instead of breaking every scheduled run's redirection.
if not exist "%REPO%\.logs\" mkdir "%REPO%\.logs"
if not exist "%REPO%\.logs\" (
  echo Could not create the directory "%REPO%\.logs"; the task would have nowhere to log.
  goto :fail
)

rem Absolute interpreter path: the scheduler's PATH is not this shell's.
set "SHELL_EXE=%SystemRoot%\System32\cmd.exe"
if not exist "%SHELL_EXE%" (
  echo Could not find "%SHELL_EXE%".
  goto :fail
)

rem /f makes this idempotent: re-running replaces the existing definition.
schtasks /create /f /tn "%TASK_NAME%" /sc HOURLY /mo 2 /ru "%USERDOMAIN%\%USERNAME%" /it /rl LIMITED /tr "\"%SHELL_EXE%\" /c \"%SELF%\" --run"
if errorlevel 1 goto :fail

echo.
echo Registered the scheduled task "%TASK_NAME%" (every 2 hours, only while %USERNAME% is logged on).
echo   Runs:    "%SELF%" --run
echo   Which:   node "%REPO%\scripts\local-fork-sync.ts" --task
echo   Log:     "%REPO%\.logs\local-fork-sync.log"  (gitignored, keeps the last 20 runs)
echo.
echo Run it once by hand:   schtasks /run /tn "%TASK_NAME%"
echo Inspect it:            schtasks /query /tn "%TASK_NAME%" /v /fo list
echo Remove it:             schtasks /delete /tn "%TASK_NAME%" /f
echo.
pause
exit /b 0

:fail
echo.
echo Registration did not finish. See the message above.
pause
exit /b 1

:run
for %%I in ("%~dp0..") do set "REPO=%%~fI"
if not exist "%REPO%\.logs\" mkdir "%REPO%\.logs"
if not exist "%REPO%\.logs\" exit /b 1
set "LOG=%REPO%\.logs\local-fork-sync.log"
rem Resolve node to an absolute path so a thin scheduler PATH is a loud failure
rem here rather than a silent one inside the task.
set "NODE_EXE="
for /f "usebackq delims=" %%N in (`where node.exe 2^>nul`) do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE (
  >>"%LOG%" echo [register-local-fork-sync] node.exe was not found; the fork sync did not run.
  exit /b 1
)
"%NODE_EXE%" "%REPO%\scripts\local-fork-sync.ts" --task >>"%LOG%" 2>&1
exit /b %errorlevel%
