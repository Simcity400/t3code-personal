@echo off
rem One-time setup on a new computer. Run this after cloning the private repo:
rem   git clone https://github.com/Simcity400/t3code-personal.git "T3 Code Personal"
rem   (then add the official remote below, which this script does for you)
rem Requires Git, Node.js, and pnpm to be installed and on PATH.
setlocal
cd /d "%~dp0"

echo ============================================================
echo  Setting up your personal T3 Code on this computer...
echo ============================================================
echo.

where git >nul 2>&1 || (echo Git is not installed or not on PATH. & goto :fail)
where node >nul 2>&1 || (echo Node.js is not installed or not on PATH. & goto :fail)
where pnpm >nul 2>&1 || (echo pnpm is not installed or not on PATH. Run: npm i -g pnpm & goto :fail)

echo Ensuring the official repo is configured as "upstream"...
git remote get-url upstream >nul 2>&1 || git remote add upstream https://github.com/pingdotgg/t3code.git
git fetch upstream
if errorlevel 1 goto :fail

echo.
echo Writing .env with the public T3 Connect build config (if missing)...
if not exist .env (
  > .env echo # T3 Connect public build config (see MY-FORK.md^)
  >> .env echo T3CODE_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsudDMuY29kZXMk
  >> .env echo T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=hzxSgY2cH10sDU2r
  >> .env echo T3CODE_CLERK_JWT_TEMPLATE=t3-relay
  >> .env echo T3CODE_RELAY_URL=https://relay.t3.codes
)

echo Copying the resource-monitor sidecar from the installed app (if present)...
if not exist "apps\desktop\resources\resource-monitor\t3-resource-monitor.exe" (
  if exist "%LOCALAPPDATA%\Programs\t3code\resources\resource-monitor\t3-resource-monitor.exe" (
    mkdir "apps\desktop\resources\resource-monitor" 2>nul
    copy /y "%LOCALAPPDATA%\Programs\t3code\resources\resource-monitor\t3-resource-monitor.exe" "apps\desktop\resources\resource-monitor\" >nul
  ) else (
    echo   Installed T3 Code not found - resource diagnostics will be unavailable.
  )
)

echo.
echo Installing dependencies...
call pnpm install
if errorlevel 1 goto :fail

echo.
echo Matching the official nightly version...
set "NIGHTLY="
for /f "usebackq delims=" %%v in (`node -e "fetch('https://registry.npmjs.org/-/package/t3/dist-tags').then(function(r){return r.json()}).then(function(d){console.log(d.nightly)})"`) do set "NIGHTLY=%%v"
if not defined NIGHTLY goto :afterstamp
node scripts/update-release-package-versions.ts %NIGHTLY%
git commit -am "chore(fork): pin nightly %NIGHTLY%" >nul 2>&1
:afterstamp

echo.
echo Building the app (this takes a few minutes the first time)...
call pnpm build:desktop
if errorlevel 1 goto :fail

echo.
echo Creating a desktop shortcut...
powershell -NoProfile -Command "$sh = New-Object -ComObject WScript.Shell; $desk = [Environment]::GetFolderPath('Desktop'); $lnk = $sh.CreateShortcut((Join-Path $desk 'T3 Code (Nightly).lnk')); $lnk.TargetPath = \"$env:WINDIR\System32\wscript.exe\"; $lnk.Arguments = '\"' + (Join-Path (Get-Location) 'Launch T3 Code (My Version).vbs') + '\"'; $lnk.WorkingDirectory = (Get-Location).Path; $lnk.IconLocation = (Join-Path (Get-Location) 'assets\nightly\nightly-windows.ico') + ',0'; $lnk.Description = 'T3 Code (personal fork build)'; $lnk.Save()"

echo.
echo ============================================================
echo  Setup complete! Start the app from the new desktop shortcut
echo  or "Launch T3 Code (My Version).vbs".
echo.
echo  Note: don't run this build and the official installed
echo  T3 Code at the same time on one machine.
echo ============================================================
pause
exit /b 0

:fail
echo.
echo Something went wrong - see the messages above.
echo You can ask Claude Code in this folder to "fix the failed T3 Code setup".
pause
exit /b 1
