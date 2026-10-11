$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskTools = [IO.Path]::GetFullPath((Join-Path $taskRoot 'runtime\tools'))
if (-not $taskTools.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid tool directory.' }
$taskDestination = Join-Path $taskTools 'ffmpeg'
if (Test-Path -LiteralPath (Join-Path $taskDestination 'bin\ffmpeg.exe')) { Write-Output 'FFmpeg is already installed in this project.'; exit 0 }
New-Item -ItemType Directory -Path $taskTools -Force | Out-Null
$taskArchive = Join-Path $taskTools 'ffmpeg-release-essentials.zip'
$taskExtract = Join-Path $taskTools ('extract-' + [Guid]::NewGuid().ToString('N'))
$taskUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
Write-Output 'Downloading FFmpeg from Gyan.dev...'
$taskExpected = [string](Invoke-RestMethod -Uri ($taskUrl + '.sha256') -TimeoutSec 30)
if ($taskExpected -notmatch '([a-fA-F0-9]{64})') { throw 'Invalid checksum response.' }
$taskExpected = $Matches[1]
Invoke-WebRequest -Uri $taskUrl -OutFile $taskArchive -UseBasicParsing -TimeoutSec 600
$taskActual = (Get-FileHash -LiteralPath $taskArchive -Algorithm SHA256).Hash
if ($taskActual -ne $taskExpected) { throw 'Checksum mismatch. The downloaded file was not installed.' }
Write-Output 'Checksum verified. Extracting...'
Expand-Archive -LiteralPath $taskArchive -DestinationPath $taskExtract
$taskBundles = @(Get-ChildItem -LiteralPath $taskExtract -Directory)
if ($taskBundles.Count -ne 1) { throw 'Unexpected archive structure.' }
$taskBundle = $taskBundles[0]
if (-not (Test-Path -LiteralPath (Join-Path $taskBundle.FullName 'bin\ffmpeg.exe')) -or -not (Test-Path -LiteralPath (Join-Path $taskBundle.FullName 'bin\ffprobe.exe'))) { throw 'FFmpeg or ffprobe was not found.' }
Move-Item -LiteralPath $taskBundle.FullName -Destination $taskDestination
Remove-Item -LiteralPath $taskArchive
Remove-Item -LiteralPath $taskExtract
Write-Output 'Installed. Please restart Jingce. License files are retained in runtime/tools/ffmpeg.'
