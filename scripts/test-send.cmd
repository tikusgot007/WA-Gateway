@echo off
rem Kirim satu pesan uji lewat kontrak adapter (/send).
rem Log: D:\kilo\logs\test-send.log
cd /d D:\evolution-gateway || exit /b 1
"D:\node\node.exe" scripts\test-send.js >> D:\kilo\logs\test-send.log 2>&1
