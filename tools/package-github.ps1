param(
    [string]$OutputDirectory,
    [string]$ReleaseTag = (Get-Date -Format 'yyyyMMdd')
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $taskRoot 'deliveries' }
if ($ReleaseTag -notmatch '^\d{8}(?:-[a-zA-Z0-9]+)?$') { throw 'ReleaseTag must be a date with an optional alphanumeric suffix.' }
$taskDelivery = [IO.Path]::GetFullPath($OutputDirectory)
$taskPackageRoot = Join-Path $taskDelivery ('GitHub发布包-' + $ReleaseTag)
$taskStage = Join-Path $taskPackageRoot 'jingce-ai-workbench'
$taskZip = Join-Path $taskPackageRoot ('Jingce-GitHub-Source-' + $ReleaseTag + '.zip')
if (Test-Path -LiteralPath $taskPackageRoot) { throw 'The output already exists. Choose another ReleaseTag; existing deliveries are preserved.' }

# Only named program files and audited source groups are copied. Never copy runtime.
$taskCopies = @(
    @{ From = 'server.mjs'; To = 'server.mjs' },
    @{ From = 'package.json'; To = 'package.json' },
    @{ From = '.gitignore'; To = '.gitignore' },
    @{ From = '.gitattributes'; To = '.gitattributes' },
    @{ From = 'LICENSE'; To = 'LICENSE' },
    @{ From = 'THIRD_PARTY_NOTICES.md'; To = 'THIRD_PARTY_NOTICES.md' },
    @{ From = 'tools\github\README.md.in'; To = 'README.md' },
    @{ From = 'tools\github\README.md.in'; To = 'tools\github\README.md.in' },
    @{ From = 'docs\GitHub发布指南.md'; To = 'docs\GitHub发布指南.md' },
    @{ From = 'docs\模型连接地址.md'; To = 'docs\模型连接地址.md' },
    @{ From = 'docs\连接配置示例.json'; To = 'docs\连接配置示例.json' },
    @{ From = '启动工作台.cmd'; To = '启动工作台.cmd' },
    @{ From = '停止工作台.cmd'; To = '停止工作台.cmd' },
    @{ From = 'tools\stop-studio.mjs'; To = 'tools\stop-studio.mjs' },
    @{ From = 'tools\package-share.ps1'; To = 'tools\package-share.ps1' },
    @{ From = 'tools\package-github.ps1'; To = 'tools\package-github.ps1' },
    @{ From = 'tools\share\install.cmd'; To = 'tools\share\install.cmd' },
    @{ From = 'tools\share\install.ps1'; To = 'tools\share\install.ps1' },
    @{ From = 'tools\share\start.cmd'; To = 'tools\share\start.cmd' },
    @{ From = 'tools\share\start-studio.mjs'; To = 'tools\share\start-studio.mjs' },
    @{ From = 'tools\share\stop.cmd'; To = 'tools\share\stop.cmd' },
    @{ From = 'tools\share\stop-studio.mjs'; To = 'tools\share\stop-studio.mjs' },
    @{ From = 'tools\share\说明.txt'; To = 'tools\share\说明.txt' }
)
foreach ($taskGroup in @(
    @{ Directory = 'lib'; Extensions = @('.mjs'); Suffix = '' },
    @{ Directory = 'public'; Extensions = @('.html', '.js', '.css'); Suffix = '' },
    @{ Directory = 'test'; Extensions = @('.mjs'); Suffix = '.test.mjs' }
)) {
    $taskSourceDirectory = Get-Item -LiteralPath (Join-Path $taskRoot $taskGroup.Directory)
    if ($taskSourceDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Source directory cannot be a link.' }
    foreach ($taskItem in Get-ChildItem -LiteralPath $taskSourceDirectory.FullName -Force) {
        if ($taskItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Source group contains a link.' }
        if ($taskItem.PSIsContainer -or $taskGroup.Extensions -notcontains $taskItem.Extension) { throw 'Source group contains an unexpected file.' }
        if ($taskGroup.Suffix -and -not $taskItem.Name.EndsWith($taskGroup.Suffix)) { continue }
        $taskRelative = Join-Path $taskGroup.Directory $taskItem.Name
        $taskCopies += @{ From = $taskRelative; To = $taskRelative }
    }
}
# Validate the whole copy plan before creating output. Linked ancestors are rejected too.
foreach ($taskCopy in $taskCopies) {
    $taskSource = Get-Item -LiteralPath (Join-Path $taskRoot $taskCopy.From)
    if ($taskSource.PSIsContainer) { throw 'Expected a source file.' }
    $taskChecked = $taskSource
    while ($taskChecked.FullName -ne $taskRoot) {
        if ($taskChecked.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Source path cannot contain links.' }
        if ($taskChecked -is [IO.FileInfo]) { $taskChecked = $taskChecked.Directory } else { $taskChecked = $taskChecked.Parent }
        if (-not $taskChecked) { throw 'Source path escaped the source root.' }
    }
}
New-Item -ItemType Directory -Path $taskStage | Out-Null
foreach ($taskCopy in $taskCopies) {
    $taskTarget = Join-Path $taskStage $taskCopy.To
    New-Item -ItemType Directory -Path (Split-Path -Parent $taskTarget) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskRoot $taskCopy.From) -Destination $taskTarget
}

# Use ZipArchive instead of Compress-Archive so hidden dotfiles are retained.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskInventory = @(Get-ChildItem -LiteralPath $taskStage -Recurse -Force -File | Sort-Object FullName | ForEach-Object {
    @{ path = $_.FullName.Substring($taskStage.Length + 1).Replace('\', '/'); bytes = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$taskZipStream = [IO.File]::Open($taskZip, [IO.FileMode]::CreateNew)
$taskZipArchive = New-Object IO.Compression.ZipArchive($taskZipStream, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($taskItem in $taskInventory) {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskZipArchive, (Join-Path $taskStage $taskItem.path), ('jingce-ai-workbench/' + $taskItem.path), [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { $taskZipArchive.Dispose(); $taskZipStream.Dispose() }
$taskZipHash = (Get-FileHash -LiteralPath $taskZip -Algorithm SHA256).Hash.ToLowerInvariant()
($taskZipHash + '  ' + [IO.Path]::GetFileName($taskZip)) | Set-Content -LiteralPath ($taskZip + '.sha256.txt') -Encoding ASCII
@{ product = 'Jingce Workbench'; release = $ReleaseTag; recommendedVisibility = 'private'; files = $taskInventory;
    excluded = @('runtime', 'private-config', 'media', 'generation-records', 'logs', 'old-deliveries', 'internal-notes', 'git-history', 'bundled-binaries');
    archive = @{ file = [IO.Path]::GetFileName($taskZip); bytes = (Get-Item -LiteralPath $taskZip).Length; sha256 = $taskZipHash };
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskPackageRoot 'source-manifest.json') -Encoding UTF8
Write-Output ('Source directory: ' + $taskStage)
Write-Output ('ZIP: ' + $taskZip)
Write-Output ('Files: ' + $taskInventory.Count)
Write-Output ('SHA256: ' + $taskZipHash)
