# Readest Local Debug 增量报告（2026-08-15）

- **日期**：2026-08-15
- **分支/HEAD**：`readest-local` @ `d836901`（与 08-15 计划基线一致）
- **性质**：只读复核 + 新提交审查。除本报告外未改任何代码文件；不提交 git。
- **基线**：vitest **5555 通过 / 0 失败**（413 文件，较 08-14 基线 5498 增 57）；tsgo 0 错；biome 0 问题；clippy 0 警告。`packages/tauri` 子模块 146 个 M 经 `git diff --raw` 确认**为空**——纯 Windows autocrlf 行尾伪影，无内容变更，不涉及构建行为。
- **执行内容**：① 复核 08-15 计划 §3.1「已修复」项与 §4 待处理项现状（@d836901）；② 完成计划 §5 全部 8 项「新提交风险点审查」（4 个并行子代理 + 主线程逐条抽查验证）；③ 复核基线。

---

## 1. 项目画像摘要

与 08-14 报告一致：Tauri 2 桌面电子书阅读器（Next.js 16 + React 19 + zustand + foliate-js + Turso/SQLite）。技术栈、模块清单、磁盘占用无变化。本轮不重复，仅记录增量。

**新增信息**：本轮确认基线全绿（5555 用例）；子模块改动为行尾伪影；08-15 计划所列「已修复 40 项」中关键项现状复核通过（见 §3）。

---

## 2. 模块树状图

模块结构较 08-14 报告无变化，不重列。本轮审查涉及文件定位：

```
apps/readest-app/src
├── app/reader/components/sidebar/   SearchBar.tsx（F 键开关）、SideBar.tsx
├── app/reader/components/           BookContextMenuPopup.tsx（自绘右键菜单）
├── components/BookCover.tsx         封面缩略图消费
├── components/settings/primitives/  AdwaitaSelect.tsx（自绘下拉）
├── hooks/                           useSuppressDefaultContextMenu.ts、useShortcuts.ts
├── services/bookService.ts          updateCoverImage
├── utils/                           coverThumbnail.ts、coverThumbnailCache.ts
├── services/librarySearchIndex.ts   SF2（逐节写库无 batch）
├── services/librarySearchService.ts SF3（双窗口建索引无互斥）
└── services/dictionaries/providers/ mdictProvider.ts（SF10）、starDictProvider.ts
```

---

## 3. 缺陷现状复核（@d836901，相对 08-15 计划）

### 3.1 已修复项复核（通过）

| 项 | 证据 |
|---|---|
| NF1 关阅读页 Promise.all 失败隔离 | `page.tsx:548-557` 窗口操作各自 `.catch`，`setLibrary` 必执行 ✅ |
| NF5 view 就绪订阅超时兜底 | `useBooksManager.ts:15,75,100` `READINESS_TIMEOUT_MS=10000` ✅ |
| TF1 bench harness Windows 适配 | `bench/index.ts:38` `import(pathToFileURL(...))` ✅ |
| TF2 turso bench 路径适配 | `bench/library-search-turso.bench.ts:2,47` `fileURLToPath` ✅ |
| B8 关阅读页整库重载（部分缓解） | `page.tsx:726-747` 返回书库走 `hasCachedLibrary` 缓存复用，`library!==libraryBooks` 才 `setLibrary` ✅ |

### 3.2 仍存在项（与计划一致，未处理）

| 编号 | 位置 | 说明 | 计划优先级 |
|---|---|---|---|
| HF2 | `foliate-js/paginator.js:406,3169` | getVisibleRange 整章遍历 | 暂缓（改动风险高） |
| SF2 | `librarySearchIndex.ts:122-123,256` | 逐节 DELETE+INSERT、逐节点 INSERT，无 batch | P1 |
| SF3 | `librarySearchService.ts:373-384` | indexDbs 会话级，无 in-flight 互斥 | P1 |
| SF10 | `mdictProvider.ts:410,662-669` | trackedUrls 无界累积至 dispose 才 revoke | P2 |
| SF12 | `statisticsDb.ts:123-138` | page_stat_data 无 TTL/裁剪 | P2 |
| RF6 | `mobi_parser.rs:74,107` | Mobi::from_path 整文件读 | P2（记录即可） |
| NF10 | `useBooksManager.ts:167` | 换书旧 view `close()` 未 await | P2（低概率竞态） |
| SF14 | `WebSpeechClient.ts:178` 等 | abort 检查已加（部分缓解），长句打断需运行时验证 | P2 |

