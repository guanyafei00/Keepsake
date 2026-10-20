@echo off
rem Keepsake autotest: run on user desktop (Electron GUI cannot run in agent sandbox)
rem Output goes to tools\autotest.log so the agent can read the result directly.
cd /d "%~dp0..\app"
set FETCHIE_AUTOTEST=1
echo running Keepsake autotest, please wait 1-3 minutes (window may look frozen, that is normal)...
C:\Users\GG\.workbuddy\binaries\node\versions\22.22.2-6\node.exe node_modules\electron\cli.js . > "%~dp0autotest.log" 2>&1
echo ===== done. result saved to tools\autotest.log =====
pause
