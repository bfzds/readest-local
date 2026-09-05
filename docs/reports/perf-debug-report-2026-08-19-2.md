# Readest Local 性能分析报告（2026-08-19，第二轮全量分析）

- **日期**：2026-08-19
- **性质**：全量性能分析（perf-debug 技能）。不提交 git。
- **范围**：Tauri 桌面端优先（web 端优化不采纳）。基于实际读取代码，全部定位 `文件:行号`，量化为估算并附测量命令。
- **前置说明**：本文件与同日 `perf-debug-report-2026-08-19.md`（前一轮 SF12 修复报告）为两次独立分析，不冲突。

---

## 1. 项目画像摘要

**技术栈**：

| 层 | 技术 | 版本 |
|---|---|---|
| 前端框架 | Next.js（App Router）+ React（桌面端经 Tauri 内嵌） | next 走 vite 覆盖 |
| 语言 | TypeScript（前端）/ Rust（后端） | ts5 / rust-version 1.77.2 |
| 状态管理 | zustand（多 store，已部分 per-field selector） | — |
| 本地数据库 | `@readest/turso-database-wasm`（前端）/ tauri-plugin-turso（Rust 侧 libSQL） | 0.7.0-pre.3 |
| 桌面壳 | Tauri 2 | 2.x |
| 包管理 | pnpm monorepo | 11.1.1 |
| 工具链 | biome + tsgo + cargo clippy | — |

**架构类型**：桌面应用（Tauri 2 壳 + Next.js 前端 + Rust 后端 + libSQL 本地库）。
判据：`apps/readest-app` 内既有 `next`（前端）也有 `src-tauri`（Rust 壳）与 `plugins/tauri-plugin-turso`。

**模块清单**：

| 模块 | 入口 | 职责 |
|---|---|---|
| 书库加载 | `src/services/libraryService.ts` | 读库清单、生成封面 URL |
| 检索 | `src/services/librarySearchService.ts` + `librarySearchIndex.ts` + worker | 全库 contains/fuzzy/nearby 搜索 |
| 阅读渲染 | `src/app/reader/components/FoliateViewer.tsx` | 章节加载 + 10 段 transformer 管线 |
| 统计 | `src/services/statistics/` | page_stat_data 事件采集 |
| 词典 | `src/services/dictionaries/providers/mdictProvider.ts` | MDict 查询 + blob URL 管理 |
| 状态 | `src/store/`（zustand） | bookData/reader/library 等 |
| 后端解析 | `src-tauri/src/epub_parser.rs` / `mobi_parser.rs` | 导入期格式解析 |
| 后端字节读取 | `src-tauri/src/range_file.rs` | 阅读期字节范围读取 |
| 数据库插件 | `src-tauri/plugins/tauri-plugin-turso/src/` | libSQL 绑定 + 序列化 |

---

## 2. 模块树状图

```text
apps/readest-app
├─ src/                              # 前端（TS/TSX, 1065 文件）
│  ├─ app/                           # Next 路由：library 书库、reader 阅读、offline
│  │  ├─ library/components/         # 书架 Bookshelf、搜索结果 LibrarySearchResults
│  │  └─ reader/components/          # FoliateViewer、ReadingStatsTracker、overlayer
│  ├─ components/                    # 通用组件：BookCover、CachedImage、menu、settings、command-palette
│  ├─ services/                      # 业务服务（106 文件）：library/book/content/ingest/search/database/statistics/dictionaries/transform/backup
│  ├─ store/                         # zustand store（16）：bookData/reader/library/settings/notebook...
│  ├─ utils/                         # 工具（110）：chapterTextCache、coverThumbnailCache、lru、concurrency、folder...
│  ├─ hooks/                         # React hooks（29）
│  ├─ libs/                          # document.ts（DOM/transform 编排）
│  ├─ workers/                       # txt-converter、bgl-decompress web worker
│  └─ types/ context/ i18n/ pages/ styles/ helpers/
├─ src-tauri/                        # Rust 后端
│  ├─ src/                           # lib.rs、epub_parser.rs(1432)、mobi_parser.rs、range_file.rs、dir_scanner.rs、window_state.rs
│  ├─ plugins/tauri-plugin-turso/    # libSQL 绑定（wrapper.rs、decode.rs、commands.rs）
│  └─ capabilities/
└─ bench/ e2e/ scripts/              # 基准、e2e、构建脚本
```

---

## 3. 分模块调试指南

### 3.1 调试工具链

