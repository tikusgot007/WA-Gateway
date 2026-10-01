@echo off
rem Adapter evolution-gateway untuk AuliaPos -- dijalankan sebagai scheduled task (SYSTEM).
rem Log: D:\kilo\logs\adapter.log
cd /d D:\evolution-gateway || exit /b 1
"D:\node\node.exe" src\app\evolution.js >> D:\kilo\logs\adapter.log 2>&1
