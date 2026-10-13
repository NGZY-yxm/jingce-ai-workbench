param(
    [string]$OutputDirectory,
    [string]$ReleaseTag = (Get-Date -Format 'yyyyMMdd')
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $taskRoot 'deliveries' }
$taskDelivery = [IO.Path]::GetFullPath($OutputDirectory)
if ($ReleaseTag -notmatch '^\d{8}(?:-[a-zA-Z0-9]+)?$') { throw 'ReleaseTag 必须为日期或日期加版本后缀。' }
$taskName = 'Jingce-Workbench-Windows-x64-' + $ReleaseTag
$taskCache = Join-Path $taskDelivery 'share-build-cache'
$taskStageParent = Join-Path $taskCache ([Guid]::NewGuid().ToString('N'))
$taskStage = Join-Path $taskStageParent '镜策工作台'
New-Item -ItemType Directory -Path $taskCache, $taskStage -Force | Out-Null

# Build from a precise allowlist. Never inspect or copy the user's runtime.
$taskCopies = @(
    @{ From = 'server.mjs'; To = 'server.mjs' },
    @{ From = 'package.json'; To = 'package.json' },
    @{ From = 'LICENSE'; To = 'LICENSE' },
    @{ From = 'THIRD_PARTY_NOTICES.md'; To = 'THIRD_PARTY_NOTICES.md' },
    @{ From = 'tools\blender-previs.py'; To = 'tools\blender-previs.py' },
    @{ From = 'tools\blender-helper.mjs'; To = 'tools\blender-helper.mjs' },
    @{ From = 'tools\blender-helper\start.cmd'; To = 'tools\blender-helper\start.cmd' },
    @{ From = 'tools\blender-helper\install.ps1'; To = 'tools\blender-helper\install.ps1' },
    @{ From = 'tools\blender-helper\setup.cmd'; To = 'tools\blender-helper\setup.cmd' },
    @{ From = 'tools\blender-helper\setup.ps1'; To = 'tools\blender-helper\setup.ps1' },
    @{ From = 'docs\Blender预演工作流.md'; To = 'docs\Blender预演工作流.md' },
    @{ From = 'tools\share\install.cmd'; To = '安装镜策.cmd' },
    @{ From = 'tools\share\start.cmd'; To = '启动工作台.cmd' },
    @{ From = 'tools\share\stop.cmd'; To = '停止工作台.cmd' },
    @{ From = 'tools\share\说明.txt'; To = '说明.txt' },
    @{ From = 'tools\share\install.ps1'; To = 'tools\share\install.ps1' },
    @{ From = 'tools\share\start-studio.mjs'; To = 'tools\share\start-studio.mjs' },
    @{ From = 'tools\share\stop-studio.mjs'; To = 'tools\share\stop-studio.mjs' }
)
foreach ($taskSourceGroup in @(@{ Directory = 'lib'; Extensions = @('.mjs') }, @{ Directory = 'public'; Extensions = @('.html', '.js', '.css', '.png') })) {
    $taskDirectory = Get-Item -LiteralPath (Join-Path $taskRoot $taskSourceGroup.Directory)
    if ($taskDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '程序源目录不能是链接。' }
    foreach ($taskItem in Get-ChildItem -LiteralPath $taskDirectory.FullName -Force) {
        if ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '程序源目录包含链接，已停止打包。' }
        if ($taskItem.PSIsContainer -or $taskSourceGroup.Extensions -notcontains $taskItem.Extension) { throw '程序源目录包含非白名单文件，已停止打包。' }
        $taskRelative = Join-Path $taskSourceGroup.Directory $taskItem.Name
        $taskCopies += @{ From = $taskRelative; To = $taskRelative }
    }
}
foreach ($taskCopy in $taskCopies) {
    $taskSource = Get-Item -LiteralPath (Join-Path $taskRoot $taskCopy.From)
    if ($taskSource.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '程序源文件不能是链接。' }
    $taskTarget = Join-Path $taskStage $taskCopy.To
    New-Item -ItemType Directory -Path (Split-Path -Parent $taskTarget) -Force | Out-Null
    Copy-Item -LiteralPath $taskSource.FullName -Destination $taskTarget
}