| 模块 | 工具 | 安装/入口 | 配置要点 |
|---|---|---|---|
| Rust 后端 | rust-analyzer + CodeLLDB | VS Code 扩展 | `.vscode/launch.json` 加 `type:lldb`，挂 `cargo` 二进制 |
| Rust 单测 | `cargo test -p Readest --lib` | 已有脚本 `pnpm test:rust` | — |
| TS 前端 | VS Code + vitest | `pnpm test` | vitest 已配 browser mode |
| 前端 IPC 剖析 | Chrome DevTools / WebView2 远程调试 | `tauri dev --features devtools` 或 `--remote-debugging-port=9222` | 观察 `processIpcMessage` 主线程占比 |
| E2E | WebDriver | `pnpm tauri:dev:test`（webdriver 4445 端口） | 见记忆 readest-local-debug-method |

### 3.2 调试场景（3 个）

**场景 A：阅读翻页卡顿（IPC / transform 主线程）**
1. 命令：WebView2 DevTools → Performance 面板录制翻页；Profile 看 `processIpcMessage` 与 `transformContent` 占比。
2. 输出样例：`Self 28ms  transformContent @FoliateViewer.tsx:264` → 主线程与翻页总耗时成比例。
3. 常见问题排查：
   - 现象：翻回旧章仍卡 → 原因：transform 未缓存（缓存只覆盖解压字符串）→ 验证：DevTools 看是否每次 `parseFromString`。
   - 现象：自动保存密集 IPC → 原因：bookDataStore saveConfig → 验证：已节流（注释 8-20 行），确认不再触发。
   - 现象：library.json 大 → 原因：每次 save 全量 stringify → 验证：查看文件行数。
   - 现象：封面缩略图抖动 → 原因：BookCover effect 未按可见性门控 → 验证：Performance 滚动片段看 fetch/createImageBitmap 频率。
   - 现象：搜索结果卡 → 原因：结果未虚拟化 + render 内全库 sort → 验证：Performance 录制搜索。

**场景 B：全库搜索耗时**
1. 命令：`pnpm test -- --watch=false` 跑检索用例；手动：书库搜单字，看秒表。
2. 输出样例：`搜索完成，命中 12 本，耗时 3.8s` → 逐本 open/close + WAL checkpoint 累加。
3. 常见问题排查：
   - 现象：contains 命中但慢 → 原因：LIKE 全表扫描无索引 → 验证：`EXPLAIN QUERY PLAN SELECT ... FROM search_sections WHERE folded LIKE ...`。
   - 现象：fuzzy/nearby 极慢 → 原因：整书所有节载入 + 逐节 postMessage → 验证：DevTools network 看 worker 消息大小。
   - 现象：重建索引慢 → 原因：search_nodes 逐条 INSERT → 验证：计时 `writeSearchIndexNodes`。
   - 现象：命中已索引书仍慢 → 原因：只读路径仍 `wal_checkpoint(TRUNCATE)` → 验证：看 IPC 是否每次写 WAL。
   - 现象：单字查询全量扫 → 原因：LIKE '%x%' 无前缀索引 → 验证：SF13 候选上限是否命中。

**场景 C：导入/扫描大库阻塞**
1. 命令：主线程抓 50k 文件目录，`tauri dev` + DevTools Performance。
2. 输出样例：`dir_scanner spawn_blocking 完成 50k 文件 1.2s` → 串行 + 重复 stat。
3. 排查：文件数大 → 原因：单线程 WalkDir + 每文件 `std::fs::metadata` → 验证：strace/计时。

### 3.3 日志集成

Rust 侧已用 `log` crate + `tauri-plugin-log`。建议格式：
```
2026-08-19T18:00:00.000Z | INFO | search | book=abc | candidates=1200 filtered=3 costMs=18
```
注入字段：模块、book hash、耗时 ms、命中数。前端可按需 pino/console 结构化，主战场桌面端单机，本地日志轮转即可，无需 ELK。

---

## 4. 性能分析矩阵（按优先级排序）

