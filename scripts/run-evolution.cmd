@echo off
rem Evolution API untuk AuliaPos -- dijalankan sebagai scheduled task (SYSTEM).
rem Log: D:\kilo\logs\evolution.log
rem
rem Tunggu PostgreSQL siap lebih dulu (maks ~60 detik): Evolution butuh DB
rem sejak awal boot. Tanpa ini, percobaan pertama saat boot gagal karena PG
rem belum menerima koneksi, dan stack baru pulih setelah restart/watchdog
rem (~4 menit pada uji reboot 2026-10-01).
setlocal
set /a tries=0
:waitpg
"D:\pgsql16\bin\pg_isready.exe" -h 127.0.0.1 -p 5432 -q
if not errorlevel 1 goto ready
set /a tries+=1
if %tries% geq 30 goto ready
timeout /t 2 /nobreak >nul
goto waitpg
:ready
cd /d D:\evolution-api-server || exit /b 1
"D:\node\node.exe" node_modules\tsx\dist\cli.mjs src\main.ts >> D:\kilo\logs\evolution.log 2>&1
endlocal
