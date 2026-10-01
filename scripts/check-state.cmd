@echo off
rem Laporkan state koneksi instance Evolution saat ini.
rem Log: D:\kilo\logs\check-state.log
cd /d D:\evolution-gateway || exit /b 1
"D:\node\node.exe" scripts\check-state.js >> D:\kilo\logs\check-state.log 2>&1
