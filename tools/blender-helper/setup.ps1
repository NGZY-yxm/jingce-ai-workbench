$ErrorActionPreference = 'Stop'
$taskSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskTarget = Join-Path $env:LOCALAPPDATA 'JingceBlenderHelper'
New-Item -ItemType Directory -Path $taskTarget -Force | Out-Null
foreach ($taskEntry in @('lib','public','tools','package.json','LICENSE','THIRD_PARTY_NOTICES.md')) {
    $taskItem = Join-Path $taskSource $taskEntry
    if ((Test-Path -LiteralPath $taskItem) -and $taskSource -ne $taskTarget) {
        Copy-Item -LiteralPath $taskItem -Destination $taskTarget -Recurse -Force
    }
}
& (Join-Path $taskTarget 'tools\blender-helper\install.ps1')
$taskShell = New-Object -ComObject WScript.Shell
$taskShortcut = $taskShell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) '幻帧blender助手.lnk'))
$taskShortcut.TargetPath = Join-Path $taskTarget 'bin\node.exe'
$taskShortcut.Arguments = '"' + (Join-Path $taskTarget 'tools\blender-helper.mjs') + '" --open'
$taskShortcut.WorkingDirectory = $taskTarget
$taskShortcut.WindowStyle = 7
$taskShortcut.Save()
Write-Host '安装完成。双击桌面“幻帧blender助手”启动，然后在网站连接。Blender 需自行安装。'
