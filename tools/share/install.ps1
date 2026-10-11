param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\JingceStudio'),
    [switch]$NoShortcut
)
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$destinationRoot = [IO.Path]::GetFullPath($InstallRoot)
if (-not [Environment]::Is64BitOperatingSystem) { throw '此安装包需要 Windows 10/11 64 位系统。' }
if ([Environment]::OSVersion.Version.Major -lt 10) { throw '此安装包需要 Windows 10 或更新系统。' }
if ($sourceRoot.TrimEnd('\') -eq $destinationRoot.TrimEnd('\')) { throw '安装目录不能与解压目录相同；直接使用启动工作台.cmd 即可免安装运行。' }
$rootFiles = @('server.mjs', 'package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '说明.txt', '安装镜策.cmd', '启动工作台.cmd', '停止工作台.cmd', '安装视频合成工具.cmd', 'tools\install-ffmpeg.ps1', 'package-manifest.json')
$programDirectories = @('lib', 'public', 'bin', 'tools\share')
# Only program files are installed. Existing local projects and keys stay in runtime.
$copyPlan = @()
foreach ($relative in $rootFiles) {
    $item = Get-Item -LiteralPath (Join-Path $sourceRoot $relative)
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '安装包包含不受支持的链接文件。' }
    $copyPlan += $relative
}
foreach ($relative in $programDirectories) {
    $directory = Get-Item -LiteralPath (Join-Path $sourceRoot $relative)
    if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '安装包包含不受支持的链接目录。' }
    foreach ($item in Get-ChildItem -LiteralPath $directory.FullName -Recurse -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '安装包包含不受支持的链接。' }
        if (-not $item.PSIsContainer) { $copyPlan += $item.FullName.Substring($sourceRoot.Length + 1) }
    }
}
$installedNode = Join-Path $destinationRoot 'bin\node.exe'
$running = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -eq $installedNode })
if ($running.Count -gt 0) { throw '这个安装目录中的工作台正在运行。请先用停止工作台.cmd 停止，再重新安装。' }
New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
foreach ($relative in $copyPlan) {
    $target = Join-Path $destinationRoot $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRoot $relative) -Destination $target -Force
}
if (-not $NoShortcut) {
    $shell = New-Object -ComObject WScript.Shell
    $desktop = [Environment]::GetFolderPath('Desktop')
    $programs = Join-Path ([Environment]::GetFolderPath('Programs')) '镜策工作台'
    New-Item -ItemType Directory -Path $programs -Force | Out-Null
    $shortcutPlans = @(
        @{ Path = (Join-Path $desktop '镜策工作台.lnk'); Script = '启动工作台.cmd' },
        @{ Path = (Join-Path $programs '镜策工作台.lnk'); Script = '启动工作台.cmd' },
        @{ Path = (Join-Path $programs '停止镜策工作台.lnk'); Script = '停止工作台.cmd' }
    )
    foreach ($plan in $shortcutPlans) {
        $shortcut = $shell.CreateShortcut($plan.Path)
        $shortcut.TargetPath = $env:ComSpec
        $shortcut.Arguments = '/d /c ""{0}""' -f (Join-Path $destinationRoot $plan.Script)
        $shortcut.WorkingDirectory = $destinationRoot
        $shortcut.Description = '镜策 AI 图片与视频创作工作台'
        $shortcut.Save()
    }
}
Write-Host ''
Write-Host '镜策已安装完成。' -ForegroundColor Green
Write-Host ('安装目录：' + $destinationRoot)
if (-not $NoShortcut) { Write-Host '请双击桌面上的“镜策工作台”打开。' }
Write-Host '首次使用请新建工程，并填写你自己的视频 / 生图 API Key。'
