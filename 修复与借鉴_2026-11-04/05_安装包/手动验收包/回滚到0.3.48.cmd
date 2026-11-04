@echo off
setlocal
chcp 65001 >nul 2>&1
title DSH Desktop - Rollback to 0.3.48 (B)
echo.
echo   Roll back DSH Desktop to 0.3.48 (FREEZE-2026-11-04-B)
echo   Logic lives in rollback-to-0.3.48.ps1 (UTF-8).
echo.
where pwsh >nul 2>&1
if errorlevel 1 (
  echo   [ERROR] PowerShell 7 ^(pwsh^) not found.
  pause
  exit /b 2
)
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0rollback-to-0.3.48.ps1" %*
set RC=%ERRORLEVEL%
echo.
echo   Finished with exit code %RC%.
echo.
pause
exit /b %RC%
