@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22.22 或更新版本：https://nodejs.org/
  pause
  exit /b 1
)
echo 正在打开幻帧 MiraFrame AI 视频工作台...
echo 请保留此窗口。关闭此窗口会停止工作台。
node server.mjs --open
if errorlevel 1 pause
