# Readest Local Debug 快照刷新报告（2026-08-16，第二份）

- **日期**：2026-08-16
- **性质**：§B 快照刷新记录（有实质变化：HEAD 前进、第三批 6 项缺陷已修、基线更新、docs 目录重组）。不提交 git。
- **旧锚点 → 新锚点**：`d836901` / perf-debug-report-2026-08-16.md / vitest 5555 → `4cae01a` / perf-debug-report-2026-08-16-2.md / vitest **未实测（沿用 5555 @d836901）**
- **§D 修订声明**（§B 第 5 步要求）：docs/ 目录被重组为 reports/ reader/ research/ offline-audit/ 子目录（见 docs/README.md），skill 与 hook 中所有 `docs/` 报告路径已修订为 `docs/reports/`，§A 增加「指针与报告均未找到时读 docs/README.md 索引」兜底。

---

## 1. 基线块

| 日期 | HEAD | 前端文件数 | 用例数(通过) | tsgo | biome | clippy | Rust 单测 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 2026-08-15 | d836901 | 413 | 5555 | 0 | 0 | 0 | 53 | 最新实测基线；4cae01a 后未重跑，修复型任务前须实测 |

## 2. 变更摘要

### 2.1 第三批修复（4cae01a，448 行新增 / 6 个新测试文件）
| 编号 | 缺陷 | 抽查证据 |
|---|---|---|
| 新1 | F 键关搜索栏后快捷键全失效 | `focus.ts` 新增 `blurActiveElement()`；`SideBar.tsx:143` 已调用 ✅ |
| 新2 | EPUB iframe 内右键弹原生菜单 | `iframeEventHandlers.ts` + `FoliateViewer.tsx` 改动（--stat） ✅ |
| 新3 | 封面 object URL 不 revoke | `coverThumbnailCache.ts` 新增 `revoke` 回调（release 时回收）；`coverThumbnail.ts:55` `revokeObjectURL` ✅ |
| 新4 | 封面缩略缓存无失效 | `BookCover.tsx` + `bookService.ts` 改动 ✅ |
| SF2 | 搜索索引逐节 IPC | `librarySearchIndex.ts` +25 行批量写 ✅ |
| SF3 | 双窗口建索引无互斥 | `searchIndexLock.ts` 新增：createDir 原子锁 + mtime 陈旧接管 ✅ |

### 2.2 剩余待修
P2：新5（AdwaitaSelect 键盘导航）、SF10（MDict trackedUrls）、SF12（page_stat_data TTL）、RF6（MOBI 整读）。
暂缓：HF2（getVisibleRange）、macOS 实机项（RF1/RF9/RF10）。

### 2.3 目录重组
docs/ 旧报告移动至 `docs/reports/`；指针 `docs/reports/PERF-DEBUG-LATEST.md`；命名规则见 docs/README.md。

## 3. 备注

- **基线纠错**：本报告初稿曾把 offline-audit/task9（2026-08-11 采集）的 vitest 396/5520 误当作 4cae01a 之后的新基线并标注「8-16 实测」——经时间戳核实为旧数据，已回滚为 8-15 报告实测值（413/5555 @d836901），并诚实标注「4cae01a 后未实测」。skill §E 已新增「基线采集时间必须 ≥ 锚点 HEAD 提交时间」的校验规则。
- 本轮执行中 skill 的 §B 第 3 步（回写前重读、合并而非覆盖）真实触发：编辑时检测到文件被并行会话修改，重读后按规则只补做未完成部分。
- 事实源路径漂移（docs/ → docs/reports/）是本轮暴露的 skill 结构性风险，已通过 README 索引兜底 + 路径修订缓解。
