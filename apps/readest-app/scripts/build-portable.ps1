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
  '数据默认保存在 exe 同一目录（settings.json 与 Readest 子目录）。'
) | Set-Content -Path (Join-Path $outDir 'README.txt') -Encoding utf8

# Portable mode marker: the app switches to exe-adjacent storage when this file exists.
# Portable mode marker: create it only when absent so repacking does not wipe
# the user's settings.json (fonts, themes, library layout, etc).
$settingsPath = Join-Path $outDir 'settings.json'
if (-not (Test-Path $settingsPath)) {
  [System.IO.File]::WriteAllText($settingsPath, '{}')
}
Write-Output "Portable build created at $outDir"
