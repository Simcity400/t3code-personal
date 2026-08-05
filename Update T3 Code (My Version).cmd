@echo off
rem One-click update: downloads the latest ready-made version from your private
rem GitHub repo and rebuilds the app. GitHub is the single source of truth --
rem a scheduled workflow there (fork-sync.yml) merges the official changes and
rem stamps versions, so this script never merges anything itself. If this
rem machine somehow has stray local changes, they are backed up to GitHub
rem first, then the machine is made to match GitHub exactly.
setlocal
cd /d "%~dp0"

echo ============================================================
echo  Updating your T3 Code from your GitHub...
echo ============================================================
echo.

git fetch origin --prune
if errorlevel 1 goto :offline

set "DIVERGED="
set "AHEAD=0"
for /f "usebackq delims=" %%c in (`git rev-list --count origin/main..HEAD`) do set "AHEAD=%%c"
if not "%AHEAD%"=="0" set "DIVERGED=1"
git diff --quiet || set "DIVERGED=1"
git diff --cached --quiet || set "DIVERGED=1"

if defined DIVERGED (
  echo Backing up this machine's local changes to GitHub first...
  set "BACKUP=backup/manual-%RANDOM%%RANDOM%"
  git add -A
  git commit -m "backup: local changes before matching GitHub" >nul 2>&1
  git branch --force "%BACKUP%"
  git push origin "HEAD:refs/heads/%BACKUP%" >nul 2>&1
  git reset --hard origin/main
  if errorlevel 1 goto :fail
) else (
  git merge --ff-only origin/main
  if errorlevel 1 goto :fail
)

echo.
echo Installing dependencies...
call pnpm install
if errorlevel 1 goto :fail

echo.
echo Rebuilding the app...
call pnpm build:desktop
if errorlevel 1 goto :fail

echo.
echo ============================================================
echo  Update complete! Start the app with:
echo  "Launch T3 Code (My Version).cmd"
echo ============================================================
pause
exit /b 0

:offline
echo.
echo Couldn't reach GitHub - check the internet connection and try again.
pause
exit /b 1

:fail
echo.
echo Something went wrong - see the messages above.
echo You can ask Claude Code to "fix the failed T3 Code update".
pause
exit /b 1
