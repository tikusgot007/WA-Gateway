@echo off
rem Kill hung helper PowerShell processes left by aborted scheduled-task runs.
rem Node processes (Evolution + adapter) are intentionally NOT touched.
taskkill /F /IM powershell.exe >nul 2>&1
exit /b 0
