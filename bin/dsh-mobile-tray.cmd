@echo off
:: DSH 手机伴侣托盘 —— 独立配件启动器
:: 不动 DSH Desktop 本体；仅提供一层薄的移动端入口
setlocal

:: 优先使用 DSH 自带的 node（与后端同一运行时），否则用系统 node
set "NODE_EXE=%APPDATA%\DSH Desktop\backend\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

set "TRAY_ROOT=%~dp0"
set "TRAY_SCRIPT=%TRAY_ROOT%dsh-mobile-tray.mjs"

if not exist "%TRAY_SCRIPT%" (
  echo [dsh-mobile-tray] 脚本未找到: %TRAY_SCRIPT%
  exit /b 1
)

"%NODE_EXE%" "%TRAY_SCRIPT%" %*
exit /b %ERRORLEVEL%
