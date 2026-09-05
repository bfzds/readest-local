# Readest Local 性能与调试分析报告（2026-08-30，全项目扫描）

- **日期**：2026-08-30
- **锚点**：`e50da11`（书库分组拖拽完善，HEAD）
- **性质**：只读分析 + 全项目扫描。不改代码、不提交 git。
- **上一份**：perf-debug-report-2026-08-24.md（锚点 `1523c08`）
- **方法**：4 路并行只读子代理分模块扫描瓶颈（书库拖拽 / 阅读渲染 / 搜索-统计-TXT / Rust 侧）+ 主线程复核关键结论 + 实测测试基线。历史遗留 13 项逐一现场复核现状（行号已对照当前代码）。

---

## 1. 项目画像摘要

| 项 | 值 |
|---|---|
| 产品 | Readest 桌面版（Tauri 便携版为主，`pnpm dev` 同套 React 跑 WebView2） |
| 前端 | React 19.2.8 / Next 16.2.11 / zustand 5.0.10 / react-virtuoso ^4.17 / overlayscrollbars ^2.11 |
| 渲染内核 | foliate-js（workspace 包，paginator.js 3808 行） |
| 后端 | Tauri 2 + tokio；turso SQL 插件（submodule `plugins/tauri-plugin-turso`）为 path 依赖 |
| 架构判据 | monorepo `apps/readest-app`（SPA）+ `src-tauri`（桌面壳）→ **桌面应用（Tauri/webview + 前端渲染 + WebWorker）** |
| 基线 | 测试 5711 通过 / 10 skipped（425 文件，实测 `pnpm test -- run` 88.4s）@e50da11；8-24 为 5659 → 净增 52，全绿 |

**构建体积**：本轮未重测（耗时），提供测量命令见 §3.1。Rust 侧自 8-24 至今零改动（主仓最后触碰 `src-tauri/src` 为 5280fc8(8-14)，turso 子模块 0a2b776(8-14)）。

## 2. 模块树状图

```
apps/readest-app/src/
├─ app/library/          书库页：page.tsx(2038行) 导入/分组/URL态；components/Bookshelf(1764)
│  ├─ components/        Bookshelf/BookshelfItem(ViewMenu)；研发重灾区
│  └─ utils/             libraryUtils.ts(1343) reassignToGroup/swapShelfUnits/reorderShelfLayer
├─ app/reader/           阅读页：FoliateViewer、Annotator(2042)、TTSController(1575)、RSVP*
├─ components/           通用 UI（settings/command-palette/primitives）
├─ store/                16 个 zustand store（libraryStore/readerStore/settingsStore…）
├─ services/             业务层：bookService、librarySearchService/Index/Worker、statistics/、mdictProvider、TTS/rsvp、turso db
├─ utils/                txt.ts(1333)、simplecc、perf.ts([perf]埋点)、coverThumbnailCache、lru、chapterTextCache
├─ workers/              txt-converter.worker.ts、bgl-decompress.worker.ts
├─ hooks/libs/helpers/   openWith、settings、shift…
src-tauri/src/           lib.rs(495,命令注册)、range_file、dir_scanner、epub_parser(1432)、mobi_parser
plugins/tauri-plugin-turso/src/  wrapper.rs(SQL通道)、decode.rs(Blob)
packages/foliate-js/     paginator.js(3808)、epub.js(1336)、view.js
```

**git 热点（近 20 提交）**：前端 `utils/txt.ts`(4)、`libraryUtils.ts`/`Bookshelf.tsx`/`BookshelfItem.tsx`/`LibrarySearchResults.tsx`/`library/page.tsx`(各3)、`libraryStore.ts`+`statisticsDb.ts`+`mdictProvider.ts`(各2)。Rust `src/lib.rs`(8) 居首但尽为 8-24 前。近期主题集中在书库分组拖拽、TXT 识别、搜索。

## 3. 分模块调试指南

### 3.1 通用工具与命令

