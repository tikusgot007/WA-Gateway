@echo off
rem Adapter evolution-gateway untuk AuliaPos -- dijalankan sebagai scheduled task (SYSTEM).
rem Log: D:\kilo\logs\adapter.log
cd /d D:\evolution-gateway || exit /b 1
rem Rotasi log lama SEBELUM node memegang handle-nya (log dipegang selama proses hidup).
powershell -NoProfile -ExecutionPolicy Bypass -File D:\evolution-gateway\scripts\rotate-logs.ps1 -LogName adapter.log
"D:\node\node.exe" src\app\evolution.js >> D:\kilo\logs\adapter.log 2>&1
