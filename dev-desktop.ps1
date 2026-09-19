# Readest Local 桌面开发模式启动器（由 启动桌面开发.bat 调用）
#
# 为什么要先查占用：`pnpm tauri dev` 会先跑 beforeDevCommand（`pnpm dev` → `next dev`），
# 前端 dev server 默认监听 3000；而 Next 16 还会拒绝「同一项目里的第二个 dev server」
# ——哪怕它跑在别的端口。端口被占时 tauri dev 会在 beforeDevCommand 阶段直接退出 1，
# 报错信息藏在 cargo 输出里，很难判断根因。所以这里先检查、经用户确认后关闭，再启动。
#
# 第二类拦截：**已在运行的阅读器实例**（便携版 readest-local.exe，或上一个 dev 实例）。
# dev 版与便携版共用同一个 identifier `com.local.readest`，tauri-plugin-single-instance
# 按它建命名互斥量：已有实例时，tauri dev 拉起的 Readest.exe 会在启动瞬间
# `std::process::exit(0)`，而 tauri dev 在 Windows 上的收尾退出码是 0xFFFFFFFF，
# pnpm 打印成 `ELIFECYCLE Command failed with exit code 4294967295`。这种失败最难判断：
# 前端编译通过、Rust 编译通过、日志里什么都没有（应用根本没起来），实际只是被顶掉了。

[CmdletBinding()]
param(
    # 只检查占用情况，不启动 tauri dev（排查用）
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

# 双击运行时，未捕获的终止错误会把窗口连同错误信息一起关掉，最后只剩"闪一下"。
# trap 兜住：打印原因、等用户看完、以非 0 退出（这样 .bat 里也能看出失败）。
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
Write-Host '  Readest Local 桌面开发模式 (pnpm tauri dev)'
Write-Host '============================================'
Write-Host ''

# tauri dev 的前端端口：apps/readest-app 的 next dev 默认 3000。
# 34567 是本仓库历史手工调试端口，一并纳入检查，避免两种调试方式互相撞车。
$ports = @(3000, 34567)

function Get-ListenerPids {
    param([int]$Port)
    $pids = @()
    try {
        $pids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
                Select-Object -ExpandProperty OwningProcess -Unique)
    } catch {
        # 受限环境下 Get-NetTCPConnection 不可用 → 回退 netstat -ano 解析
        $pids = @((& netstat -ano 2>$null) |
                Where-Object { $_ -match "^\s*TCP\s+\S+:$Port\s" -and $_ -match 'LISTENING\s+(\d+)\s*$' } |
                ForEach-Object { [int][regex]::Match($_, 'LISTENING\s+(\d+)\s*$').Groups[1].Value } |
                Select-Object -Unique)
    }
    return $pids
}

function Get-ProcessSummary {
    param([int]$ProcessId)
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if (-not $proc) { return $null }
    $cmd = $proc.CommandLine
    if ($cmd -and $cmd.Length -gt 150) { $cmd = $cmd.Substring(0, 150) + '…' }
    [pscustomobject]@{ Id = $proc.ProcessId; Name = $proc.Name; Command = $cmd }
}

# ---- 收集占用者（同一 PID 的多个原因合并显示）----
$entries = New-Object System.Collections.Generic.List[object]

foreach ($port in $ports) {
    foreach ($procId in (Get-ListenerPids -Port $port)) {
        if ($procId -eq $PID) { continue }
        $entries.Add([pscustomobject]@{ Id = [int]$procId; Reason = "占用端口 $port" })
    }
}

# dev server 也可能跑在别的端口上，但 Next 16 仍会拒绝同项目的第二个实例：
# 把这些「命令行像 next dev 的 node 进程」也找出来一起确认。
try {
    $nextDevProcs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object {
                $_.CommandLine -and $_.CommandLine -match '(next[\\/]+dist[\\/]+bin[\\/]+next|\bnext\s+dev\b)'
            })
    foreach ($proc in $nextDevProcs) { $entries.Add([pscustomobject]@{ Id = [int]$proc.ProcessId; Reason = 'next dev 进程' }) }
} catch {
    # 拿不到进程列表（权限等）时不影响后面的端口检查
}

# 已在运行的阅读器实例：dev 版（Readest.exe）与便携版（readest-local.exe）共用
# identifier，任意一个在跑都会把新起的 dev 实例顶掉（见文件头说明）。识别方式取
# 两者之一——进程名，或单实例插件那个隐藏窗口的标题（`<identifier>-siw`，便携版
# 实测其 MainWindowTitle 正是 `com.local.readest-siw`），避免漏掉改名/换皮的实例。
try {
    $readerProcs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
            $_.ProcessName -match '^readest(-local)?$' -or $_.MainWindowTitle -match 'com\.local\.readest-siw'
        })
    foreach ($proc in $readerProcs) {
        if ($proc.Id -eq $PID) { continue }
        $entries.Add([pscustomobject]@{ Id = [int]$proc.Id; Reason = '阅读器实例在运行（单实例互斥会顶掉 tauri dev）' })
    }
} catch {
    # 同上，读不到进程列表时跳过
}