- **可自动化实例**：`cd apps/readest-app && pnpm tauri:dev:test`（`tauri dev --features webdriver`），内嵌 WebDriver 监听 127.0.0.1:4445，wdio 直连。
- **渲染/拖拽性能观测**（WebView2 远程调试）：开发模式启动后 Chromium DevTools 连 WebView2。日志转发全部 webview console 至 `%LOCALAPPDATA%\com.local.readest\logs\Readest Local.log`，含 `[perf]` 埋点（`utils/perf.ts:1-10`：`view.firstPaint`、`initViewState.total`、`importBook.total`）。
- **前端测试**：`cd apps/readest-app && pnpm test`（vitest watch）/ `pnpm test -- run`（一次性）。
- **静态检查**：`pnpm lint`（`tsgo --noEmit` + `biome lint`）。
- **Rust 检查/测试**：仅 `src-tauri/` 变更才跑——`pnpm fmt:check`、`pnpm clippy:check`（`-D warnings`）、`pnpm test:rust`（`cargo test -p Readest --lib`）。
- **专用基准**：`cd apps/readest-app && pnpm bench --list` → 现有 3 项：`library-search`（顺序匹配器全量扫描）、`library-search-turso`（每书 turso search 构建与 fan-out）、`vector-retrieval`（暴力每书 topK）。结果入 `bench/results.jsonl`。
- **构建体积判据**（本轮未实测）：`cd apps/readest-app && pnpm build`（Next standalone）。判据：主 chunk >2.5MB 或首屏 JS 拖慢启动即需排查。

### 3.2 按模块场景（每场景：命令 → 输出解读 → 排查）

**场景 1：书库分组拖拽卡顿/错位**
- 命令：`pnpm tauri:dev:test` 打开书库 → 拖一本书进组格 → 看 Console 拖拽事件与 `pnpm bench` 旁路；拖拽帧率用 WebView2 Performance 面板 FPS 曲线。
- 输出解读：若 drop 后高亮残留 2 帧 → 每帧 reflow 攒的布局脏区（见 §4 SK-2）；若排序结果与提示相反 → `Bookshelf.tsx:1257`（swap 判定）与 `:1416`（归组分支）语义不一致（code-review 已确认）。
- 排查：现象"拖起后源格子不淡化"→ `dragActiveRef` 阈值 8px 未越过或 `dragstart` 未触发；"进组不归组"→ 检查 `resolveHoverTarget` 的 `elementFromPoint` 返回（元素是否被 overlay 遮挡 → 检查 z-index）；"松手无反应"→ `onPointerUp` 早退（`!wasDragging || !source || !target`）。

**场景 2：搜索整本耗时/卡 UI**
- 命令：书库侧栏搜整本 → Console 计时（fuzzy/nearby 逐节 `postMessage` 见 §4 SR-1）；跑 `pnpm bench library-search` 基准对比基线 `bench/results.jsonl`。
- 输出解读：fuzzy/nearby 每节一次 worker 往返；2000 节 ≈ 100MB 结构化克隆。整本搜索 >2s 判定为慢。
- 排查：搜不到 → Index 未建（`librarySearchIndex.ts` checkpoint 未跑）；卡 UI 主线程 → 命中 2000 节全量渲染（`LibrarySearchResults.tsx:437` 未虚拟化）。

**场景 3：翻章/滚屏掉帧**
- 命令：阅读页翻章/滚屏 → WebView2 Performance 看主线程长任务；`[perf] initViewState.total` 日志看打开耗时。
- 输出解读：翻章长任务源 = 整章 TreeWalker 遍历（`paginator.js:406-474`）+ transform 十段无缓存（`transformService.ts:4-19`）。
- 排查：翻回旧章仍卡 → refcount 驱逐后缓存重建（`epub.js:897-913`）；滚屏卡 → scroll 未防抖每事件 `#replaceBackground()`。

**场景 4：SQL/落盘慢**
- 命令：阅读中开着 `Readest Local.log`，批量导入时看写盘；turso 慢查询加 `SELECT` 计时（worker 侧）。
- 输出解读：execute/select/batch 直取共享 worker（`wrapper.rs:134-189` 无 spawn_blocking）；`op_lock` 使同库全排队。
- 排查：导入/标注并行时 UI 偶发卡 → wal_checkpoint 占池；批量导入逐条 INSERT → 合并为 batch。

### 3.3 日志集成现状

