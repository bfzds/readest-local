# Readest Local 系统性调试与性能分析报告（2026-08-13）

- **日期**：2026-08-13
- **分支**：`readest-local`
- **方法**：静态代码审查（第一手验证）+ 4 个并行子代理分模块深挖（阅读器渲染/翻页、导入/解析、搜索/数据库、书架/窗口）+ 实机已知数据交叉核对
- **范围**：桌面端本地小说阅读器（Tauri 2 + Next.js 16 + React 19 + foliate-js + Turso/SQLite），纯本地离线分支
- **性质**：本次为**只读调研**，未修改任何代码文件

> 既有基线：`docs/debug-report-2026-08-13.md`（上轮系统调试，4 个问题全部闭环）、`docs/performance-overhead-2026-08-11.md`（架构估算）。本报告在此基础上做**深度性能分析**并复核全部已知 bug 现状，新增多个此前未记录的缺陷。

---

## 目录

1. [摘要](#摘要)
2. [Bug 汇总](#bug-汇总)
3. [性能排名（从高到低）](#性能排名从高到低)
4. [瓶颈分析](#瓶颈分析)
5. [优化方案清单](#优化方案清单)
6. [需要增加的性能埋点](#需要增加的性能埋点)
7. [本次调试涉及的改动文件](#本次调试涉及的改动文件)

---

## 摘要

对核心阅读、导入解析、全文搜索、书架渲染、窗口生命周期五个模块做了系统性检查。**上轮 4 个 bug 全部确认仍处于修复状态**（含 Alt+F4 无窗口兜底、web 白屏守卫等）。

**本次新发现缺陷 12 项**，其中严重 3 项、一般 4 项、轻微 5 项：

- **严重 · 搜索索引重建风暴**：阅读进度写入与索引新鲜度判定共用 `updatedAt` 字段，任何读过的书下次搜索必被判定过期、当场整本重建索引（高严重 bug 兼最大性能瓶颈）。
- **严重 · reader 换书内存泄漏**：复用 reader 窗口内换书生成新 viewState key，旧 key 及其 FoliateView（renderer+iframe+DOM）永不释放，长会话内存单调增长。
- **严重 · 看门狗杀僵尸后 main 不唤醒**：崩溃看门狗 `destroy()` 僵尸 reader 后不触发 `close-reader-window`，若书库正处于 Plan A 隐藏态则永远无可见窗口（Alt+F4 兜底覆盖不到此路径）。
- **一般 · 每页翻页级联重渲**：`setProgress → updateBookProgress(O(n) 全库拷贝) → 无 selector 订阅 → Reader 整树重渲`，每翻一页叠加一次全树重渲。
- **一般 · foliate-js 两处逻辑缺陷**：`view.js` mediaOverlay 高亮 `find()` 误用赋值（恒取首个文档）；`paginator.js` 指针拖选翻页为恒 false 死代码。

**性能结论**：导入路径已高度优化（Rust 原生解析 + 大文件直拷 + 分批并发 + 懒读），**真正大头集中在三处**：①全文搜索索引惰性构建与重建风暴；②长章节整章 CSS 多栏一次性布局 + 每翻一页整章矩形遍历；③翻页热路径上的 React 级联重渲。双窗口 ~700–970MB 内存主要来自 WebView2 多进程 + reader 侧 viewStates 泄漏 + 禁用后台节流。

---

## Bug 汇总

### 严重

#### B1. 搜索索引重建风暴（阅读即打脏索引）——[已验证]

| 维度 | 内容 |
|---|---|
| **现象** | 读过一本书后再次执行全文搜索，该书被判定索引过期，搜索过程中整本重建（解压 + 逐节建 DOM + 逐节写库 + 再匹配），搜索显著变慢；1000 本书场景被无限放大 |
| **触发条件** | 任何一次阅读进度写入之后，对该书发起搜索 |
| **影响范围** | 全文搜索延迟；频繁阅读 + 搜索的用户最严重；索引写入与搜索在同一请求内完成，主线程被长任务阻塞 |
| **根本原因** | `updatedAt` 双语义冲突：`libraryStore.ts:116 updateBookProgress` 每次进度更新写 `book.updatedAt = Date.now()`；而 `librarySearchIndex.ts:83 isSearchIndexFresh` 要求 `meta.updatedAt === book.updatedAt` 才认为索引新鲜。阅读进度是"最近访问"，文件内容是"版本"，两者被塞进同一字段 → 进度一更新，内容索引必然判脏 |
| **建议修复** | ① 内容版本改用文件 `mtime`/大小/hash（`getBookFileSize`/`computeCoverHash` 已有等价物），与"最近访问"时间戳分离；② 索引新鲜度只依赖内容版本，阅读进度不再使索引失效。改动集中在 `libraryStore.updateBookProgress` 与 `isSearchIndexFresh` 两处 |

#### B2. reader 复用窗口内 viewStates 无界增长（内存泄漏）——[已验证]

| 维度 | 内容 |
|---|---|
| **现象** | 长会话内多次换书，内存单调增长；是双窗口 700–970MB 高内存的主要来源之一 |
| **触发条件** | 在复用 reader 窗口内连续打开多本书（每次 `open-book` 走 Plan A 原地换书） |
| **影响范围** | 常驻内存持续上升，极端会话可能触发 GC 压力与卡顿 |
| **根本原因** | `useBooksManager.ts:139 openBookInReader` 换书时生成新 key（`${hash}-${uniqueId()}`）并 `initViewState(newKey)`，但**不清理旧 key**；`clearViewState`（`readerStore.ts:138`）仅在显式关闭（`ReaderContent.tsx:210`）与编辑重存（`FoliateViewer.tsx:939`）路径调用。旧 viewState 持有的 FoliateView（renderer + iframe + 整章 DOM）因硬引用无法被 GC。`bookDataStore` 有 `MAX_HISTORY=3` 剪枝，viewStates **没有等价剪枝** |
| **建议修复** | 换书时先 `clearViewState(旧 key)` + `view.close()/remove()`；或按 `bookKeys` 对 viewStates 做定期剪枝（与 bookDataStore 的 `MAX_HISTORY` 同策略）。新增回归测试断言换书后旧 viewState 被清 |

#### B3. 崩溃看门狗销毁僵尸 reader 后不唤醒书库窗口——[已验证]

| 维度 | 内容 |
|---|---|
| **现象** | reader 渲染进程崩溃（"空白窗口"症状）时，看门狗 20s 后销毁 reader；若书库此时处于 Plan A 隐藏态，**销毁后无任何可见窗口，进程残留**，与历史 Alt+F4 bug 同症状 |
| **触发条件** | reader 窗口 renderer 崩溃（心跳停止 ≥20s）且书库处于隐藏状态（读者在读书时） |
| **影响范围** | 窗口管理可靠性；用户只能任务管理器杀进程 |
| **根本原因** | `readerWindowWatchdog.ts:37-38` 对超时 reader 直接 `win?.destroy()`，**不 emit `close-reader-window`**，也不检查/唤醒 main。page.tsx:533-535 的 Alt+F4 兜底只挂在事件路径上，看门狗绕过了它 |
| **建议修复** | 看门狗 destroy 后调用 `ensureMainLibraryWindow()`（或 `getCurrentWindow().show()`），与 Alt+F4 路径共用同一唤醒逻辑。建议与 B1/B2 一并补 e2e 或单测 |

### 一般

#### B4. 每页翻页整棵 reader 树级联重渲——[已验证]

| 维度 | 内容 |
|---|---|
| **现象** | 翻页动画期间每帧 `setProgress` 触发整棵 reader React 树重渲，动画掉帧 |
| **触发条件** | paged 模式翻页（翻页动画 ~300ms，期间每帧一次 `setProgress`） |
| **影响范围** | 翻页帧率；长章节 + 复杂 UI 时最明显 |
| **根本原因** | 链路：`FoliateViewer` rAF 合帧 `setProgress` → `readerStore.setProgress:423` → `libraryStore.updateBookProgress`（`libraryStore.ts:118-122` 每次 O(n) `slice`+`filter` 全库拷贝）→ `useLibrary`（`src/hooks/useLibrary.ts:8`，无 selector 订阅整个 store）→ `Reader.tsx:51` 重渲 → `ReaderContent` 未 memo → 全树。同时 `readerStore.setProgress:430` `bookDataStore.setState` 每页写入（isPrimary 时）→ 约 30 处 `useBookDataStore()` 无 selector 订阅点全部重渲。reader 窗口内 `updateBookProgress` 的库更新本无人消费，纯浪费 |
| **建议修复** | ① 每页 `setProgress` 改为只写 `readerProgressStore`，跳过 `updateBookProgress`（或节流到章节切换/退出时才同步库）；② 全站按 `readerProgressStore.ts:40-45` 注释的 per-field selector 规范改造，优先 `useLibrary`、page.tsx 及 ~30 处 bookDataStore 解构 |

#### B5. foliate-js mediaOverlay 高亮指向错误文档——[已验证]

| 维度 | 内容 |
|---|---|
| **现象** | 有声书/媒体覆盖层高亮（`highlight` 事件）落在错误的 section 文档上，高亮不跟随旁白 |
| **触发条件** | 打开含 `mediaOverlay` 的书并播放媒体覆盖层 |
| **影响范围** | 有声书跟随朗读的高亮位置错误（功能缺陷，非崩溃） |
| **根本原因** | `packages/foliate-js/view.js:289`：`.find(x => x.index = resolved.index)` 用 `=` 赋值而非 `===`，返回 `resolved.index`（恒 truthy 数字），`find` 恒取**第一个** content，解构出的 `doc` 恒为首个文档 |
| **建议修复** | 改为 `find(x => x.index === resolved.index)`，并补该分支的测试 |

#### B6. foliate-js 指针拖选翻页死代码——[已验证]

| 维度 | 内容 |
|---|---|
| **现象** | 长按拖选接近页边时自动翻页的功能永不触发（注释"暂时禁用"，但写法使其**永久**失效） |
| **触发条件** | 无（恒不可达） |
| **影响范围** | 已禁用的功能继续禁用；属逻辑缺陷，若未来想启用需重写条件 |
| **根本原因** | `packages/foliate-js/paginator.js:1557`：`if (!isPointerSelecting && isPointerSelecting ...)` 恒为 false |
| **建议修复** | 明确删除该分支或按注释意图重写为有效条件 |

#### B7. 双窗口并发重建同一 search.db 竞态——[隐患，代码路径确认]

| 维度 | 内容 |
|---|---|
| **现象** | 书库页与阅读器窗口同时搜索时可能读到半成品索引或 SQLITE_BUSY |
| **触发条件** | 两窗口对同一本书并发执行首次搜索（均触发惰性建索引）；或一窗重建、一窗读 |
| **影响范围** | 搜索结果不完整/失败；罕见但不稳定 |
| **根本原因** | Turso WAL 写锁竞争；`completeSearchIndex`（`librarySearchIndex.ts:130-133`）置 1 与逐节写入可能交错，`isSearchIndexFresh` 见到 `complete=1` 但内容只写了一半 |
| **建议修复** | 建索引加进程内互斥（同一 `book.hash` 只允许一个构建任务）；写入完成置 `complete=1` 与 `wal_checkpoint` 串行化 |

#### B8. reader 关闭时书库窗口全量重载——[已验证]

| 维度 | 内容 |
|---|---|
| **现象** | 关闭阅读页时书库明显卡顿（数千本书时最明显） |
| **触发条件** | 任意一次 reader 关闭（`close-reader-window` 事件） |
| **影响范围** | 关闭阅读页的响应延迟 |
| **根本原因** | `page.tsx:519-548` 每次 `close-reader-window` 都 `loadSettings + loadLibraryBooks + setSettings + setLibrary`；`setLibrary` 触发 `refreshGroups`（O(n) MD5）与整个书架子树重渲 |
| **建议修复** | 改为增量刷新：只重新加载发生变化的数据（如进度/阅读状态），不整库重读；或比较磁盘与内存差异后局部更新 |

### 轻微

| 编号 | 现象 | 位置 | 建议 |
|---|---|---|---|
| B9 | `open-book` 事件在 reader 窗口刚重建、监听未注册时丢失（`emitTo` 无 catch），复用路径依赖 warm 窗口 | `src/utils/nav.ts:67` | `emitTo` 加 `.catch` 与重试/降级（回退 URL 参数）；窗口很小，属边缘竞态 |
| B10 | 阅读器搜索结果对每个结果急切 `resolveSearchResultCfis`（重新开书逐节走 DOM 造 Range）；库页却是点击才懒解析 | `SearchBar.tsx:233-248` vs `LibrarySearchResults.tsx:358` | 统一为懒解析，或在索引里直接存 CFI |
| B11 | EPUB manifest href 含百分号编码（如 `%20`）时，Rust sizes map 未命中，JS 退回 zip.js 开包（仅性能损失非错误） | `src-tauri/src/epub_parser.rs:315` | 两侧统一 URL-decode 键 |
| B12 | 键盘焦点导航 `#scrollToAnchor` 对每个节点写内联 `tabIndex/outline`，长期累积 DOM 属性 | `packages/foliate-js/paginator.js:3108` | 导航结束后清除 |
| B13 | 窗口销毁/监听多处无 `.catch`（潜在 unhandled rejection）；`tauriQuitApp` 的 `exit(0)` 不等 async 保存完成 | `window.ts:83/182`、`ReaderContent.tsx:172` | 补 `.catch`；退出前 flush 保存 |
| B14 | 搜索会话内最多 16 个 DB 句柄，WAL 仅 `session.close()` 才 checkpoint，长期驻留期间 `search.db-wal` 不折叠，书目录文件级拷贝会漏数据 | `librarySearchService.ts:409` | 空闲时定期 checkpoint |
| B15 | `GroupItem` 的 `setTimeout` 卸载后未清理（卸载后仍触发 `scrollLeft`） | `GroupItem.tsx:52-55` | effect 清理 |
| B16 | MOBI 解析整文件读入 Rust 堆（50–100MB MOBI 峰值 ≈ 文件大小） | `src-tauri/src/mobi_parser.rs:74` | 自实现 PalmDB 头解析只读所需记录；大文件降级 |

### 已闭环验证（上轮修复在本次代码中确认仍在）

| 项 | 状态 |
|---|---|
| Alt+F4 关 reader 后无窗口（main 被隐藏） | ✅ 已修复：`page.tsx:533-535` `show()+unminimize()+setFocus()` 兜底 |
| reader 崩溃空白窗口 | ✅ 新增 `readerWindowWatchdog` 兜底（见 B3 残留死角） |
| web/浏览器模式白屏 | ✅ `nativeAppService` 守卫 + EnvProvider 提示界面（`__TAURI_INTERNALS__` mock） |
| `library-search-ssr.test.ts` 冷启动 flaky | ✅ 显式 30s 超时 |
| README 与 web e2e lane 不符 | ✅ 已同步 |

### 未复现但存在隐患（单独标注）

- **B3**（看门狗杀僵尸后 main 不唤醒）：需 renderer 崩溃场景，本机未实机注入崩溃复现；代码路径与事件监听均确认缺口存在。
- **B7**（双窗口并发重建 search.db）：需两窗口同时首搜同一本未建索引的书，时序窗口窄；竞态条件在代码层成立。
- **B9**（open-book 事件丢失）：依赖窗口重建与监听注册的时序，概率极低；`emitTo` 无错误处理是确定事实。
- **B12/B15**：DOM 属性累积与定时器泄漏均属"量变到质变"，单次不可观测。

---

## 性能排名（从高到低）

综合时间、内存、CPU 三维度，按**综合开销从高到低**排序（具体分维度评估见 [瓶颈分析](#瓶颈分析)）：

| 排名 | 功能模块 | 综合开销特征 | 主维度 |
|---|---|---|---|
| **1** | **全文搜索与索引** | 读过就重建（重建风暴）+ 惰性建索引内联进搜索 + 逐节串行 IPC 写库（500 节 ≈ 1500 次 Rust 往返）+ 急切 CFI 重解析 + 结果列表无虚拟化、无全局上限 | 时间为主，内存次之 |
| **2** | **长章节渲染与分页** | 整章 CSS 多栏一次性布局（几十万字主线程冻结数百 ms–1s）+ 每翻一页 TreeWalker 遍历整章 + 每节点 `getBoundingClientRect`（长章节 10–20ms/页）+ **无分页结果缓存**（字号/主题/resize 均整章重排） | CPU/时间 |
| **3** | **翻页热路径 React 级联** | 每帧 `setProgress → updateBookProgress(O(n) 全库拷贝) → Reader 整树重渲` + bookDataStore ~30 处订阅者重渲 | CPU/时间 |
| **4** | **书籍导入/解析** | EPUB 已优化（<0.5s/100MB）；**MOBI 整文件读堆**（50MB ≈ 数百 ms + 100MB 内存）；大文件 `copyFile` 失败回退 `arrayBuffer()` 整文件进 webview；封面 canvas 重编码 | 时间/内存 |
| **5** | **首开导航构建** | `computeBookNav` 冷构建全书最大单点：200 节书 ~300–500ms（已持久化 nav.json 缓存；dev 不命中缓存） | 时间 |
| **6** | **字号/主题/字体切换** | 每次变更：整章重排 + `overlayer.redraw` 重建全部标注 + 2 类文件各写 2 次（.bak+主）+ 跨窗口广播；global 遍历全部 bookKeys；设置面板滑块无节流（滚轮已 120ms throttle） | 时间 |
| **7** | **书架列表与分组** | `sortedBookshelfItems` 全组排序（作者分组数千本→数百组）+ `refreshGroups` O(n) MD5 + 关闭阅读页全量重载 + 双窗口各持完整 library 数组副本 | CPU/内存 |
| **8** | **多窗口内存与后台节流** | 双窗口 ~700–970MB：WebView2 每窗口带多渲染进程 + reader 侧 viewStates 泄漏（B2）+ `background_throttling(Disabled)`（`lib.rs:346`）隐藏窗口仍全速渲染 + 8 节预载整章 iframe | 内存 |
| **9** | **scrolled 滚动模式** | 每翻一页 `snapScrolledDistanceToLines` 取整节 `getClientRects()` 再排序（O(总行数)）；`#detectPrimaryView` 每 settle 遍历 views 量矩形 | 时间 |

---

## 瓶颈分析

### 1. 全文搜索与索引（综合开销最高）

- **最大瓶颈点**：`librarySearchService.ts:627` 新鲜度判定 + 惰性建索引 live path（`690-814`）。
- **开销原因**：
  - `updatedAt` 双语义（B1）导致任何读过的书每次搜索都整本重建：解压 → 逐节 `parseFromString` 建 DOM → 逐节 `DELETE+INSERT`（`librarySearchIndex.ts:102-116`）→ 匹配，全部内联在一次搜索请求内，主线程长任务。
  - 逐节/逐节点**串行 IPC** 写库：500 节 + 500 TOC 节点 ≈ 1500 次 Rust 往返（无 `batch()` 事务）。
  - 每本一次 DB open 扇出：会话最多缓存 16 句柄（`MAX_OPEN_INDEX_DBS=16`），千本场景每本 openDB→读 meta→LIKE 预筛→匹配；bench 实测单本 open 即 ~1.6ms 主导（1000 本 ≈ 4.8s）。
  - TOC 节点构建 O(n²)：`librarySearchIndex.ts:213-220` 内层线性扫找下一同级节点，2000 章 ≈ 200 万次。
- **可量化优化建议**：
  1. 内容版本与最近访问分离（修 B1）→ 消除重建风暴，读完再搜命中缓存。
  2. 建索引批量 `batch()` 事务 + 多值 INSERT → 1500 次往返降至数十次。
  3. TOC 构建改单遍栈（O(n)）。
  4. 合并为单一库按 `book_hash` 分表，摊薄 open 成本。
  5. contains 匹配迁入 Web Worker（与 fuzzy/nearby 对齐，`librarySearchWorker.ts:46`）。
  6. 结果加全局 cap + 虚拟列表。

### 2. 长章节渲染与分页

- **最大瓶颈点**：`paginator.js` CSS 多栏整章一次性布局（`columnize`，paginator.js:811）；`getVisibleRange`（paginator.js:406-474）。
- **开销原因**：
  - 引擎对整章做 multicol 布局，单章几十万字主线程冻结数百 ms–1s；字号/主题/容器 resize 每次整章重排，**无分页结果缓存**。
  - 每翻一页 `#afterScroll → #getVisibleRange` 用 TreeWalker 遍历**整个 primary 章节 body**，每个元素先 `getBoundingClientRect` 再判可视，视口之上的全部节点都要过（读第 50 页时 ~前 50 页节点各做一次 layout read），长章节每翻一页约 2000–5000 次矩形读取（~10–20ms）；随后 `view.js#onRelocate` 再算 `getCFI`。
  - 单 iframe 被撑成超宽层触发 GPU 贴图上限，已有 20000px 阈值规避（paginator.js:349）。
- **可量化优化建议**：
  1. 缓存可见范围：从上一锚点双向扩散，而非每次从头遍历；仅对视口邻近节点量矩形。
  2. 缓存 `contentPages`/分栏结果，按内容 hash 失效。
  3. 超长章节按 `mbp:pagebreak` 式锚点切片为多个段落容器。
  4. 字号步进改 CSS `zoom` 合成缩放（已有 `imageScale`）避免整章重排。

### 3. 翻页热路径 React 级联

- **最大瓶颈点**：`readerStore.setProgress:423 → libraryStore.updateBookProgress`（libraryStore.ts:105-124）→ `useLibrary`（无 selector）→ Reader 整树重渲。
- **开销原因**：每次进度更新做 O(n) `slice` + `filter` 全库拷贝；`Reader.tsx:51` 通过无 selector 的 `useLibrary` 订阅整个 libraryStore；reader 窗口内该库更新本无消费方（纯浪费）。`bookDataStore.setState`（isPrimary 时）每页写入触发 ~30 处无 selector 订阅点重渲。
- **可量化优化建议**：
  1. 翻页热路径 `setProgress` 跳过 `updateBookProgress`，仅写 `readerProgressStore`；库同步节流到章节切换/退出。
  2. 全站 per-field selector 化（优先 `useLibrary`、page.tsx、bookDataStore 订阅点）。
  3. `ReaderContent` 的 `onCloseBook`/`onGoToLibrary` 用 `useCallback` 稳定化，恢复 `BookCell`/`BooksGrid` 的 `React.memo` 击穿。

### 4. 书籍导入/解析

- **最大瓶颈点**：MOBI 整读（`mobi_parser.rs:74` `Mobi::from_path` 整文件进 Rust 堆）；`copyFile` 失败回退 `arrayBuffer()`（整文件进 webview）；封面 canvas 重编码。
- **开销原因**：MOBI6 初始化整本 text 记录载入 + `rawBytesToString` + 正则分章（50MB 首开数百 ms + 100MB 内存，mobi.js:690）；大文件回退路径使内存翻倍。
- **现状（已优化，勿重复投入）**：EPUB 走 Rust `spawn_blocking` + zip 中央目录（100MB 峰值 <50MB、<0.5s）；PDF 用 `PDFDataRangeTransport` + 并发 6 范围流式解析（DPR≤2 像素预算防 OOM）；目录扫描走 Rust 离线 `read_dir`；批量导入 ≤4 并发/256MB 在途；`safeSaveJSON` 批量结束才全量写盘。
- **可量化优化建议**：
  1. MOBI 自实现 PalmDB 头解析只读所需记录，大文件降级。
  2. `copyFile` 失败回退改分块流式写入（避免整文件 arrayBuffer）。
  3. 封面 `downscaleImageBlob` 限制解码上限（web 端中端机尤其）。
  4. `computeCoverHash`（`bookService.ts:702`）随封面写入顺带算，省一次 IPC+IO。

### 5. 首开导航构建

- **最大瓶颈点**：`computeBookNav`（`readerStore.ts:240`）冷构建——200 节书 ~300–500ms。
- **开销原因**：每节 `loadText` + `createDocument` 双解析（`nav/index.ts:178-183`），`parseFromString` 主线程串行 CPU-bound；nav/fragments.ts 每 fragment `new Blob([content.substring(...)])` 整段复制 + 全 HTML 正则扫描（O(N×fragment)）。
- **可量化优化建议**：
  1. 已持久化 nav.json 缓存，**生产环境已命中**（dev 不命中属预期）；确认 release 体验即可。
  2. 片段生成改用偏移量差替代 substring+Blob，正则改单遍索引。
  3. 剩余解析可下放 Web Worker。

### 6. 字号/主题/字体切换

- **最大瓶颈点**：`saveViewSettings`（`settings.ts:56-107`）+ `setStyles`（paginator.js:3740）+ `overlayer.redraw`（overlayer.js:149）。
- **开销原因**：每次变更重建整张样式串 `getStyles` → 改所有 view 的 `<style>` → 整章 `columnize` 重排 + `expand` + overlayer 重建全部标注矩形 + 重锚定；global 模式遍历全部 bookKeys 逐个应用并 `safeSaveJSON` 写盘两次（.bak+主）；主题切换由 `FoliateViewer.tsx:818` effect 驱动同一路径；设置面板滑块无节流。
- **可量化优化建议**：
  1. 设置面板滑块也套 120ms throttle（与滚轮对齐）。
  2. `safeSaveJSON` 改单写 + 定时备份。
  3. 非 primary 书只刷样式不落盘。
  4. 主题 effect 拆分，仅差异字段局部更新（不整章重排）。
  5. overlayer 增量重绘，仅在相关 view/字号变化时。

### 7. 书架列表与分组

- **最大瓶颈点**：`sortedBookshelfItems` 全组排序（Bookshelf.tsx:354-453）+ `refreshGroups` O(n) MD5 + `close-reader-window` 全量重载（B8）。
- **开销原因**：作者/系列分组对每组全量排序（数千本→数百组），groupBy/sort/library 变更即重算；`recentBooks` O(n log n)；每次关闭阅读页全量重读+重渲；双窗口各持完整 library 数组副本。
- **可量化优化建议**：
  1. 分组结果按 `groupBy+books` 引用 memo（导航不再重复 `createBookGroups`）。
  2. 关闭阅读页改增量刷新（B8 修复）。
  3. 作者分组结果缓存（历史已提交 `d5161c3` 修 author-group 返回导航，方向一致）。

### 8. 多窗口内存与后台节流

- **最大瓶颈点**：WebView2 多进程架构 + viewStates 泄漏（B2）+ 后台节流禁用。
- **开销原因**：Plan A 已避免窗口数量增长，但双窗口各带多个 `msedgewebview2` 渲染进程（实测 7 个）；`background_throttling(Disabled)`（`lib.rs:346`）使隐藏 reader 仍全速渲染（为保心跳与进度保存）；reader 每 3s 心跳（ReaderContent.tsx:160-163）在隐藏窗口也持续触发。
- **可量化优化建议**：
  1. 修复 B2（viewStates 剪枝）是最高杠杆。
  2. 心跳间隔放宽（3s→10s+）或仅在窗口可见时发，配合看门狗超时调整。
  3. 隐藏窗口可临时 `setBackgroundThrottling` 或降低渲染预算；或在隐藏态暂停预载（`#trimDistantViews` 加强）。

### 9. scrolled 滚动模式

- **最大瓶颈点**：`snapScrolledDistanceToLines`（usePagination.ts:55-116）整节 `getClientRects()` + 排序。
- **开销原因**：取**整节所有行盒**（含屏外）再排序，scrolled 模式每翻一页 O(总行数)；`#detectPrimaryView`（paginator.js:3194）每 settle 遍历 views 各做 rect 读。
- **可量化优化建议**：只取视口附近行盒；缓存行高按步长推算；view 尺寸缓存失效才重算。

---

## 优化方案清单

按**性价比**排序（先修"白做功 + 高杠杆"，再补"低风险收益项"）：

### P0 —— 消除"每次都在白做功"的缺陷（修复即性能提升）

| 优先级 | 措施 | 涉及 | 预期收益 |
|---|---|---|---|
| P0-1 | **修 B1 搜索重建风暴**：内容版本与最近访问分离 | `libraryStore.ts:116`、`librarySearchIndex.ts:83` | 读过的书搜索不再整本重建；千本场景搜索延迟从秒级回落 |
| P0-2 | **修 B2 viewStates 泄漏**：换书清理旧 key + 定期剪枝 | `useBooksManager.ts:139`、`readerStore.ts` | 长会话内存不再单调增长；700–970MB 中读侧部分回收 |
| P0-3 | **修 B3 看门狗唤醒 main** | `readerWindowWatchdog.ts:37` | 消除崩溃场景的无窗口残留（与 Alt+F4 同类） |

### P1 —— 翻页/渲染热路径

| 优先级 | 措施 | 涉及 | 预期收益 |
|---|---|---|---|
| P1-1 | 翻页 `setProgress` 跳过 `updateBookProgress` 库写入 | `readerStore.ts:423` | 每翻一页省 O(n) 全库拷贝 + Reader 整树重渲 |
| P1-2 | `useLibrary`/page.tsx/约 30 处 bookDataStore 订阅改 per-field selector | `hooks/useLibrary.ts`、page.tsx、reader 组件 | 消除无 selector 订阅导致的级联重渲 |
| P1-3 | `getVisibleRange` 从上一锚点双向扩散 + 缓存可见范围 | `paginator.js:406-474` | 长章节每翻一页省 2000–5000 次矩形读取（10–20ms→亚毫秒） |
| P1-4 | 字号/主题滑块加 120ms throttle；`safeSaveJSON` 单写 | `settings.ts`、`persistence.ts` | 滑块拖动不再逐帧整章重排 + 双写盘 |
| P1-5 | 搜索建索引 `batch()` 事务化 | `librarySearchIndex.ts:102-243` | 1500 次 IPC 往返→数十次 |

### P2 —— 容量与稳态

| 优先级 | 措施 | 涉及 | 预期收益 |
|---|---|---|---|
| P2-1 | 搜索结果全局 cap + 虚拟列表 | `librarySearchService.ts:112`、`SearchResults.tsx` | 常见词千本共搜不把数十万条灌进 state/渲染 |
| P2-2 | 索引空闲定期 checkpoint WAL | `librarySearchService.ts:409` | 长驻会话 `search.db-wal` 不无限增长 |
| P2-3 | 隐藏窗口心跳放宽 / 可见才发 | `ReaderContent.tsx:160-163`、`readerWindowWatchdog.ts:12` | 隐藏 reader 的持续 CPU/定时器开销下降 |
| P2-4 | MOBI 头解析懒读；copyFile 失败分块流式 | `mobi_parser.rs:74`、`bookService.ts:673` | 大 MOBI 内存峰值减半 |
| P2-5 | 关闭阅读页增量刷新 | `page.tsx:519-548` | 数千本时关阅读页不卡顿 |

---

## 需要增加的性能埋点

现有埋点（`src/utils/perf.ts` `perfMark`）仅覆盖三处：`view.*`、`initViewState.*`、`importBook.*`。**以下环节目前完全无观测，建议按优先级补齐**：

| 优先级 | 埋点位置 | 埋点内容 | 用途 |
|---|---|---|---|
| P0 | `readerStore.ts:423` `setProgress` 入口 | `perf.progress.set`（耗时） | 量化每页翻页的库写入+订阅成本（对应 B4） |
| P0 | `librarySearchService.ts:627` 判定点 | `search.bookFresh` 命中/重建计数；`search.rebuild` 单本耗时 | 直接验证 B1 重建风暴频率与成本 |
| P0 | `librarySearchService.ts:690` live path | `search.index.build.<bookHash>` 分阶段（open/extract/write/match） | 量化惰性建索引分布 |
| P1 | `useBooksManager.ts:139` 换书 | `reader.swap` 新旧 viewState 数量 | 观测 B2 viewStates 增长 |
| P1 | `paginator.js` `#afterScroll`/`getVisibleRange` | `paginate.visibleRange` 耗时 | 量化每翻一页的矩形遍历（P1-3 收益） |
| P1 | `settings.ts:56` `saveViewSettings` | `settings.apply.<key>` 耗时 + 触发频率 | 量化字号/主题切换整章重排成本 |
| P1 | `librarySearchIndex.ts:102-243` | `index.writeSection` 单节写库耗时 | 验证 batch 化收益 |
| P2 | `Bookshelf.tsx` `sortedBookshelfItems` memo 重算 | `shelf.groupSort` 耗时 | 量化分组排序成本 |
| P2 | `page.tsx:519` `close-reader-window` handler | `library.reloadOnClose` 耗时 | 验证 B8 全量重载成本 |
| P2 | 窗口心跳/可见性 | `reader.hiddenRendering` 标记 | 评估后台节流禁用影响 |

> 注：`perfMark` 已自动转发到 `%LOCALAPPDATA%\com.local.readest\logs\Readest Local.log`（release 可 grep），新增埋点零成本复用同一工具即可。

---

## 本次调试涉及的改动文件

- **本次会话为只读调研，未修改任何源码文件。**
- 工作区 git 状态中 4 个文件显示 `M`（`ViewMenu.tsx`、`ParagraphOverlay.tsx`、`useIframeEvents.ts`、`readingRuler.ts`）经核查为 **CRLF 换行符幽灵改动**：工作区 blob hash 与 HEAD 完全一致（`1dd4561…`），`git diff` 为空，`core.autocrlf=true` 使 Git 将行尾差异标记为 modified，实际无内容差异。
- 根目录 `n_*.json`/`p_*.json`/`ill*.json` 与 `cdp.js`/`gsearch.js`/`retry_wayback.sh`/`wayback_results.txt` 为 wayback 机器抓取产生的临时数据文件，与项目功能无关，建议清理或加入 `.gitignore`。

---

## 附：性能实测数据基线（引用上轮实机数据）

| 指标 | 实测值 | 备注 |
|---|---|---|
| release 冷开首绘 | ~1.5s（1442/1539ms） | `[perf] view.firstPaint` 页面加载起算 |
| 复用切书渲染 | ~80–160ms | 单进程连续切书稳定，无累积爬升 |
| 冷启动首开（dev） | ~12.2s | dev 未优化 bundle，非单次渲染耗时 |
| 正文滚动跳转 | 0.07ms | foliate 内容容器 scrollTop |
| 书库列表滚动 | 0.08ms | 虚拟化列表 |
| 30 次翻页内存 | +14MB | 正常波动，无泄漏迹象（单次会话短测） |
| 双窗口总内存 | ~700–970MB | 主进程 122MB + 7 个 msedgewebview2 渲染进程 |
| 全库搜索基准 | 1000 本 ≈ 4.8s / 100 本 ≈ 0.48s | 仓库 bench；受 B1 重建风暴影响 |

> 上述内存数据为**短会话**测量，未覆盖 B2（长会话换书）与 B1（重建风暴）触发的真实峰值；建议修复后复测长会话内存曲线与"读后搜索"延迟。

---

## 附：修复可行性评估与注意事项（2026-08-14 补充审查）

本报告标注"已验证"的缺陷经**代码抽查复核**（B1/B2/B4/B5/B6 五处全部属实，行号引用准确），并按修复优先级对**现有功能影响**逐项评估。

### 一、验证结论（抽查 5/5 属实）

| 论断 | 复核结果 |
|---|---|
| B1 搜索重建风暴 | 属实：`libraryStore.ts:116` 每次进度写 `updatedAt=Date.now()`；`librarySearchIndex.ts:83` `isSearchIndexFresh` 要求 `meta.updatedAt === book.updatedAt` |
| B2 viewStates 泄漏 | 属实：`readerStore.ts:119` `setBookKeys` 只改 bookKeys，不清理旧 key 的 viewState |
| B4 翻页级联重渲 | 属实：`useLibrary.ts:8` 无 selector 订阅整个 store；`updateBookProgress` 每页 O(n) 拷贝 |
| B5 foliate-js 高亮 | 属实：`view.js:289` `find(x => x.index = resolved.index)` 单等号赋值 |
| B6 拖选翻页死代码 | 属实：`paginator.js:1557` `!isPointerSelecting && isPointerSelecting` 恒 false |

### 二、按现有功能影响分级

#### 无风险 / 低风险（可直接修）

| 项 | 说明 |
|---|---|
| B3 看门狗唤醒 main | 仅崩溃兜底路径增强，正常功能零影响 |
| B5 单等号改 `===` | 只修有声书高亮跟随，一行修复 |
| B6 删死代码/重写 | 恒 false 分支从不执行，删除即无影响 |
| B7 双窗口并发锁 | 加互斥不改单窗口行为 |
| B9/B12/B13/B14/B15 | 补 `.catch`、清定时器、checkpoint、DOM 清理——纯补洞 |
| B16 MOBI 解析 | 触及 Rust 解析，改后需回归，但不动 EPUB/PDF 主路径 |

#### 有真实交互风险（需谨慎设计）

**⚠️ B2 viewStates 清理 × 侧键历史导航**
- 报告建议"换书即 `clearViewState(旧 key)`"，会破坏切书优化：`useBooksManager` 会话历史（`MAX_HISTORY=3`）切书依赖已打开的 view；清掉后需重建 FoliateView（DOM/iframe），"切书无感"打折，极端回退到 "Book file not found"。
- **安全做法**：不每次换书清理，改为**窗口级剪枝**（保留最近 N 个 key，N ≥ 历史窗口），与 `bookDataStore` 的 `MAX_HISTORY` 同策略。功能不变，只回收超出窗口的。

**⚠️ B1 索引重建风暴 × `updatedAt` 排序语义**
- `updatedAt` 不只有索引新鲜度一个消费方，还驱动 **"最近更新"排序**（`librarySortBy=Updated`）与**最近读 shelf**。若改成"进度更新不再写 `updatedAt`"，会破坏这两个功能。
- **安全做法**：只改 `isSearchIndexFresh` 判据（改用文件 mtime/大小/hash 作内容版本），**不动 `updateBookProgress` 写 `updatedAt`**。搜索变快，排序/最近读行为不变。

**⚠️ B4 翻页跳过库写入 × 进度持久化**
- 报告建议翻页 `setProgress` 跳过 `updateBookProgress`。但**进度持久化是硬功能**：若只"章节切换/退出"落盘，用户读到一半异常退出（崩溃/杀进程）会**丢进度**。现在每页写库正是容灾。
- **安全做法**：降频而非取消——节流（每 N 页或定时落盘）+ 退出/切书路径强制 flush；或保留 `updateBookProgress` 但把它从 Reader 渲染订阅链上摘掉（per-field selector，见下）。

**⚠️ B8 关闭阅读页增量刷新**
- 改增量刷新若漏同步字段，关闭阅读页后书库可能显示**旧进度/阅读状态**。需枚举 close-reader-window 要同步的字段，并回归"阅读→关闭→书库"路径。

### 三、修复顺序建议

1. **立即做（零风险）**：B5、B6、B3。
2. **安全设计后做**：B1（只改索引判据）、B2（窗口级剪枝，≥ 历史窗口）。
3. **单独做（纯重构，行为不变）**：P1-2 per-field selector（`useLibrary`/page.tsx/~30 处 bookDataStore 订阅）——治本消除级联重渲且不丢进度，改动面大，靠全量测试兜底。
4. P1 其余项（batch 事务、getVisibleRange 缓存、throttle）按 ROI 逐项评估。

> 所有性能量化数据（如 1500 次 IPC、1000 本 4.8s）为估算/短测基线；按本报告"需要增加的性能埋点"清单补 `perfMark` 后复测，验证真实收益。

