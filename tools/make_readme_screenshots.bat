@echo off
rem Make README screenshots: runs Keepsake in capture mode (auto switches pages, saves 3 PNG, exits)
rem ASCII only - cmd.exe decodes this file as GBK
set KEEPSAKE_CAPTURE=1
"%~dp0..\app\node_modules\electron\dist\electron.exe" "%~dp0..\app"
echo.
echo Done. Check: %~dp0..\screenshots
pause
