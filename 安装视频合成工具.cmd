@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 将从 Gyan.dev 下载 FFmpeg 到本项目 runtime\tools，不修改系统 PATH。
echo FFmpeg 是独立外部工具，下载包附带其许可文件。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install-ffmpeg.ps1"
echo 安装结束后，请关闭并重新启动工作台。
pause
