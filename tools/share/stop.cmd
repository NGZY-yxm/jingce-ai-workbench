@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "%~dp0bin\node.exe" (
  echo 请先完整解压安装包。
  pause
  exit /b 1
)
"%~dp0bin\node.exe" "%~dp0tools\share\stop-studio.mjs"
if errorlevel 1 pause
