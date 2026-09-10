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

# ---------------------------------------------------------------------------
# 源码指纹：HEAD 提交 + 全工作区（含未跟踪文件、不含 gitignore 项）的 git
# 树哈希，覆盖所有会进 exe 的输入（前端/静态资源/Tauri 配置/Rust 源码/依赖
# 清单）。与上次成功构建时记录的指纹比对，无变化可安全跳过构建。
# 用临时索引（GIT_INDEX_FILE）做 write-tree，不碰真实的 git index；只哈希
# 有变化的文件，实测 1 秒左右（文件系统全量枚举在本机要 180s+）。内容级
# 精确：改了再改回去不会误报。
# ---------------------------------------------------------------------------
$stampPath = Join-Path $root 'apps\readest-app\release\.last-build-fingerprint'

function Get-SourceFingerprint {
    $head = $null
    try { $head = & git rev-parse HEAD 2>$null } catch { }
    $tree = $null
    $tmpIndex = Join-Path $env:TEMP ('build-fingerprint-index-' + [guid]::NewGuid().ToString('N'))
    $prevIndex = $env:GIT_INDEX_FILE
    $env:GIT_INDEX_FILE = $tmpIndex
    try {
        & git add -A -- . 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $tree = & git write-tree 2>$null
        }
    } catch { } finally {
        if ($prevIndex) { $env:GIT_INDEX_FILE = $prevIndex } else { Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath $tmpIndex -Force -ErrorAction SilentlyContinue
    }
    # 非 git 环境（比如整个目录被拷走）拿不到树哈希——返回哨兵值，
    # 由调用方降级为"永远询问"，绝不自动跳过构建。
    if (-not $head) { $head = 'no-git' }
    if (-not $tree) { $tree = 'no-tree' }
    return "$head|$tree"
}

# 构建要写 target\release\readest-local.exe、组装要复制它——正在运行的阅读器
# 会锁住 exe 导致 "os error 32 / 正被另一进程使用"。打包前先确认进程已退出。
$running = Get-Process -Name 'readest-local' -ErrorAction SilentlyContinue
if ($running) {
    Write-Host ''
    Write-Host "检测到阅读器正在运行（PID: $($running.Id -join ', ')）。" -ForegroundColor Yellow
    $answer = Read-Host '关闭阅读器并继续打包? 直接回车/输入 y = 关闭; 输入 n = 退出打包'
    if ($answer -eq 'n') {
        Write-Host '已取消打包。请手动关闭阅读器后重新运行本脚本。'
        Read-Host '按回车退出'
        exit 0
    }
    # 先优雅关闭（等价点窗口的 ×），给应用走正常退出、落盘设置/进度的机会。
    foreach ($proc in $running) {
        $null = $proc.CloseMainWindow()
    }
    # 轮询等待优雅退出，最多 8 秒。
    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline -and (Get-Process -Name 'readest-local' -ErrorAction SilentlyContinue)) {
        Start-Sleep -Milliseconds 300
    }
    # 兜底强杀：卡在对话框上等不退出的情况。
    $stillRunning = Get-Process -Name 'readest-local' -ErrorAction SilentlyContinue
    if ($stillRunning) {
        Write-Host '优雅关闭超时, 强制结束阅读器进程...' -ForegroundColor Yellow
        $stillRunning | Stop-Process -Force
        Start-Sleep -Milliseconds 500
    }
    Write-Host '阅读器已关闭。'
}

if (Test-Path $exe) {
    $fingerprint = Get-SourceFingerprint
    $stamp = if (Test-Path $stampPath) { (Get-Content $stampPath -Raw).Trim() } else { '' }
    if ($stamp -eq $fingerprint -and $fingerprint -notmatch '^no-git\|') {
        Write-Host "检测到已有 release 程序, 且源码自上次构建后无变化: $exe"
        $needBuild = $false
    } else {
        Write-Host "检测到已有 release 程序, 但源码相对上次构建有变化 (或首次记录指纹)。"
        $answer = Read-Host '直接回车或输入 1 = 重新构建 (推荐, 否则新改动不会进便携版); 输入 0 = 仍用现有程序打包'
        if ($answer -eq '0') {
            $needBuild = $false
            Write-Host '已选择跳过构建: 注意便携版将不包含最近的源码改动。' -ForegroundColor Yellow
        }
    }
} else {
    $fingerprint = Get-SourceFingerprint
}

if ($needBuild) {
    Write-Host ''
    Write-Host '[1/2] 开始构建 release 版, 时间较长, 请耐心等待...'
    Write-Host ''
    $buildStart = Get-Date
    & pnpm tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) {
        Write-Host '[错误] 构建失败, 请查看上方错误信息。' -ForegroundColor Red
        Read-Host '按回车退出'
        exit 1
    }
    $elapsed = (Get-Date) - $buildStart
    # TimeSpan 自定义格式里的反斜杠转义在 -f（string.Format）中不合法，直接拼数字。
    $mins = [int][math]::Floor($elapsed.TotalMinutes)
    $secs = [int]($elapsed.TotalSeconds) % 60
    Write-Host ('构建完成, 耗时 {0} 分 {1:00} 秒。' -f $mins, $secs)
    # 只在构建成功后记录指纹——失败后重跑不会被误判为"无变化"。
    New-Item -ItemType Directory -Force (Split-Path $stampPath) | Out-Null
    Set-Content -Path $stampPath -Value $fingerprint -Encoding ascii
} else {
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