---

## 4. 新提交风险点审查结论（计划 §5 全 8 项）

> 4 个并行子代理读完整 diff + 测试，主线程抽查验证关键行。结论：**3 项待修（含 5 处真实缺陷）、5 项通过**。

| # | 提交 | 审查对象 | 结论 |
|---|---|---|---|
| 5-1 | `d3f7717`+`71bd891` | 自绘右键菜单 | **待修** 🔴 |
| 5-2 | `e5a3474` | AdwaitaSelect | **待修** 🟠 |
| 5-3 | `d836901`+`f1b65d2` | UI 统一批次 | 通过 |
| 5-4 | `d1bf16e`+foliate `01919e9` | 内存优化批次 | **待修** 🟠 |
| 5-5 | `c9faef5` | F 键搜索栏 + 侧键 | **待修** 🔴 |
| 5-6 | `c781b85` | 划词悬浮窗清理 | 通过 |
| 5-7 | `ee7c96a` | 侧键历史去重 | 通过（次要项见下） |
| 5-8 | `58f38ac` | 搜索高亮遮罩 + 基准 | 通过 |

### 待修缺陷明细（主线程已逐条验证）

**新1【P1，用户可感知】F 键关闭搜索栏后全部快捷键失效** 🔴
- `SideBar.tsx:136-145` `handleHideSearchBar` 只 `setSearchBarVisible(false)`，不 blur；`.search-bar` 用 `visibility:hidden`（`globals.css:313`，非 `display:none`）隐藏不触发失焦 → 搜索 input 保持焦点 → `useShortcuts.ts:42-53` 见 `activeElement.tagName==='INPUT'` 跳过所有快捷键。
- **触发**：固定侧边栏下 F 打开（input 自动聚焦）→ 再按 F 关闭 → F/翻页/全屏全部失效，需 Esc 或点击正文恢复。

**新2【P1，commit 目标未达成】EPUB 正文右键仍弹 WebView2 原生菜单** 🔴
- `useSuppressDefaultContextMenu.ts:19` 只在父 `window` 监听 `contextmenu`；EPUB 正文在 FoliateViewer 的 iframe 内（`FoliateViewer.tsx:450`），`contextmenu` **不跨文档冒泡** → 阅读正文鼠标右键仍弹浏览器原生菜单。
- `BookContextMenuPopup.tsx:84` 打开即 focus 首项，关闭（Esc/点击）无焦点归还，Esc 后焦点落 body。
- 测试缺口：`useSuppressDefaultContextMenu.test.ts` 全在 jsdom body，未覆盖 iframe 文档。

**新3【P1，内存反噬】封面缩略图 object URL 永不 revoke** 🟠
- `coverThumbnail.ts:22` 每个源图 `URL.createObjectURL`；`coverThumbnailCache.ts:35-39`（LRU 驱逐）与 `:43`（clear）只删 key 不 `revokeObjectURL` → 会话内浏览大量封面（每张 512px JPEG 约 30-80KB），内存只增不减，正削弱本批优化目标。
- `coverThumbnailCache.ts` 值类型为 `Promise<T>`，驱逐/clear 时取不到已 resolve 的 URL，需改造记录 URL 值。

**新4【P1，用户可感知】封面缩略缓存无失效，换封面/换源后仍显旧图** 🟠
- `BookCover.tsx:38,45` 缓存 key = `coverSrc`（`coverImageUrl`），Tauri 下为稳定路径 `localBooksDir/<hash>/cover.png`；`bookService.ts:262-274` `updateCoverImage` 覆写**同一文件**，URL 不变 → 缓存永不失效，改封面后库内缩略图保持旧图直至 LRU 驱逐或重启。

**新5【P2，a11y + 误选】AdwaitaSelect 键盘导航不可见** 🟠
- `AdwaitaSelect.tsx:127` `scrollIntoView` 查 `[data-selected="true"]`（由 `value` 驱动），方向键只改 `selectedIndex` 且无任何视觉样式（`:138/:150` 高亮全由 value 驱动）→ 长列表（`CodeHighlightingSettings` 的 CODE_LANGUAGES 37 项）方向键导航无视觉反馈、每次按键列表回滚到 value 项、Enter 选中不可见光标位。
- 次要：trigger 方向键无法展开；`Dropdown.tsx:173` `aria-haspopup='menu'` 与 listbox 语义不符；Space 未绑定；关闭无焦点归还。

