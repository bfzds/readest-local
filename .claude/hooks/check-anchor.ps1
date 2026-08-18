# perf-debug skill 锚点自检 hook（SessionStart）
# 检查两项：① 快照区锚点 HEAD vs 当前仓库 HEAD；② 快照区引用的报告 vs 指针文件/最新报告。
# 有任一过期项时向 stdout 输出提醒（会被注入会话上下文）；全部一致或文件缺失时静默。
# 注意：所有匹配只用 ASCII（HEAD / perf-debug-report-*.md），避免不同 PowerShell 版本/编码下中文失配。
# 契约：本脚本的报告名正则必须与 .claude/skills/perf-debug/SKILL.md §F 命名规则同步
#（含 -2/-3 同日重名后缀与 docs/reports/ 路径）——修改任一处理即同步另一处。
$ErrorActionPreference = 'SilentlyContinue'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$skillPath = Join-Path $repoRoot '.claude\skills\perf-debug\SKILL.md'

if (-not (Test-Path $skillPath)) { exit 0 }

$content = Get-Content $skillPath -Raw -Encoding UTF8
$snapshot = [regex]::Match($content, '(?s)SNAPSHOT-BEGIN.*?SNAPSHOT-END')
if (-not $snapshot.Success) { exit 0 }

$problems = @()

# --- 检查 1：锚点 HEAD ---
$anchor = [regex]::Match($snapshot.Value, 'HEAD[^|]*\|[^|]*([0-9a-f]{7,40})')
$expectedHead = if ($anchor.Success) { $anchor.Groups[1].Value } else { '' }
if ([string]::IsNullOrWhiteSpace($expectedHead)) {
  $problems += '快照区锚点 HEAD 无法解析（SNAPSHOT 区格式异常）'
} else {
  $head = git -C $repoRoot rev-parse --short HEAD
  if ($head -and ($expectedHead -ne $head)) {
    $problems += "锚点 HEAD 过期：快照区 $expectedHead，当前 $head"
  }
}

# --- 检查 2：最新报告（覆盖「HEAD 未变但新报告已出」型过期） ---
$snapReport = [regex]::Match($snapshot.Value, 'perf-debug-report-[0-9-]{10,14}\.md').Value
if ([string]::IsNullOrWhiteSpace($snapReport)) {
  $problems += '快照区最新报告字段无法解析'
} else {
  $pointerPath = Join-Path $repoRoot 'docs\reports\PERF-DEBUG-LATEST.md'
  if (Test-Path $pointerPath) {
    $latest = (Get-Content $pointerPath -Raw -Encoding UTF8).Trim()
  } else {
    # 指针缺失回退：按修改时间取最新的调试报告文件名
    $latest = Get-ChildItem (Join-Path $repoRoot 'docs\reports') -File |
      Where-Object { $_.Name -match '^(perf-debug-report|debug-plan|debug-performance-report|debug-report)-[0-9]{4}-[0-9]{2}-[0-9]{2}(-[0-9]+)?\.md$' } |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1 -ExpandProperty Name
  }
  if ($latest -and ($snapReport -ne $latest)) {
    $problems += "最新报告过期：快照区引用 $snapReport，实际最新 $latest"
  }
}

if ($problems.Count -gt 0) {
  Write-Output ('[perf-debug skill] 画像锚点过期：' + ($problems -join '；') + '。执行性能分析任务前，先按 .claude/skills/perf-debug/SKILL.md 的 A 自检并走 B 刷新快照区（若仅报告指针变化，更新快照区「最新报告」字段即可，见 §B 零增量豁免）。')
}
exit 0
