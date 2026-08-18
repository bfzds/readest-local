# Readest Local Debug 性能调试报告（2026-08-19）

- **日期**：2026-08-19
- **性质**：§A 锚点过期触发 §B 快照刷新 + §D.2 修复型任务（SF12 实测修复）。不提交 git。
- **旧锚点 → 新锚点**：`4cae01a` / perf-debug-report-2026-08-16-2.md / vitest 5555（@d836901 旧值） → `8218a6f` / perf-debug-report-2026-08-19.md / vitest **5630（@8218a6f 实测）**

---

## 1. 基线块（实测 @8218a6f，8-19）

| 日期 | HEAD | 前端文件数 | 用例数(通过) | tsgo | biome | clippy | Rust 单测 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 2026-08-19 | 8218a6f | 421（+1 skipped） | 5630（+10 skipped） | 0 | 2 warnings | 0 | 53 | biome 2 warnings 为他人未提交的 txt-worker 会话测试（ingest-service.test.ts） |

> 前端文件/用例较 §C 旧基线（413/5555）增长，因 4cae01a 之后又有多批提交新增测试。tsgo 0 错、clippy 0 警告、Rust 单测 53 全部实测通过。

## 2. §B 快照刷新摘要

- 锚点 HEAD 从 `4cae01a` 前进到 `8218a6f`（4cae01a 之后又有 10+ 个提交：搜索快捷键重构、命令面板焦点、自绘右键菜单回归修复等），§A 自检判定锚点过期 → 触发本刷新。
- skill §C 快照区——锚点三元组、基线、已修/待修状态表——已随本报告同步更新（回写前重读 §C，无并行覆盖）。

## 3. 本报告修复项

### SF12 page_stat_data 无 TTL（稳态容量，P2）✅ 已修

- **位置**：`src/services/statistics/statisticsDb.ts`（insertPageEvent / recomputeBookTotals）、`src/app/reader/components/ReadingStatsTracker.tsx`（persist）。
- **问题证实（静态核实）**：page_stat_data 以 UNIQUE(id_book, page, start_time) 每（页 × 阅读会话）插入一行，重复阅读的书无限累积；历史报告引用的 recomputeBookTotals 求 SUM/COUNT 依赖全行，但**聚合结果（total_read_time 等）经 grep 证实无真实 UI 消费方**，生产唯一消费 statistics 的是 useMedianPageDurationSecs（只读最近 50 条算中位数）→ 清理旧行安全。
- **修复**：新增 `StatisticsDb.MAX_PAGE_EVENTS_PER_BOOK = 10_000` + `prunePageEvents(idBook)`（COUNT 守卫超限后按 rowid 保留最近 N 条删除更旧）；ReadingStatsTracker.persist 在 recomputeBookTotals 之后调用（低频 flush 路径，不增加翻页 IPC）。
- **test-first**：新失败单测「prunes page events beyond the per-book TTL cap (SF12)」先写并运行确认失败（方法不存在）→ 实现 → 转绿。
- **回归**：statisticsDb.test.ts 16 用例 + src/__tests__/statistics + src/__tests__/app/reader 共 34 文件 271 用例全通过；tsgo 0 错。
- **无可单测载体说明**：无；本项有明显的单测载体。
## 4. 已分析未修（记录，供后续立项）

### SF10 MDict trackedUrls 无界累积（P2，内存）

- **位置**：`src/services/dictionaries/providers/mdictProvider.ts` resolveImageResources(:103 push)、wireMdxAnchors(:364)、resolveCssUrls，accumulate 到 provider 级数组 trackedUrls(:410)，仅 dispose()(:661-670) 统一 revoke。
- **根因**：每次 lookup 为卡片内每张 img 的路径新建 blob URL 并 push 进 trackedUrls，provider 卸载前不回收；同一资源反复查询会反复新建 URL，旧卡片 DOM 移除后其 blob URL 仍滞留数组。
- **方案建议**（未实施，属本轮范围外）：
  1. 图片 blob URL 按路径 key 缓存 + 引用计数，卡片销毁/替换时 revoke 对应的引用（收益大，难度高）；
  2. 参考 sound 锚点已有的 `data-mdd-resolved` 缓存模式：同一路径只建一次 URL，卡片重建时复用并 revoke 上一轮（收益中，难度中）；
  3. 每次 lookup 记录本轮新建 URL，下次 lookup 前 revoke 上一轮（收益中，难度低，但失去跨卡片复用）。
- 因内存类问题难以单测，须按 §D.5 采样方法（长会话反复查词，观察内存/URL 数）做前后对比并声明原因。

### 新5 AdwaitaSelect「键盘导航不可见」（P2，a11y）

- **位置**：`src/components/settings/primitives/AdwaitaSelect.tsx`。
- **复核**：组件已有完整键盘导航（ArrowUp/Down、Home/End、Enter 选、Esc/Tab 关、disabled 跳过）、`data-selected` 视觉、listbox focus、scrollIntoView 定位；有键盘驾驶单测（方向键/Enter/Esc/disabled）。
- **剩余缺口**：为 a11y 细节——键盘移动时选中高亮只更新内部 selectedIndex，未同步 `aria-activedescendant` / 焦点环，读屏与视觉无当前位置反馈。非性能项，暂列低优先级。

## 5. 环境/流程备注

- 本会话文件策略为 danger-full-access、审批 never：前端单测需 esbuild spawn（受限模式拦截 EPERM），已在全访问模式下实测通过。
- biome 2 warnings 位于他人未提交的 ingest-service.test.ts（`'^\\d+、'` 中 \\d 是无效字符串转义 = d，实为 txt 章节正则的潜在真实 bug），与本轮改动无关，按 §D.2.2 不越界修改、仅在报告中声明；建议该工作所有者改为 `'^\\\\d+、'`。
- 跨设备统计同步（applyRemoteEvents/getEventsForPush/getCursor/setCursor）经 grep 证实无生产调用方（仅测试引用），在本地离线分支属死代码，SF12 清理对其无影响。
