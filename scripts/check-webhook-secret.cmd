@echo off
rem Bandingkan secret webhook adapter vs pendaftaran di Evolution (tanpa
rem mencetak nilainya).
rem Log: D:\kilo\logs\check-webhook-secret.log
cd /d D:\evolution-gateway || exit /b 1
"D:\node\node.exe" scripts\check-webhook-secret.js >> D:\kilo\logs\check-webhook-secret.log 2>&1