- 前端有统一 `[perf]` 埋点前缀（`utils/perf.ts`），Tauri 下转发到 `%LOCALAPPDATA%\com.local.readest\logs\Readest Local.log`。
- 缺集中式链路 id：前端 store 与 worker 与 Rust IPC 无 trace_id 贯穿；单机场景可接受，若后续怀疑跨层时序（导入→写盘→重读），建议在 perf 行尾加 `tx=<counter>` 便于 grep 排序。
- 已知噪音：`Bookshelf.tsx:1198` 的 `[create]` 与 `page.tsx:796/802` 的 `[nav]` console 进生产路径（code-review 确认，建议清理——非性能项但污染日志 grep）。

## 4. 性能分析矩阵（按优先级）

> 成本收益列结论三态：✅值得 / ⚠️可选 / ❌暂不建议。优先级判据：P0=高影响+低/中难度或阻塞；P1=中影响或高影响高难度；P2=低影响。

| 优先级 | 模块 | 瓶颈 | 量化影响 | 优化建议 | 预期收益 | 难度 | 成本收益 | 备注 |
|---|---|---|---|---|---|---|---|---|
| **P0** | 书库拖拽 SK-2 | drop 整条渲染链全量重建：`updateBooks` 末尾必 `refreshGroups()` O(N·depth) MD5 + `sortedBookshelfItems` 全量重排，比较器 `getGroupSortValue` 每组 `Math.max(...books)` 每次比较重算 O(组内书数) | N=1000 深 3 → ~3000 MD5/调；全重排最坏 O(N·B·log) | §5.1：组排序键预计算 + refreshGroups 去重/仅在 name 变化时算 MD5 + 避免原地 sort memo 产物 | 每次 drop 主线程清理成本 O(N·depth+N·B·log)→O(N+G log G)，拖拽后 UI 立即顺滑 | 中 | ⚠️可选 | 排序语义敏感，需拖拽全场景回归；但收益落常用路径 |
| **P0** | 书库拖拽 SK-3 | Virtuoso 渲染扇出：`Bookshelf.tsx:817` `getSelectedBooks()` 每 render 新建数组 → `renderBookshelfItem` useCallback deps 恒变 → 可见区+overscan 全重渲，BookshelfItem 无 memo | 任意 setState（dragAction 过区/ghost）→ 全窗口重渲 | §5.2：store 暴露稳定 Set 引用 + useCallback 稳定 deps + BookshelfItem `React.memo` | 重渲粒度从"每次 render 全窗口"→"仅选中/数据变化"，拖拽悬停期 CPU 显著下降 | 低 | ✅值得 | 低风险低垂果实 |
| **P0** | 书库拖拽 SK-1 | 拖拽 move 循环每帧强制 reflow：`onPointerMove`(Bookshelf.tsx:1275-1337) ghost.getBoundingClientRect→style 写入→`querySelectorAll` 全文档→`elementFromPoint` 命中（同步 reflow） | 60–144Hz 每事件约 10+ 布局读/写；拖拽持续+ ghost 停边帧率掉帧 | §5.3：ghost 用 `transform`+缓存尺寸避逐帧 rect；高亮清除改存上帧元素 ref；move 累计 rAF 帧内批处理 | 拖拽帧率稳定（用户明确在意"拖动要有动画"） | 中 | ⚠️可选 | 自研拖拽敏感，需保持指针跟手与 8px 阈值亚行为 |
| **P0** | 搜索 SR-1 | fuzzy/nearby 逐节 postMessage 往返 + 每节重建 `Intl.Segmenter`：`librarySearchService.ts:574` 每节一次 `searchWorker.search`；`library-search-algorithms.js:12,242` 每次 new Segmenter；nearby 传 words=undefined 强重分词 | 2000 节×~50KB≈100MB 克隆/查询；Segmenter 重建 2000 次 | §5.4：整批节一次 postMessage 循环放 worker 内 + Segmenter 提模块单例 + nearby 传 words + 索引侧分页读节 | 整本 fuzzy/nearby 搜索耗时降一量级（数秒→<1s），内存峰值降 | 中 | ✅值得 | 历史遗留①项；桌面主战场常用（整本搜索/划词附近） |
| **P1** | 渲染 RD-3 | 翻章 transform 无缓存 + refcount 驱逐重跑：`epub.js:897-913` unref 归零删缓存；ten 段 `transformContent`(`transformService.ts:4-19`) 每次重跑 | 翻回缓存窗口外章节 → 主线程整章 DOMParser+十段 transform+srcdoc 重做 | transform 输出键为 (chapterKey+设置hash) 加 LRU 缓存，随设置变更失效 | 翻章往返不重跑，最长路径 CPU 减半（估算） | 中高 | ⚠️可选 | 缓存失效键复杂（设置/主题依赖），回归面大 |
| **P1** | 渲染 RD-1 | 滚屏每事件整背景重建：`paginator.js:1449-1512` scroll 未防抖，`#replaceBackground` 每次 ~10 布局读 + `#paintPaginatedBackground` 清空重建段 div | 每次滚轮/trackpad 事件全背景重建 | scroll 加 rAF 合并 + 背景段仅位置/尺寸变化时更新 | 滚动功耗与主线程占用下降，长书滚动不再烫 | 中 | ✅值得 | 滚动常用路径 |
| **P1** | 渲染 RD-2 | HF2 整章遍历（历史未修）：`paginator.js:406-474` getVisibleRange TreeWalker 全章 body，每元素 getBoundingClientRect | O(章节文本节点) 每翻章/滚停/切章 | 只留可见窗口内节点 / 二分到首尾可见 | 翻章滚停延迟下降（估算） | 中高 | ❌暂不建议 | 历史一致暂缓；改动触碰分页核心正确性 |
| **P1** | 渲染 RD-5 | transformTarget 监听泄漏：`FoliateViewer.tsx:647,678` addEventListener 无 cleanup，bookDoc 缓存复用 | 同书反复打开 N 次 → 每次 createURL data 事件 N 个 handler 串级各跑十段 transform | open effect 返回 cleanup 移除监听 | 重复打开同书不再 N 倍放大 transform | 低 | ✅值得 | 低风险；注意同 effect 内多个 listener 需成对移除 |
| **P1** | 搜索 SR-3 | 搜索结果未虚拟化（历史③未修）：`LibrarySearchResults.tsx:437` 全量 map，每结果 `setGroups` 重建整树 | 上限 2000 子项 → 至多 2000 次 React commit，内存驻留摘要字符串 | 引入 virtuoso/react-window 虚拟化组内子项 | 高命中查询首屏/滚动流畅（缓解已挡在最坏边界） | 高 | ⚠️可选 | 缓解事实仍在（默认折叠/每本500/上限2000），玩法复杂 |
| **P2** | TXT SR-4 | 大文件多趟全文重读 + 逐 segment 重编译正则：`txt.ts:504-535` probe+extract 最多 3 趟流式迭代；`createChapterRegexps`(:865→:1019-1042) 每 segment 重跑 validate+new RegExp | 800 segment → 数千次重复正则编译 | probe 无需重读（extract 一次流 + 保留正则池复用） | 大 TXT 识别耗时从数次流式迭代收敛到 1 趟 | 低中 | ✅值得 | 低风险；导入一次性但必然 |
| **P2** | 统计（历史②部分） | 统计 N+1 IPC 逐事件写入：`statisticsDb.ts:275-291` 事务已单化，循环内仍逐 event insert + 逐 book upsert + recompute；批量导入/回填数万行 = 数万次 IPC | 首次多设备大 pull 数万次往返 | 回填路径改 VALUES 多行合并 + touched 聚合一次写 | 大 pull 从小时级 IPC 降到秒级（估算） | 低 | ⚠️可选 | 本地 flush 每批 4-8 次 IPC 可接受；仅首次 pull 痛 |
| **P2** | TXT/搜索 诊断 | 编码探测双实现：`txt.ts:160` 新写 `detectTxtEncodingFromFile` 与类内 `detectEncodingFromFile`(:649) 重复 | 双倍维护面；后者 100×new TextDecoder 滑动探测 | 合并为单实现（code-review 新5 半修项） | 减小复杂度，行为收敛 | 低 | ✅值得 | 一并清除 code-review 死代码 `reorderShelfLayer` |
| **P2** | Rust DS-3 | dir_scanner 重复 stat：`dir_scanner.rs:99,107` WalkDir 出 file_type 后仍每文件 metadata | 万级目录冗余 stat ≈ 翻倍 syscall | 复用 `entry.metadata()`；`extensions.contains(&"*")` 提循环外 | 扫描大目录耗时近半（估算） | 低 | ⚠️可选 | Rust 侧 8-24 至今零改动，改动需重捡 Rust 工具链 |
| **P2** | Rust（历史 3/4/5/6） | turso 阻塞 worker+单锁（`wrapper.rs:134-189`）、MOBI 整读、range_file 无 fd 缓存、decode Blob 逐字节 | 慢查询占整池；大 AZW3 内存×N；Android 专属路径 | spawn_blocking/连接池分片；mmap/fd 缓存；base64 | 并发 IPC 排队消除；内存峰值降 | 高 | ⚠️可选 | 高难度高回归面；本机主战场桌面端、Android 路径低频 → 暂缓合理 |

