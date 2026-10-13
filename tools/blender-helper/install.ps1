param([switch]$SkipNode)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskBin = Join-Path $taskRoot 'bin'
$taskTools = Join-Path $taskRoot 'runtime\tools\ffmpeg\bin'
New-Item -ItemType Directory -Path $taskBin,$taskTools -Force | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
if (-not $SkipNode -and -not (Test-Path -LiteralPath (Join-Path $taskBin 'node.exe'))) {
    Write-Host '首次启动：下载并校验 Node.js 运行环境...'
    $taskVersion = '24.14.0'
    $taskName = 'node-v' + $taskVersion + '-win-x64.zip'
    $taskBase = 'https://nodejs.org/dist/v' + $taskVersion + '/'
    $taskChecksums = (Invoke-WebRequest -Uri ($taskBase + 'SHASUMS256.txt') -UseBasicParsing -TimeoutSec 45).Content
    if ($taskChecksums -is [byte[]]) { $taskChecksums = [Text.Encoding]::UTF8.GetString($taskChecksums) }
    $taskMatch = @($taskChecksums -split "`n" | Where-Object { $_.Trim().EndsWith('  ' + $taskName) })
    if ($taskMatch.Count -ne 1) { throw '无法读取 Node.js 官方校验值。' }
    $taskZip = Join-Path $taskBin $taskName
    Invoke-WebRequest -Uri ($taskBase + $taskName) -OutFile $taskZip -UseBasicParsing -TimeoutSec 180
    if ((Get-FileHash -LiteralPath $taskZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne ($taskMatch[0] -split '\s+')[0]) { throw 'Node.js 校验失败。' }
    $taskExtract = Join-Path $taskBin 'node-package'
    Expand-Archive -LiteralPath $taskZip -DestinationPath $taskExtract -Force
    Copy-Item -LiteralPath (Join-Path $taskExtract ('node-v' + $taskVersion + '-win-x64\node.exe')) -Destination (Join-Path $taskBin 'node.exe')
    Copy-Item -LiteralPath (Join-Path $taskExtract ('node-v' + $taskVersion + '-win-x64\LICENSE')) -Destination (Join-Path $taskBin 'NODE-LICENSE.txt')
}
if (-not (Test-Path -LiteralPath (Join-Path $taskTools 'ffmpeg.exe'))) {
    Write-Host '首次启动：下载并校验 MP4 编码工具...'
    $taskMetadata = Invoke-RestMethod -Uri 'https://pypi.org/pypi/imageio-ffmpeg/0.6.0/json' -TimeoutSec 45
    $taskWheels = @($taskMetadata.urls | Where-Object { $_.filename -eq 'imageio_ffmpeg-0.6.0-py3-none-win_amd64.whl' })
    if ($taskWheels.Count -ne 1 -or $taskWheels[0].url -notmatch '^https://files.pythonhosted.org/') { throw '无法确认编码工具下载地址。' }
    $taskWheelZip = Join-Path $taskBin 'imageio-ffmpeg.zip'
    Invoke-WebRequest -Uri $taskWheels[0].url -OutFile $taskWheelZip -UseBasicParsing -TimeoutSec 180
    if ((Get-FileHash -LiteralPath $taskWheelZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskWheels[0].digests.sha256) { throw '编码工具校验失败。' }
    $taskWheelFolder = Join-Path $taskBin 'video-package'
    Expand-Archive -LiteralPath $taskWheelZip -DestinationPath $taskWheelFolder -Force
    $taskBinaries = @(Get-ChildItem -LiteralPath (Join-Path $taskWheelFolder 'imageio_ffmpeg\binaries') -Filter 'ffmpeg*.exe' -File)
    if ($taskBinaries.Count -ne 1) { throw '未找到编码工具可执行文件。' }
    Copy-Item -LiteralPath $taskBinaries[0].FullName -Destination (Join-Path $taskTools 'ffmpeg.exe')
}
Write-Host '运行环境已准备好。Blender 仍使用你已安装的版本。'