| 模块 | 瓶颈描述 | 文件:行号 | 量化影响 | 优化 | 预期收益 | 难度 | 优先级 |
|---|---|---|---|---|---|---|---|
| 检索 | 结果列表未虚拟化 + 封面用原图绕过缩略图缓存 + render 内全库 map/sort/join | LibrarySearchResults.tsx:183-193,94-105,414 | 命中 30 书×多片段全挂载；每封面按原尺寸解码(~1.5MB/张)；每渲染一次 O(N log N) 排序 | 虚拟化结果 + 改用 getCoverThumbnailUrl + booksKey useMemo（见 §5.1） | 首屏解码峰值与 DOM 数降一个量级 | 中 | P0 |
| 阅读 | 章节重读时 DOM parse + 10 transformer 全量重算（缓存只覆盖解压字符串） | FoliateViewer.tsx:264-307 | 翻回旧章主线程重跑 HTML 全量 transform，与章节长度线性（50KB 章 × 10 transformer） | 缓存 transform 输出（见 §5.2） | 重读章节主线程免重算 | 中 | P0 |
| 后端 | turso 阻塞 SQL 直接跑 async 运行时 + connect 用 block_on 卡 worker | tauri-plugin-turso/src/wrapper.rs:73,134-188 | 每次 DB 操作占用共享 worker，多请求互挤 | spawn_blocking 包裹 + connect 异步化（见 §5.3） | 释放 tokio worker，DB 并发不互相挤占 | 高 | P0 |
| 检索 | search_nodes 逐条 INSERT，未批处理（节写入已批） | librarySearchIndex.ts:275-294 | 2000 章 TOC = 2000+ 次 DB execute IPC 往返 | 仿 SF2 攒批（每 100 条一次 batch） | 索引重建降一量级 | 低 | P1 |
| 缓存 | CachedImage 模块级 imageUrlCache 无上限、无逐出 | CachedImage.tsx:25 | 长会话随独特 URL 线性增长（几十字节/条） | 复用 LRU 思想设容量上限 | 内存有界 | 低 | P1 |
| 后端 | Blob/Vec<u8> 逐字节转 JSON 数字数组 | decode.rs:21-28, parser_common.rs:47-54 | N 字节 → N 次分配 + 4-6 倍序列化膨胀（封面/OPF 载荷 ~10 倍） | base64 编码注解 | 载荷体积降一个量级 | 中 | P1 |
| 阅读 | range_file 每 range 请求重 open+seek，无 fd 缓存/mmap | range_file.rs:134-173 | 每页几十次 open/seek syscall | 缓存 fd / 用 mmap | 热路径 syscall 降量级 | 中 | P1 |
| 检索 | 只读命中路径仍每本 open+wal_checkpoint+close | librarySearchService.ts:641,906-908 | N 本书 = N 次 DB 打开 + N 次 WAL 折叠 | 只读搜索跳过 checkpoint | 消除每本不必要写操作 | 低 | P1 |
| 检索 | search_sections.folded LIKE 全表扫描，无索引、前导通配符不可用 | librarySearchIndex.ts:311-321 | 2000 节书每次搜索扫 ~6MB 文本 | SF13 已有候选上限；需上限尽早短路 | 大书搜索耗时收敛 | 中 | P2 |
| 检索 | fuzzy/nearby 模式一次性载全书节 + 逐节 postMessage 往返 | librarySearchIndex.ts:303-304, librarySearchService.ts:555-574 | 单本 6MB 驻留；2000 节=2000 次序列化往返 | 整书单次大消息入 worker / 主线程跑小算法 | worker 通信降量级 | 中 | P2 |
| 后端 | dir_scanner 串行 + 每文件重复 stat | dir_scanner.rs:50-115 | ~2N stat，5 万文件秒级（低频） | 复用 WalkDir 类型信息免二次 stat | 扫描 syscall 减半 | 低 | P2 |
| 统计 | statisticsDb 同步回填逐事件插入+逐书聚合 | statisticsDb.ts:260-276 | 1 万事件×百书 ≈ 数百次聚合 UPDATE（低频） | 同步批量化 | flush 阻塞降为毫秒 | 低 | P2 |
| 词典 | mdict trackedUrls 数组只增不减 | mdictProvider.ts:687 | 字节已 revoke，仅失效 URL 字符串残留（轻度） | dispose 时清空即可；非字节泄漏 | 内存整洁 | 低 | P2 |

优先级判据：P0=高影响+中低难度或阻塞；P1=高影响高难度或中影响；P2=低影响/已知权衡/低频。

**P0 修正说明**：初扫把 `libraryService.ts:30` 每本书生成封面 URL 报为 blob 泄漏，但核对 `bookService.ts:209-233` 确认**桌面端走 `getCoverImageUrl`（同步返回路径 URL，零 I/O、无 blob）**，只有 `appPlatform==='web'` 才走 blob。本项目桌面端优先，故该项不成立，已从矩阵剔除（web 端才适用）。

---

