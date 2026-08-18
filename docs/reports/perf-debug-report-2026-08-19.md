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
## 4. 已修与待立项记录

### SF10 MDict trackedUrls 无界累积（P2，内存）✅ 已修（提交 9bd34c0）

- **位置**：`src/services/dictionaries/providers/mdictProvider.ts` resolveImageResources(:103 push)、wireMdxAnchors(:364)、resolveCssUrls，accumulate 到 provider 级数组 trackedUrls(:410)，仅 dispose()(:661-670) 统一 revoke。
- **根因**：每次 lookup 为卡片内每张 img 的路径新建 blob URL 并 push 进 trackedUrls，provider 卸载前不回收；同一资源反复查询会反复新建 URL，旧卡片 DOM 移除后其 blob URL 仍滞留数组。
- **已实施（提交 9bd34c0）**：按方案 3 落地——新增 `revokeUrls` 与 `lastRoundUrls`，每次 lookup 前 revoke 上一轮新建的 blob URL（上一张卡片 DOM 已销毁），本轮 URL 同时登记 `trackedUrls` 供 dispose() 兜底；失败/中止路径亦回收本轮 URL。新增单测「revokes previous round blob URLs on a subsequent lookup (SF10)」。
- **残留（收益大但未做）**：方案 1/2 的跨卡片 URL 复用缓存未实施——反复查同一词仍会重新建 URL（复用可省内存但损耗少量收益）；内存类问题难以单测，如需进一步减内存，可用 §D.5 采样法（长会话反复查词观察 URL 数）验证方案 1/2 收益后再立项。

### 新5 AdwaitaSelect「键盘导航不可见」（P2，a11y）✅ 已修（本轮）

- **位置**：`src/components/settings/primitives/AdwaitaSelect.tsx`。
- **复核实况**：组件原有完整键盘导航（ArrowUp/Down、Home/End、Enter 选、Esc/Tab 关、disabled 跳过）、`data-selected` 视觉、listbox focus、scrollIntoView 定位；缺口为键盘移动时仅更新内部 selectedIndex，未同步 `aria-activedescendant` / 焦点环。
- **已修**：`<ul>` 增加 `aria-activedescendant`（指向键盘活动项）、每个 option 稳定 `id`、活动项加 `data-active` + 1px base-content 焦点环（e-ink 兼容）；新增单测验证初始指向已选项、方向键后指向新选项与 `data-active` 切换。

## 5. 环境/流程备注

- 本会话文件策略为 danger-full-access、审批 never：前端单测需 esbuild spawn（受限模式拦截 EPERM），已在全访问模式下实测通过。
- ingest-service.test.ts 的 `'^\d+、'` 无效转义（\d 变字面 d）为本轮修正：生产 `txt.ts` 的规则用 `String.raw`/双反斜杠本就正确，问题只在测试数据示例失真，已将两处改为 `'^\\d+、'`（运行时为 `^\d+、`）。全量 5632 用例通过。
- 跨设备统计同步（applyRemoteEvents/getEventsForPush/getCursor/setCursor）经 grep 复核**确认无生产调用方**（仅测试引用），本地离线分支属死代码；但属 KOReader 兼容的架构级同步协议基础设施，删除需连带 4 方法 + `applyRemoteLock`/`CursorKey` 类型 + `readest_stat_sync_state` 表 + 多处测试，改动面大且非性能项，**本轮决定保留**，建议后续单独立项评估。
