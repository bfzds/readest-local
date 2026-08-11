# Readest Local portable build helper (called by 打包便携版.bat)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

Write-Host '============================================'
Write-Host '  Readest Local 便携版一键打包'
Write-Host '============================================'
Write-Host ''

$exe = Join-Path $root 'target\release\readest-local.exe'
$needBuild = $true

if (Test-Path $exe) {
    Write-Host "检测到已有 release 程序: $exe"
    $answer = Read-Host '输入 1 后回车 = 重新构建; 直接回车 = 跳过构建, 用现有程序打包'
    if ($answer -ne '1') {
        $needBuild = $false
    }
}

if ($needBuild) {
    Write-Host ''
    Write-Host '[1/2] 开始构建 release 版, 时间较长, 请耐心等待...'
    Write-Host ''
    & pnpm tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) {
        Write-Host '[错误] 构建失败, 请查看上方错误信息。' -ForegroundColor Red
        Read-Host '按回车退出'
        exit 1
    }
}
else {
    Write-Host '跳过构建, 使用现有程序。'
}

Write-Host ''
Write-Host '[2/2] 组装便携版目录...'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'apps\readest-app\scripts\build-portable.ps1') -ExeName readest-local.exe
if ($LASTEXITCODE -ne 0) {
    Write-Host '[错误] 便携版组装失败。' -ForegroundColor Red
    Read-Host '按回车退出'
    exit 1
}

Write-Host ''
Write-Host '============================================'
Write-Host '  打包完成!'
Write-Host '  便携版位置: apps\readest-app\release\readest-local\'
Write-Host '  直接运行其中的 readest-local.exe 即可, 无需安装。'
Write-Host '  整个文件夹复制到其他电脑即可迁移。'
Write-Host '============================================'
Write-Host ''
Read-Host '按回车关闭窗口'
