@echo off
rem Publishes the personal desktop and iPhone updates without GitHub Actions.
setlocal
node "%~dp0scripts\publish-personal-update.ts" %*
if errorlevel 1 goto :fail

echo.
echo Personal T3 Code updates published successfully.
pause
exit /b 0

:fail
echo.
echo Publishing did not finish. See the message above.
pause
exit /b 1
