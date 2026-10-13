@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "tools\blender-helper.mjs" cd /d "%~dp0..\.."
if exist "bin\node.exe" goto bundlednode
where node >nul 2>nul
if errorlevel 1 goto bundlednode
node -e "if (Number(process.versions.node.split('.')[0]) < 20) process.exit(1)"
if not errorlevel 1 goto systemnode
:bundlednode
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\blender-helper\install.ps1"
if errorlevel 1 goto failed
"bin\node.exe" "tools\blender-helper.mjs" --open
if errorlevel 1 goto failed
exit /b
:systemnode
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\blender-helper\install.ps1" -SkipNode
if errorlevel 1 goto failed
node "tools\blender-helper.mjs" --open
if errorlevel 1 goto failed
exit /b
:failed
echo 幻帧blender助手未启动。请查看上方提示。
pause
