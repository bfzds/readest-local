# Readest Local 桌面开发模式启动器（由 启动桌面开发.bat 调用）
#
# 为什么要先查占用：`pnpm tauri dev` 会先跑 beforeDevCommand（`pnpm dev` → `next dev`），
# 前端 dev server 默认监听 3000；而 Next 16 还会拒绝「同一项目里的第二个 dev server」
# ——哪怕它跑在别的端口。端口被占时 tauri dev 会在 beforeDevCommand 阶段直接退出 1，
# 报错信息藏在 cargo 输出里，很难判断根因。所以这里先检查、经用户确认后关闭，再启动。

[CmdletBinding()]
param(
    # 只检查占用情况，不启动 tauri dev（排查用）
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
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
    Write-Host '不关闭它们，pnpm tauri dev 会在启动前端时直接失败。' -ForegroundColor Yellow
    if ($CheckOnly) {
        Write-Host '仅检查模式（-CheckOnly）：未关闭任何进程，也未启动开发模式。'
        exit 0
    }
    # 强杀进程代价大，所以默认是「不关」——必须明确输入 y 才会关闭。
    $answer = Read-Host '关闭以上进程并启动开发模式? 输入 y 回车 = 关闭并启动; 直接回车 = 退出'
    if ($answer -ne 'y' -and $answer -ne 'Y') {
        Write-Host '已取消：未关闭任何进程，也未启动开发模式。'
        Read-Host '按回车退出'
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
    if ($stillUsed.Count -gt 0) {
        Write-Host ''
        Write-Host ("关闭后仍有占用：{0}" -f ($stillUsed -join '；')) -ForegroundColor Red
        Write-Host '请手动结束对应进程（任务管理器）后重新运行本脚本。'
        Read-Host '按回车退出'
        exit 1
    }
    Write-Host '占用已清理。'
    Write-Host ''
} else {
    Write-Host '端口检查通过：3000 / 34567 均空闲，且未发现 next dev 进程。' -ForegroundColor Green
    Write-Host ''
}

if ($CheckOnly) {
    Write-Host '仅检查模式（-CheckOnly）：不启动 pnpm tauri dev。'
    exit 0
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host '未找到 pnpm，请先安装并确保它在 PATH 中。' -ForegroundColor Red
    Read-Host '按回车退出'
    exit 1
}

Write-Host '启动 pnpm tauri dev（首次编译 Rust 可能较久；按 Ctrl+C 结束）...' -ForegroundColor Green
Write-Host ''
& pnpm tauri dev
exit $LASTEXITCODE
