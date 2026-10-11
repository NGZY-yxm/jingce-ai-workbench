@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\share\install.ps1"
if errorlevel 1 echo 安装未完成，请查看上面的提示。也可以直接双击“启动工作台.cmd”免安装运行。
pause
