@echo off
rem Uji akses internet outbound dari aulia3.
rem Log: D:\kilo\logs\check-internet.log
cd /d D:\evolution-gateway || exit /b 1
"D:\node\node.exe" scripts\check-internet.js >> D:\kilo\logs\check-internet.log 2>&1
