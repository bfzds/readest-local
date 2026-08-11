$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot '..\build-portable.ps1'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("readest-portable-test-" + [guid]::NewGuid().ToString('N'))
$resolvedTemp = [System.IO.Path]::GetFullPath($tempRoot)
$tempPrefix = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())

if (-not $resolvedTemp.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to touch temp path outside system temp: $resolvedTemp"
}

try {
  $root = Join-Path $tempRoot 'app'
  $releaseDir = Join-Path $root 'src-tauri\target\release'
  New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
  $exe = Join-Path $releaseDir 'readest-local.exe'
  [System.IO.File]::WriteAllText($exe, 'dummy exe')

  $outDir = Join-Path $root 'release\readest-local'
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
  $settingsPath = Join-Path $outDir 'settings.json'
  $originalSettings = '{"globalViewSettings":{"defaultFontSize":24}}'
  [System.IO.File]::WriteAllText($settingsPath, $originalSettings)

  & $scriptPath -Root $root -ExeName readest-local.exe

  $after = [System.IO.File]::ReadAllText($settingsPath)
  if ($after -ne $originalSettings) {
    throw 'build-portable.ps1 overwrote an existing portable settings.json'
  }

  Write-Host 'PASS: existing portable settings.json was preserved'
}
finally {
  $resolvedTempRoot = [System.IO.Path]::GetFullPath($tempRoot)
  if ($resolvedTempRoot.StartsWith($tempPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
  }
}
