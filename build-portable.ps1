# Readest Local portable build helper (called by 打包便携版.bat)
$ErrorActionPreference = 'Stop'

# 双击运行时，未捕获的终止错误会把窗口连同错误信息一起关掉，最后只剩"闪一下"。
# trap 兜住：打印原因、等用户看完、以非 0 退出（.bat 里也能看出失败）。
# Read-Host 只在交互式控制台里等：CI / 重定向输入下它会永久挂住。
function Wait-ForUser {
    param([string]$Message = '按回车退出')
    if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
        Read-Host $Message | Out-Null
    }
}

trap {
    Write-Host ''
    Write-Host ("[错误] 脚本中断：{0}" -f $_.Exception.Message) -ForegroundColor Red
    Write-Host ("        位置：{0}" -f $_.InvocationInfo.PositionMessage)
    Wait-ForUser
    exit 1
}

$root = $PSScriptRoot
Set-Location $root

Write-Host '============================================'
Write-Host '  Readest Local 便携版一键打包'
Write-Host '============================================'
Write-Host ''

$exe = Join-Path $root 'target\release\readest-local.exe'
$needBuild = $true

# ---------------------------------------------------------------------------
# 源码指纹：只覆盖真正会进 exe 的输入（前端源码/静态资源/Tauri 与 Rust 配置/
# 依赖清单）的 git 内容哈希，与上次成功构建时记录的指纹比对，无变化自动跳过
# 构建，有变化自动重建——全程无交互。
# 用临时索引（GIT_INDEX_FILE）做 write-tree，不碰真实的 git index；只哈希
# 有变化的文件，实测 1 秒左右（文件系统全量枚举在本机要 180s+）。内容级
# 精确：改了再改回去不会误报。
# 已知盲区：被 gitignore 的构建输入（如 .env.tauri 环境变量）不在指纹内，
# 改它们不会触发重建——需要时删除指纹文件强制重建。
# ---------------------------------------------------------------------------
$stampPath = Join-Path $root 'apps\readest-app\release\.last-build-fingerprint'

function Get-SourceFingerprint {
    $pathspecs = @(
        'apps\readest-app\src',
        'apps\readest-app\public',
        'apps\readest-app\src-tauri',
        'apps\readest-app\next.config.mjs',
        'apps\readest-app\package.json',
        'package.json',
        'pnpm-lock.yaml',
        'Cargo.toml',
        'Cargo.lock'
    )
    $head = $null
    try { $head = & git rev-parse HEAD 2>$null } catch { }
    $tree = $null
    $tmpIndex = Join-Path $env:TEMP ('build-fingerprint-index-' + [guid]::NewGuid().ToString('N'))
    $prevIndex = $env:GIT_INDEX_FILE
    $env:GIT_INDEX_FILE = $tmpIndex
    # PS 5.1 的坑（本缺陷的根因）：脚本顶部是 $ErrorActionPreference='Stop'，此时
    # `git add … 2>$null` 会把 git 的 stderr 变成 terminating error（NativeCommandError
    # / RemoteException），而 `git add -A` 恰恰会往 stderr 写东西——本仓库
    # apps\readest-app\src-tauri\plugins 下有两个内嵌 git 仓库，每次都会打印
    # "warning: adding embedded git repository"。原来那个空 catch 一吞，$tree 永远是
    # $null，指纹被写成哨兵 'no-tree'；此后 HEAD 不变时它与自身相等 → 判定"源码无
    # 变化"→ 永远跳过构建（实测复现：改完源码仍只组装旧 exe）。把这三个 git 调用
    # 降回 Continue 即可；成败改由 $LASTEXITCODE 显式判定。
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & git add -A -- @pathspecs 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $tree = & git write-tree 2>$null
        }
    } catch { } finally {
        $ErrorActionPreference = $prevEap
        if ($prevIndex) { $env:GIT_INDEX_FILE = $prevIndex } else { Remove-Item Env:GIT_INDEX_FILE -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath $tmpIndex -Force -ErrorAction SilentlyContinue
    }
    # 非 git 环境（比如整个目录被拷走）拿不到树哈希——返回哨兵值，
    # 由调用方保守处理：直接构建，绝不自动跳过。
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

# 全自动判断是否重建：无 exe → 构建；指纹匹配 → 跳过；指纹不同 → 重建；
# 指纹不可用（git 缺失/取不到树）→ 保守构建。指纹故意只覆盖构建相关路径，
# 改文档/测试不会触发无谓的重建。
#
# 哨兵值必须一起拦：'no-git' 与 'no-tree' 都表示"这次没算出真指纹"。曾经的
# bug 是只拦 no-git，于是 'no-tree' 被当成正常值存下、又在 HEAD 不变时与自身
# 相等，跳过判定被永久锁死（改源码也不重建，便携版永远是旧产物）。宁可在指纹
# 不可用时多构建一次，也不要静默用旧产物。
$fingerprint = Get-SourceFingerprint
$stamp = if (Test-Path $stampPath) { (Get-Content $stampPath -Raw).Trim() } else { '' }
$canDetect = $fingerprint -notmatch '\|no-(git|tree)$'

if (-not (Test-Path $exe)) {
    Write-Host '未检测到已有 release 程序, 开始完整构建。'
} elseif (-not $canDetect) {
    Write-Host '无法取得源码指纹 (非 git 仓库或 git 取树失败), 为稳妥起见执行完整构建。'
} elseif ($stamp -eq $fingerprint) {
    Write-Host "检测到已有 release 程序, 且构建相关源码自上次构建后无变化: $exe"
    Write-Host '跳过构建, 使用现有程序。'
    $needBuild = $false
} else {
    Write-Host '检测到构建相关源码相对上次构建有变化, 自动重新构建...'
    Write-Host "(跳过构建改用旧 exe 的办法: 直接运行 apps\readest-app\scripts\build-portable.ps1 仅组装)"
}

if ($needBuild) {
    Write-Host ''
    Write-Host '[1/2] 开始构建 release 版, 时间较长, 请耐心等待...'
    Write-Host ''
    $buildStart = Get-Date
    & pnpm tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) {
        Write-Host '[错误] 构建失败, 请查看上方错误信息。' -ForegroundColor Red
        Wait-ForUser
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
    Wait-ForUser
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
Wait-ForUser '按回车关闭窗口'
