@echo off
rem Evolution API untuk AuliaPos -- dijalankan sebagai scheduled task (SYSTEM).
rem Log: D:\kilo\logs\evolution.log
cd /d D:\evolution-api-server || exit /b 1
"D:\node\node.exe" node_modules\tsx\dist\cli.mjs src\main.ts >> D:\kilo\logs\evolution.log 2>&1
