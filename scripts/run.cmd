@echo off
REM Dijalankan oleh "AuliaPos Gateway.exe" (scripts/Launcher.cs) di folder
REM distribusi. %~dp0 = folder tempat file ini berada (folder distribusi),
REM jadi semua path di bawah relatif ke situ, bukan hardcoded.
cd /d "%~dp0"
if not exist "logs" mkdir "logs"
set AULIAPOS_LAUNCHED_FROM_EXE=1
"%~dp0node.exe" "%~dp0supervisor\launcher.js" >> "%~dp0logs\exe-launcher.log" 2>&1