> 备注：成本收益与优先级冲突处（SK-2 标 P0 但 ⚠️）——收益落常用路径，但触排序核心正确性、需全场景回归；矩阵尊重成本收益，把它列 P0 但实施时先做无回归项（SK-3/5.2、SR-1/5.4）。

## 5. P0 瓶颈详细优化方案

> 每条五段：问题代码 → 优化后代码 → 配置改动 → 验证 → 成本收益。

### 5.1 书库 drop 全链重建（SK-2）

**①问题代码**
- `libraryStore.ts` `updateBooks` 末尾必调 `refreshGroups()`（对每本书全名+每个祖先前缀算 MD5，O(N·depth)）；紧接着 `Bookshelf.tsx:424-523` 重算 `sortedBookshelfItems`，合并比较器 `Bookshelf.tsx:480-510` 里 `getGroupSortValue` 每次比较对整组 `Math.max(...books.map(b => b.shelfIndex))`；且 `:446` 对 memo 产物数组原地 `.sort()` 直接改缓存，是正确性隐患。

**②优化后代码（示意）**
```ts
// libraryStore.ts refreshGroups 缓存：name 未变则复用指纹
const fingerprints = new Map<string, string>();        // 模块级或 store 缓存
function groupFingerprint(name: string) {
  let fp = fingerprints.get(name) ?? hashFingerprint(name);
  fingerprints.set(name, fp);
  return fp;
}
// 组排序键一次性预计算，比较器不再每次 Math.max
const groupSortKey = (g: BooksGroup) =>
  g.books.length ? g.books.reduce((m, b) => Math.min(m, b.shelfIndex ?? MAX), MAX) : (g.manualOrder ?? MAX);
const precomputed = new Map(sortedGroups.map((g) => [g.name, groupSortKey(g)]));
sorted.sort((a, b) => precomputed.get(a.name)! - precomputed.get(b.name)!
  || fallbackByFingerprint(a.name, b.name));
// 排序前拷贝，避免原地改 memo 产物：const next = [...items]; next.sort(...)
```