$taskNodeVersion = '24.14.0'
$taskNodeArchiveName = 'node-v' + $taskNodeVersion + '-win-x64.zip'
$taskNodeBase = 'https://nodejs.org/dist/v' + $taskNodeVersion + '/'
$taskNodeZip = Join-Path $taskCache $taskNodeArchiveName
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$taskManifest = (Invoke-WebRequest -Uri ($taskNodeBase + 'SHASUMS256.txt') -UseBasicParsing -TimeoutSec 60).Content
if ($taskManifest -is [byte[]]) { $taskManifest = [Text.Encoding]::UTF8.GetString($taskManifest) }
$taskNodeHashLine = @($taskManifest -split "`n" | Where-Object { $_.Trim().EndsWith('  ' + $taskNodeArchiveName) })
$taskExeHashLine = @($taskManifest -split "`n" | Where-Object { $_.Trim().EndsWith('  win-x64/node.exe') })
if ($taskNodeHashLine.Count -ne 1 -or $taskExeHashLine.Count -ne 1) { throw '无法确认官方 Node.js 校验清单。' }
$taskExpectedZipHash = ($taskNodeHashLine[0] -split '\s+')[0].ToLowerInvariant()
$taskExpectedExeHash = ($taskExeHashLine[0] -split '\s+')[0].ToLowerInvariant()
if (-not (Test-Path -LiteralPath $taskNodeZip)) {
    Write-Host '正在下载官方 Node.js Windows x64 运行环境...'
    Invoke-WebRequest -Uri ($taskNodeBase + $taskNodeArchiveName) -OutFile $taskNodeZip -UseBasicParsing -TimeoutSec 180
}
if ((Get-FileHash -LiteralPath $taskNodeZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskExpectedZipHash) { throw 'Node.js 压缩包校验失败，请移除构建缓存中的 Node ZIP 后重新打包。' }
$taskNodeExtract = Join-Path $taskStageParent 'official-node'
Expand-Archive -LiteralPath $taskNodeZip -DestinationPath $taskNodeExtract
$taskOfficialNode = Join-Path $taskNodeExtract ('node-v' + $taskNodeVersion + '-win-x64')
$taskNodeExe = Join-Path $taskOfficialNode 'node.exe'
if ((Get-FileHash -LiteralPath $taskNodeExe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskExpectedExeHash) { throw '内置 Node.js 可执行文件校验失败。' }
New-Item -ItemType Directory -Path (Join-Path $taskStage 'bin') -Force | Out-Null
Copy-Item -LiteralPath $taskNodeExe -Destination (Join-Path $taskStage 'bin\node.exe')
Copy-Item -LiteralPath (Join-Path $taskOfficialNode 'LICENSE') -Destination (Join-Path $taskStage 'bin\NODE-LICENSE.txt')

$taskInventory = @(Get-ChildItem -LiteralPath $taskStage -Recurse -File | Sort-Object FullName | ForEach-Object {
    @{ path = $_.FullName.Substring($taskStage.Length + 1).Replace('\', '/'); bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$taskPackageManifest = @{
    product = 'Jingce Workbench'; version = '0.1-share'; release = $ReleaseTag; platform = 'Windows 10/11 x64';
    node = @{ version = ('v' + $taskNodeVersion); source = ($taskNodeBase + $taskNodeArchiveName); archiveSha256 = $taskExpectedZipHash; executableSha256 = $taskExpectedExeHash; license = 'bin/NODE-LICENSE.txt' };
    cleanInstall = $true; files = $taskInventory;
    excluded = @('runtime', 'projects', 'media', 'api-keys', 'cloud-credentials', 'generation-history', 'backups', 'logs', 'screenshots', 'examples', 'internal-documents', 'tests', 'build-cache')
}
$taskPackageManifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskStage 'package-manifest.json') -Encoding UTF8
$taskZip = Join-Path $taskDelivery ($taskName + '.zip')
if (Test-Path -LiteralPath $taskZip) { throw '目标安装包已经存在；请指定新的 ReleaseTag，避免覆盖已交付文件。' }
Compress-Archive -LiteralPath $taskStage -DestinationPath $taskZip -CompressionLevel Optimal
$taskZipHash = (Get-FileHash -LiteralPath $taskZip -Algorithm SHA256).Hash.ToLowerInvariant()
($taskZipHash + '  ' + [IO.Path]::GetFileName($taskZip)) | Set-Content -LiteralPath ($taskZip + '.sha256.txt') -Encoding ASCII
Write-Output ('安装包：' + $taskZip)
Write-Output ('大小（MB）：' + [Math]::Round((Get-Item -LiteralPath $taskZip).Length / 1MB, 2))
Write-Output ('SHA256：' + $taskZipHash)