$blockers = @($entries | Group-Object Id | ForEach-Object {
        $first = $_.Group[0]
        [pscustomobject]@{
            Id     = $first.Id
            Reason = (($_.Group | Select-Object -ExpandProperty Reason -Unique) -join '、')
        }
    })

if ($blockers.Count -gt 0) {
    Write-Host '检测到以下进程正在占用开发模式需要的资源：' -ForegroundColor Yellow
    Write-Host ''
    foreach ($blocker in $blockers) {
        $info = Get-ProcessSummary -ProcessId $blocker.Id
        $name = if ($info) { $info.Name } else { '未知进程' }
        $cmd = if ($info -and $info.Command) { $info.Command } else { '(无法读取命令行)' }
        Write-Host ("  PID {0,-7} {1,-14} {2}" -f $blocker.Id, $name, $blocker.Reason)
        Write-Host ("             {0}" -f $cmd) -ForegroundColor DarkGray
    }
    Write-Host ''
    Write-Host '不关闭它们，pnpm tauri dev 会失败（端口冲突在前端启动阶段、阅读器实例在应用启动阶段）。' -ForegroundColor Yellow
    if ($CheckOnly) {
        Write-Host '仅检查模式（-CheckOnly）：未关闭任何进程，也未启动开发模式。'
        exit 0
    }
    # 强杀进程代价大，所以默认是「不关」——必须明确输入 y 才会关闭。
    $answer = Read-Host '关闭以上进程并启动开发模式? 输入 y 回车 = 关闭并启动; 直接回车 = 退出'
    if ($answer -ne 'y' -and $answer -ne 'Y') {
        Write-Host '已取消：未关闭任何进程，也未启动开发模式。'
        Wait-ForUser
        exit 0
    }

    foreach ($blocker in $blockers) {
        try {
            Stop-Process -Id $blocker.Id -Force -ErrorAction Stop
            Write-Host ("已关闭 PID {0}" -f $blocker.Id) -ForegroundColor Green
        } catch {
            Write-Host ("无法关闭 PID {0}：{1}" -f $blocker.Id, $_.Exception.Message) -ForegroundColor Red
        }
    }
    Start-Sleep -Milliseconds 800

    # 复查：仍有端口被占就别带着问题启动，提示用户手动处理。
    $stillUsed = @()
    foreach ($port in $ports) {
        $left = @(Get-ListenerPids -Port $port)
        if ($left.Count -gt 0) { $stillUsed += "端口 $port (PID $($left -join ','))" }
    }
    # 阅读器实例强杀后，进程消失与单实例互斥量释放可能滞后一两秒（本仓库实测：
    # 结束 pnpm 包装进程时它的子进程会存活下来）。给一个短暂的消退窗口再判失败，
    # 避免误报"仍有占用"、把一个本来能跑起来的开发模式挡在门外。
    $leftReaders = @()
    $readerDeadline = (Get-Date).AddSeconds(3)
    do {
        $leftReaders = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
                $_.ProcessName -match '^readest(-local)?$' -or $_.MainWindowTitle -match 'com\.local\.readest-siw'
            })
        if ($leftReaders.Count -eq 0) { break }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $readerDeadline)
    if ($leftReaders.Count -gt 0) { $stillUsed += "阅读器实例 (PID $(($leftReaders | Select-Object -ExpandProperty Id) -join ','))" }
    if ($stillUsed.Count -gt 0) {
        Write-Host ''
        Write-Host ("关闭后仍有占用：{0}" -f ($stillUsed -join '；')) -ForegroundColor Red
        Write-Host '请手动结束对应进程（任务管理器）后重新运行本脚本。'
        Wait-ForUser
        exit 1
    }
    Write-Host '占用已清理。'
    Write-Host ''
} else {
    Write-Host '检查通过：3000 / 34567 空闲、无 next dev 进程、无在运行的阅读器实例。' -ForegroundColor Green
    Write-Host ''
}

if ($CheckOnly) {
    Write-Host '仅检查模式（-CheckOnly）：不启动 pnpm tauri dev。'
    exit 0
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host '未找到 pnpm，请先安装并确保它在 PATH 中。' -ForegroundColor Red
    Wait-ForUser
    exit 1
}

Write-Host '启动 pnpm tauri dev（首次编译 Rust 可能较久；按 Ctrl+C 结束）...' -ForegroundColor Green
Write-Host ''
& pnpm tauri dev
$exitCode = $LASTEXITCODE
# 非 0 退出必须留痕：tauri dev 的失败可能发生在 beforeDevCommand（前端端口冲突）、
# 应用启动（单实例互斥顶掉，退出码是 0xFFFFFFFF）等阶段，窗口一关就什么都看不到。
if ($exitCode -ne 0) {
    Write-Host ''
    Write-Host ("[错误] pnpm tauri dev 以退出码 {0} 结束。" -f $exitCode) -ForegroundColor Red
    Wait-ForUser
}
exit $exitCode