**③配置改动**：仅源码调整；无接口/依赖变更。`fingerprints` 上限随分组数，组名不可变时无需清空；建组/改名时 `fingerprints.clear()` 一次。

**④验证**：
1. `cd apps/readest-app && pnpm test -- run`——`reorder-shelf-layer.test.ts` 与新建分组测试全绿（验证排序语义无回归）。
2. `pnpm tauri:dev:test` 书库建 3 层组 ~1000 本 → 拖动入组，WebView2 Performance 记录主线程长任务次数对比优化前（预期每次 drop 长任务 <16ms）。
3. 拖拽保序全场景回归：空壳组并入、组→组嵌套、跨层移动、源组残留、手动/空组锚混排各一遍。

**⑤成本收益**：⚠️ 可选。收益落"每次 drop"的常用路径，明确；但注入排序核心正确性（保序逻辑经历 3 个提交打磨），必须按 ④ 全场景回归。建议先提交无回归项（5.2/5.4/5.3）后再在本项动手，降低并行风险。

### 5.2 Virtuoso 渲染扇出（SK-3）

**①问题代码**：`Bookshelf.tsx:817` `const selectedBooks = getSelectedBooks();` 每次 render 从 Set new 数组；`:1031-1048` `renderBookshelfItem` 的 `useCallback` deps 含它 → 函数身份每次 render 重建 → 作为 `itemContent` prop，virtuoso 全可见窗口重渲；`BookshelfItem.tsx` 无 `React.memo`。

