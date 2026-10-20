@echo off
rem DGO publish script - run AFTER creating repo github.com/guanyafei00/Keepsake on the web
rem Steps you do in browser first: open https://github.com/new
rem   Repository name: Keepsake   Visibility: Public   Do NOT check "Add a README"
rem ASCII only - cmd.exe decodes this file as GBK

cd /d "%~dp0.."

git remote add origin https://github.com/guanyafei00/Keepsake.git 2>nul
git remote set-url origin https://github.com/guanyafei00/Keepsake.git

echo === Step 1/3: pushing main branch (browser auth window may pop up, allow it) ===
git push -u origin main
if errorlevel 1 goto :fail

echo === Step 2/3: creating tag v0.1.0-beta ===
git tag -f v0.1.0-beta

echo === Step 3/3: pushing tag (this triggers the CI release build) ===
git push origin v0.1.0-beta
if errorlevel 1 goto :fail

echo.
echo DONE. Check CI:  https://github.com/guanyafei00/Keepsake/actions
echo Then: Releases - draft v0.1.0-beta - upload gallery-dl.exe as asset - publish
echo   (get gallery-dl.exe from: https://codeberg.org/mikf/gallery-dl/releases/latest)
goto :eof

:fail
echo.
echo PUSH FAILED - most likely the repo does not exist yet.
echo Open https://github.com/new  (name: Keepsake, Public, no README), then run this again.
pause
