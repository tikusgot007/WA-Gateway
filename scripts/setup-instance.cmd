@echo off
rem Provisioning instance Evolution + webhook (dijalankan sebagai scheduled task).
rem Log: D:\kilo\logs\setup-instance.log
cd /d D:\evolution-gateway || exit /b 1
set WEBHOOK_PUBLIC_URL=http://127.0.0.1:3000/evolution/webhook
"D:\node\node.exe" scripts\setup-instance.js >> D:\kilo\logs\setup-instance.log 2>&1