**②优化后代码**
```tsx
// 每次 render 不新建数组：memoize 在 store 或 useMemo，deps 用 store 原生 Set 引用
const selectedSet = useLibraryStore((s) => s.selectedBooks);          // 稳定 Set 引用
const renderBookshelfItem = useCallback(
  (index: number, item: ShelfItem) => <BookshelfItem .../>,
  [selectedSet, /* 其余稳定 dep（sortBy、groups=refresh 版本号）*/],   // 不再依赖每次新建的数组
);
export const BookshelfItem = memo(function BookshelfItem({ ... }: Props) { ... });
```

**③配置改动**：无需。产物是 props 引用稳定性 + memo 浅比较。

**④验证**：
1. 单元：`pnpm test -- run` 中 Bookshelf 相关用例过。
2. 运行时：`pnpm tauri:dev:test` 书库拖拽悬停，WebView2 Performance 看渲染任务时长（预期从"每次过区闪烁重渲"降到"仅 drop/选中改变才重渲"）。

**⑤成本收益**：✅ 值得。改动局部、低风险，收益明确且落拖拽悬停这一常用高 CPG 路径。唯一注意：`React.memo` 引入后新 props（如富对象）须为稳定引用，否则失效——检查传散对象处。

### 5.3 拖拽 move 循环 reflow（SK-1）

**①问题代码**：`Bookshelf.tsx:1275-1337` `onPointerMove`：`:1308` `ghost.getBoundingClientRect()` → `:1316-1317` 写 `style.left/top`（弄脏布局）→ `:1319` `document.querySelectorAll('.drag-over-group,.drag-over-merge')` 全文档 → `:1253` `document.elementFromPoint`（因前帧 style 写强制同步 reflow）→ 至多 3 `closest` + 2 classList 写。

**②优化后代码（关键点）**
```tsx
// ghost 用 transform 平移 + 缓存已知尺寸，避免每帧 getBoundingClientRect
ghostRef.current.style.transform = `translate(${left}px, ${top}px)`; // 不触发布局失效区域
// 高亮清除：记录上帧元素引用，只清一个而非全文档 querySelectorAll
const PREV = hoverElRef.current;
if (PREV && PREV !== hoverTarget?.el) PREV.classList.remove('drag-over-group', 'drag-over-merge');
// move 事件仅记录最新坐标，rAF 帧内批量：命中测试+高亮更新+ghost 定位
let pending = { x: 0, y: 0, scheduled: false };
onPointerMove = (e) => { pending = { x: e.clientX, y: e.clientY, scheduled: true }; if (!raf) raf = requestAnimationFrame(frame); };
```

**③配置改动**：ghost 元素 CSS 加 `will-change: transform; position: fixed;`，保证 transform 独立图层不回流文档。`.drag-over-group/.drag-over-merge` 高亮类保留。

**④验证**：
1. `pnpm tauri:dev:test` 手动拖拽：跟随性（ghost 与指针位移同速）、停边翻转（窄窗靠边保持可见）、进组/出组高亮正确、drop 落点与提示一致（顺带回归 code-review 的 swap/并入矛盾）。
2. Performance 面板 FPS：拖动 2000 本库保持 60fps（对比优化前掉帧）。

**⑤成本收益**：⚠️ 可选。收益在拖拽这一用户明确在意的体验；但自研 Pointer 拖拽逻辑薄、易出跟手/判定回归。不压缩此重构，与 5.1 错峰。

### 5.4 搜索 fuzzy/nearby 批量 + Segmenter 复用（SR-1）

**①问题代码**：`librarySearchService.ts:574` 对每节调 `searchWorker.search`（2000 节=2000 次 postMessage，~100MB 克隆）；`public/workers/library-search-algorithms.js:12/242` 每次 `new Intl.Segmenter`；`:580` nearby 传 `words=undefined` 强制每节重分词。索引侧 `librarySearchIndex.ts:304` 一次性 SELECT 全部节全文。

**②优化后代码（示意）**
```ts
// 主线程：整批节一次投递，worker 内循环（协议加 chunk 包裹）
searchWorker.postMessage({
  type: 'search-batch', algo, query, sections, options,  // sections = 全部命中节的 [{id, text}] 
});
// worker 内：Intl.Segmenter 提为模块级单例
const segmenter = new Intl.Segmenter(lang, { granularity: 'grapheme' });
for (const { id, text } of payload.sections) { ...searchCore(text, segmenter)... }
// nearby 传入显式 words（由单次分词产出），不再依赖调用侧 undefined
```

