@echo off
setlocal
chcp 65001 >nul 2>&1
title DSH Desktop 0.3.50 - Install and Verify
echo.
echo   DSH Desktop 0.3.50 - manual acceptance launcher
echo   All logic lives in install-and-verify.ps1 (UTF-8), this launcher only starts it.
echo.
where pwsh >nul 2>&1
if errorlevel 1 (
  echo   [ERROR] PowerShell 7 ^(pwsh^) not found. Please install PowerShell 7 first.
  echo           Or run: powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-and-verify.ps1"
  pause
  exit /b 2
)
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-and-verify.ps1" %*
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" (echo   Finished. Result folder is next to this script.) else (echo   Finished with exit code %RC%. See messages above.)
echo.
pause
exit /b %RC%
