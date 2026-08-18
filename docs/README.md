# docs 目录索引

本项目文档按主题分子目录存放，统一前缀命名，报告间用相对路径互相引用。

## 子目录职责

| 目录 | 职责 | 命名约定 |
|---|---|---|
| `reports/` | 调试与性能分析报告（时间序列，互为基础引用） | `perf-debug-report-<日期>.md`、`debug-performance-report-<日期>.md`、`debug-report-<日期>.md`、`debug-plan-<日期>.md` |
| `reader/` | 阅读器 UI/交互变更记录（单次改动一份） | `reader-<主题>.md` |
| `research/` | 外部项目分析与工具记录 | 按主题命名 |
| `offline-audit/` | 离线化改造审计过程与结果 | 见其自身 README |

## 报告指针

- `reports/PERF-DEBUG-LATEST.md` 是单行指针文件，内容为最新报告的文件名。
- perf-debug skill（`.claude/skills/perf-debug/SKILL.md`）与锚点 hook（`.claude/hooks/check-anchor.ps1`）依赖此指针做 O(1) 定位；**报告定稿后必须更新它**。
- skill 新报告统一写入 `docs/reports/perf-debug-report-<日期>.md`；当日已有同名报告时加 `-2`、`-3` 后缀。

## 交叉引用规则

- `reports/` 内报告互相引用时用 `reports/<file>.md` 前缀（相对 docs/ 根）。
- 其他目录引用报告同理用 `reports/...`；`offline-audit/` 内容自包含，不经 reports。
