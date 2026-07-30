@echo off
rem One-click update: pulls the latest official T3 Code release, merges it with
rem your personal edits, rebuilds the app, and backs everything up to your
rem private GitHub repo.
setlocal
cd /d "%~dp0"

echo ============================================================
echo  Updating your T3 Code from the official repository...
echo ============================================================
echo.

git fetch upstream
if errorlevel 1 goto :fail

git merge upstream/main --no-edit
if errorlevel 1 goto :conflict

echo.
echo Matching the official nightly version...
set "NIGHTLY="
for /f "usebackq delims=" %%v in (`node -e "fetch('https://registry.npmjs.org/-/package/t3/dist-tags').then(function(r){return r.json()}).then(function(d){console.log(d.nightly)})"`) do set "NIGHTLY=%%v"
if not defined NIGHTLY goto :afterstamp
node scripts/update-release-package-versions.ts %NIGHTLY%
git commit -am "chore(fork): pin nightly %NIGHTLY%" >nul 2>&1
:afterstamp

echo.
echo Installing dependencies...
call pnpm install
if errorlevel 1 goto :fail

echo.
echo Rebuilding the app...
call pnpm build:desktop
if errorlevel 1 goto :fail

git push origin main

echo.
echo ============================================================
echo  Update complete! Start the app with:
echo  "Launch T3 Code (My Version).cmd"
echo ============================================================
pause
exit /b 0

:conflict
echo.
echo ============================================================
echo  The official update changed the same code as one of your
echo  personal edits, so the merge needs a human (or AI) touch.
echo.
echo  Open Claude Code in this folder and say:
echo    "finish the upstream merge"
echo  and it will resolve the conflict for you.
echo ============================================================
pause
exit /b 1

:fail
echo.
echo Something went wrong - see the messages above.
echo You can ask Claude Code to "fix the failed T3 Code update".
pause
exit /b 1