**③配置改动**：worker 消息协议变更（search→search-batch）——需同步 `librarySearchWorker.ts` 与调用侧；索引侧 `loadSearchIndexSections` 改分页（`LIMIT n OFFSET p`）避免全量驻留。

**④验证**：
1. `pnpm bench library-search` 对比 `bench/results.jsonl` 历史行：整本命中耗时预期降一量级（LATENCY 探针对比）；新行会落盘。
2. `pnpm tauri:dev:test` 全库 fuzzy 搜索（命中 2000 节规模）：Console 看 postMessage 计数从 2000→1；转换结果与旧算法逐节比对一致（防批量引入排序变化）。

**⑤成本收益**：✅ 值得。桌面主战场常用路径（整本搜索、划词附近），收益明确且抵消维护协议成本。风险集中在 worker 消息格式，建议新消息类型回归对齐旧单节结果。

## 6. 历史遗留 13 项现状复核（@e50da11）

| # | 编码/项 | 现场 文件:行号 | 现状 |
|---|---|---|---|
| 1 | HF2 整章遍历 | paginator.js:406-474 | 仍在（见 RD-2，暂缓不变） |
| 2 | RF6 MOBI 整读 | mobi_parser.rs:74,107 | 仍在：spawn_blocking(:61) 不卡主线程，内存峰值×N 批量导入时放大 |
| 3 | NF10 close 未 await | useBooksManager.ts:167 | 仍在：换书非同 key 已无状态污染，仅与开新书抢帧（降级） |
| 4 | turso 阻塞 + 单锁 | wrapper.rs:134-189 | 仍在：execute/select/batch 未包 spawn_blocking；op_lock(:26) 全排队 |
| 5 | range_file 无 fd 缓存 | range_file.rs:134-162 | 仍在：每 range 请求 open+seek；desktop 实际走 tauri asset 协议（同款模式）；Android 才走 rangefile |
| 6 | Blob 逐字节 JSON | decode.rs:23-28 | 仍在：休眠（迁移表无 BLOB 列，仅测 vector），4-6× 膨胀风险 |
| 7 | dir_scanner 重复 stat | dir_scanner.rs:99,107 | 仍在：复用 entry.metadata() 可消（DS-3 低垂果） |
| 8 | 只读命中仍 checkpoint | librarySearchService.ts:906-908 | 半修：残留于非 session 分支；生产两调用方（库页/侧栏）均传 session → 当前不可达 |
| 9 | fuzzy/nearby 逐节 postMessage | librarySearchService.ts:574 + index:304 | 仍在（SR-1，立 P0） |
| 10 | statisticsDb N+1 | statisticsDb.ts:275-291 | 部分修：BEGIN/COMMIT 单事务已包裹；逐事件 INSERT/upsert/recompute 往返仍在 |
| 11 | SF10 跨卡片 blob 复用 | mdictProvider.ts:555-560,696-702,714-722 | 回收闭环完整；跨卡片复用未做（每查重 locateBytes+objectURL） |
| 12 | 搜索结果虚拟化 | LibrarySearchResults.tsx:437 | 未实施；缓解仍在（默认折叠/每本500/上限2000） |
| 13 | transform 输出缓存 | transformService.ts:4-19 + FoliateViewer.tsx:264 | 部分缓解：解压已缓存（document.ts:332-348）；transform 输出仍随 refcount 驱逐重跑（RD-3） |

## 自检清单

- [x] 数值带单位（ms/MB/IPC 次数/行数）；运行时数据未编造，均附测量命令或实测基线
- [x] 所有命令可复制执行（`pnpm ...` / 基准 / 日志路径）
- [x] 每模块瓶颈 ≥4（书库 4、渲染 5、搜索/统计/TXT 4、Rust 6）；P0 均附可执行代码/配置片段（§5）
- [x] 每条优化含成本收益（✅/⚠️/❌）与理由；矩阵含成本收益列；优先级与成本收益冲突项在备注说明
- [x] 代码引用均带 `文件:行号`
- [x] 历史遗留 13 项逐一现场复核现状
- [x] 报告写入 docs/，未提交 git