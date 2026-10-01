@echo off
rem Laporkan isi buffer masuk (metadata saja, tanpa isi pesan).
rem Log: D:\kilo\logs\inspect-queue.log
cd /d D:\evolution-gateway || exit /b 1
"D:\node\node.exe" scripts\inspect-queue.js >> D:\kilo\logs\inspect-queue.log 2>&1
