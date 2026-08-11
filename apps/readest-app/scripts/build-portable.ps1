param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$ExeName = 'readest.exe'
)
$repoRoot = (Resolve-Path (Join-Path $Root '..\..')).Path
$candidates = @(
  (Join-Path $Root "src-tauri\target\release\$ExeName"),
  (Join-Path $repoRoot "target\release\$ExeName")
)
$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { throw "Release exe not found; looked in: $($candidates -join ', ')" }
$outDir = Join-Path $Root 'release\readest-local'
New-Item -ItemType Directory -Force $outDir | Out-Null
$outName = if ($ExeName -match '-local\.exe$') { $ExeName } else { ([System.IO.Path]::GetFileNameWithoutExtension($ExeName) + '-local.exe') }
Copy-Item $exe (Join-Path $outDir $outName) -Force
@(
  'Readest Local 便携版',
  '直接运行 exe，无需安装。',
  '需要系统已安装 Microsoft Edge WebView2 Runtime（Windows 11 自带）。',
  '数据默认保存在系统应用数据目录。'
) | Set-Content -Path (Join-Path $outDir 'README.txt') -Encoding utf8
Write-Output "Portable build created at $outDir"
