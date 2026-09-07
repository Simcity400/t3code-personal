@echo off
rem Installs the latest packaged personal T3 Code release. It does not build or
rem launch a second source version.
setlocal

set "INSTALLER_ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "INSTALLER_ARCH=arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "INSTALLER_ARCH=arm64"

where gh >nul 2>&1 || (echo GitHub CLI is required. Install it, then run: gh auth login & goto :fail)
gh auth status --hostname github.com >nul 2>&1 || (echo Sign in first by running: gh auth login & goto :fail)

set "DOWNLOAD_DIR=%TEMP%\t3code-personal-install-%RANDOM%%RANDOM%"
mkdir "%DOWNLOAD_DIR%"

echo Downloading your latest personal T3 Code installer...
set "RELEASE_TAG="
for /f "usebackq delims=" %%T in (`gh release list --repo Simcity400/t3code-personal --limit 100 --json tagName^,isDraft^,isPrerelease^,createdAt --jq "map(select(.isDraft == false and .isPrerelease == true)) | max_by(.createdAt).tagName // empty"`) do set "RELEASE_TAG=%%T"
if not defined RELEASE_TAG (
  echo No packaged personal T3 Code prerelease is available yet.
  goto :fail
)
gh release download "%RELEASE_TAG%" --repo Simcity400/t3code-personal --pattern "*-%INSTALLER_ARCH%.exe" --dir "%DOWNLOAD_DIR%" --clobber
if errorlevel 1 goto :fail

set "INSTALLER="
for %%F in ("%DOWNLOAD_DIR%\*.exe") do set "INSTALLER=%%~fF"
if not defined INSTALLER (
  echo The latest release does not contain a Windows installer yet.
  goto :fail
)

echo Installing the one personal T3 Code app...
start /wait "" "%INSTALLER%" /S
if errorlevel 1 goto :fail

echo Installed. Use the Start Menu shortcut named T3 Code (Nightly).
pause
exit /b 0

:fail
echo.
echo Setup did not finish. See the message above.
pause
exit /b 1
