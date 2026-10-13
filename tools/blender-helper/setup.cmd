@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "tools\blender-helper\setup.ps1" cd /d "%~dp0..\.."
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\blender-helper\setup.ps1"
if errorlevel 1 pause