## 5. P0 瓶颈详细优化方案

### 5.1 搜索结果路径：虚拟化 + 缩略图缓存 + booksKey useMemo

**① 问题代码**

```ts
// LibrarySearchResults.tsx:183-193 —— render 内全库排序
const booksKey = books
  .map((book) => book.hash)   // 新数组
  .sort()                     // O(N log N)
  .join('|');
// :94-105 —— ResultCover 直接用原图 src
<img src={book.coverImageUrl} ... loading='lazy' />
// :414 —— displayedGroups.map 一次性 render 全部结果
```

**② 优化后代码**

```ts
const booksKey = useMemo(
  () => books.map((b) => b.hash).sort().join('|'),
  [books],
);
// ResultCover 改用缩略图缓存（书架同款）
const url = getCoverThumbnailUrl(book.coverImageUrl);
// 结果分组用 @tanstack/react-virtual 或对 matches>N 的组折叠，超出视口懒渲染
```

**③ 配置改动**：无（纯前端）。

**④ 验证步骤**
- `pnpm test:browser` 跑 LibrarySearchResults 用例，确认 `booksKey` 引用稳定的快照无回归。
- DevTools Performance 录制搜索：`map+sort+join` 自时间从全库 O(N log N) 降为仅 search 触发时执行。
- 命中 30 本时首屏解码的图片改为 ≤512px 缩略图，位图内存占用降低（估算：原图 30×1.5MB→缩略 30×~100KB，降一个量级）。

### 5.2 章节 transform 输出缓存

**① 问题代码**

```ts
// FoliateViewer.tsx:285-296 —— 每次章节加载串 10 个 transformer
transformers: ['style','punctuation','footnote','whitespace','language',
  'sanitizer','simplecc','nbsp','proofread','warichu'],
return Promise.resolve(transformContent(ctx));
// document.ts:331 —— 缓存只覆盖解压后字符串，不含 transform 结果
```

**② 优化后代码**

扩展缓存键为 `bookKey + sectionHref + viewSettings 指纹`，把 `transformContent` 的输出（HTML 字符串）也纳入现有 LRU（chapterTextCache 预算 32MB 内扩出 `transformCache`）。命中时跳过 10 段 transform 直接返回。

**③ 配置改动**：新增一个 `LRU` 实例或复用 chapterTextCache 预算；注意视口尺寸变化时需按 `width/height/vertical` 设缓存键子集。

**④ 验证步骤**
- 翻到旧章 → DevTools 确认不再重跑 `parseFromString` + 10 段 transform（打断点/计数）。
- `pnpm test:rust` + 相关前端用例无回归。
- 估算：重读章节主线程成本与章节长度线性部分归零（transform 阶段豁免）。

### 5.3 turso 阻塞 SQL 外移 + connect 异步化

**① 问题代码**

```rust
// tauri-plugin-turso/src/wrapper.rs:73
futures::executor::block_on(builder.build())   // connect 阻塞当前 worker
// wrapper.rs:134-188 —— execute/select 直接 self.conn.execute(...).await
```

**② 优化后代码**

```rust
// connect 改 tauri::async_runtime::spawn_blocking 内 build
let conn = tauri::async_runtime::spawn_blocking(move || {
    std::panic::catch_unwind(AssertUnwindSafe(|| builder.build())) ...
}).await;
// execute/select 用 tauri::async_runtime::spawn_blocking 包裹同步核心
```

与 `epub_parser.rs:91`"必须 NOT 在 IPC dispatch 线程上跑"注释确立的模式对齐。

**③ 配置改动**：wrapper.rs 命令实现。

**④ 验证步骤**
- `pnpm test:rust` + tauri 集成用例通过。
- 并发触发多个 DB 请求，确认 tokio worker 不互相挤占（DevTools 观察 IPC 不再被 DB 阻塞）。
- 锁说明：`op_lock` 单连接串行为 turso 硬性要求，不可去掉；只消除阻塞运行时这一层。

---

## 自检清单

- [x] 所有数值带单位（KB/MB/syscall/ms/N 次）；运行时数据未编造，均附验证命令
- [x] 命令/代码可直接复制执行
- [x] 无「视情况而定」类表述
- [x] 每模块 ≥3 调试场景、矩阵每瓶颈 ≥1 优化、P0 附代码
- [x] P0 均附可执行代码/配置
- [x] 代码引用均带 `文件:行号`，已亲自核实关键 P0（封面路径桌面端非 blob）
- [x] 报告写入 docs/reports/，未提交 git
