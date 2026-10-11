@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "%~dp0bin\node.exe" (
  echo 找不到内置运行环境。请先完整解压安装包，不要在压缩包内直接启动。
  pause
  exit /b 1
)
echo 正在打开镜策工作台...
echo 请保留此窗口；关闭窗口会停止工作台。
"%~dp0bin\node.exe" "%~dp0tools\share\start-studio.mjs" --open
if errorlevel 1 pause