### 通过项备注

- **5-3 UI 统一**：btn-contrast 浅/深/e-ink 均反色成对；深色 `text-primary`（#77bbee）可读；e-ink 无 text-primary 覆盖但灰阶仍可读，不构成回归；color-mix 残留均非本批范围且 Chromium111+ 支持。
- **5-7 次要项**：`useBooksManager.ts:138-142` 淘汰 guard 在 `setBookKeys` 前读 currentHash，侧键切回历史头后开新书且历史满时可能跳过释放一本书的解析数据（内存滞留，非状态机错误）。

---

## 5. 性能分析矩阵（按优先级）

| 优先级 | 模块/瓶颈 | 量化影响 | 建议 | 预期收益（估算） | 难度 |
|---|---|---|---|---|---|
| **P0** | F 键关闭后快捷键全失效（新1） | 用户每轮需 Esc/点击恢复，快捷键体系失效 | blur 输入框 | 恢复快捷键 | 低 |
| P1 | 封面 object URL 泄漏（新3） | 长会话每封面 30-80KB 累积 | revoke | 内存停止增长 | 中 |
| P1 | 封面缩略缓存不失效（新4） | 改封面后永久旧图 | 变更处 clear / key 掺 mtime | 正确显示 | 低 |
| P1 | 右键菜单 iframe 未屏蔽（新2） | 正文右键仍弹原生菜单 | iframe 文档内监听 | 达成屏蔽目标 | 中 |
| P1 | SF2 搜索索引逐节 IPC 写库 | 500 节 ≈1,500 次往返 | `batch()` 多值事务 | 1,500→数十次 | 中 |
| P1 | SF3 双窗口并发建索引 | 双倍重建工作 | in-flight 互斥表 | 重建只触发一次 | 中 |
| P2 | AdwaitaSelect 键盘导航（新5） | 长列表键盘误选 | 高亮驱动 selectedIndex | 无鼠标可用 | 中 |
| P2 | SF10 MDict trackedUrls 无界 | 多词典长会话内存增长 | LRU/懒 revoke | 内存有界 | 中 |
| P2 | SF12 page_stat_data 无 TTL | 磁盘逐年增长 | 聚合清理任务 | 磁盘有界 | 中 |
| P2 | RF6 MOBI 整读 | 50-100MB 峰值 | 记录即可 | — | 低 |

---

## 6. P0 优化方案（F 键失焦，附可执行代码）

**问题**：`handleHideSearchBar` 隐藏搜索栏不释放 input 焦点。

**① 修复**（`SideBar.tsx:136-145`，在 setState 前 blur 当前焦点元素）：

```ts
const handleHideSearchBar = useCallback(() => {
  // visibility:hidden 不触发 blur，焦点留在隐藏 input 内会使 useShortcuts
  // 视为"正在输入"而跳过全部快捷键（F/翻页/全屏失效）。先归还焦点。
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  setSearchBarVisible(false);
  setTimeout(() => {
    if (sideBarBookKey) clearSearch(sideBarBookKey);
  }, 100);
  getView(sideBarBookKey)?.clearSearch();
  if (!isSideBarPinned) setSideBarVisible(false);
}, [sideBarBookKey, clearSearch, isSideBarPinned]);
```

**② 验证**：
1. `cd apps/readest-app && pnpm test`（回归，重点 `SearchBar.test` / `useShortcuts.test`）
2. 手动：固定侧边栏 → F 打开搜索栏 → F 关闭 → 立即按 F 应能再打开；按 PageDown 应能翻页。
3. 补单测：`SearchBar.test.tsx` 新增"F 关闭后 `document.activeElement` 不再为 input"断言。

---

## 7. 复测方法与下一步

- **可直接修的 P1（按风险从低到高）**：新4 封面缓存失效（低难度）→ 新1 F 键失焦（已给代码）→ 新3 object URL revoke → SF2 batch 写库 → 新2 iframe 右键菜单 → SF3 互斥。
- **回归要点**：5-1/5-2 涉及键盘/焦点改动，跑 `pnpm test` + 手动键盘走查；5-4 改动涉及 worker，需长会话内存采样确认无增长。
- **明确暂缓**：HF2（getVisibleRange 大改）、RF6、macOS 实机项（RF1/RF9/RF10）。
