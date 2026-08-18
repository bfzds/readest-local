# Readest Local 非侵入式调试与性能分析报告（2026-08-14）

- **日期**：2026-08-14
- **分支/HEAD**：`readest-local` @ `3f920eb`（工作区干净，无未提交改动）
- **性质**：**只读调研**。除本报告文档外，未创建、修改、删除任何代码文件、配置文件或项目结构。仅执行了阅读、运行（测试/基准/类型检查/应用启动采样）、监控（进程内存与 CPU 采样）与记录。
- **环境**：Windows x64；AMD Ryzen 7 3700X（16 逻辑核）；15.9 GB 内存；Node v24.14.0 / pnpm 11.1.1 / Rust 1.97.1；Microsoft Edge WebView2。
- **方法**：4 个并行子代理分模块深读（前端 store/阅读器流程、foliate-js 渲染引擎、Rust 后端、服务层）+ 本人逐条复核关键代码路径 + 全套测试/静态检查/基准实测 + release 便携版运行时采样。

> 基线文档：`reports/debug-performance-report-2026-08-13.md`（上轮深报告，B1–B16）、`reports/debug-report-2026-08-13.md`（上上轮系统调试）、`reports/performance-overhead-2026-08-11.md`（架构估算）。自 2026-08-13 报告后新增 4 个修复提交（`7e93107`、`d727bf6`、`5f0267d`、`3f920eb`），本报告**逐条复核上轮全部缺陷现状**，并新增此前未记录的问题。

---

## 目录

1. [项目概况](#1-项目概况)
2. [模块清单](#2-模块清单)
3. [验证基线：测试与静态检查](#3-验证基线测试与静态检查)
4. [上轮缺陷复核（B1–B16）](#4-上轮缺陷复核b1b16)
5. [新发现缺陷](#5-新发现缺陷)
6. [性能实测数据](#6-性能实测数据)
7. [逐模块性能对比](#7-逐模块性能对比)
8. [瓶颈定位与优化建议](#8-瓶颈定位与优化建议)
9. [风险提示](#9-风险提示)
10. [结论](#10-结论)
11. [附：证据清单与复测方法](#11-附证据清单与复测方法)

---

## 1. 项目概况

Readest Local 是 Readest v0.12.1 的纯本地离线分支：桌面电子书阅读器，支持 EPUB/PDF/MOBI/AZW3/FB2/CBZ/TXT/Markdown，含滚动/翻页双模式、书架、全文搜索、高亮/书签/笔记、本地词典（MDict/StarDict/SLOB/BGL）、本地 TTS（含 EPUB 3 Media Overlays）、字体/布局/主题自定义、代码高亮、文件关联、备份/导出。已移除全部联网功能（云同步、在线词典/翻译、AI、订阅、更新检查、遥测），CSP 收紧为本地协议，AGPL-3.0。

**技术栈**：

| 层 | 技术 |
|---|---|
| 桌面壳 | Tauri 2.11.5（仓库内 vendored patch：`packages/tauri`、`packages/tao`、`packages/swift-rs`、`packages/tauri-plugins/plugins/fs`） |
| 前端 | Next.js 16.2.11（`--webpack` 构建 + 静态导出 `out/`）、React 19.2.8、zustand 5.0.10、Tailwind/daisyUI、Radix UI、i18next |
| 渲染引擎 | foliate-js（git submodule，HEAD `0a2c5fc`，含 2 个本地修复提交）、PDF.js（`public/vendor/pdfjs`）、KaTeX、highlight.js |
| 数据库 | Turso/SQLite（`@readest/turso-database-wasm` + Rust `tauri-plugin-turso`，WAL、Tantivy 可用但未采用） |
| 中文相关 | simplecc-wasm（简繁转换）、jieba-wasm（分词） |
| Rust 后端 | `apps/readest-app/src-tauri`（Readest v0.2.2）+ 4 个自定义插件（turso、native-bridge、native-tts、webview-upgrade） |

**规模**（本仓库，不含 node_modules/构建产物）：

| 目录 | 文件数 | 行数 |
|---|---|---|
| `apps/readest-app/src/app`（页面与阅读器组件） | 202 | 45,158 |
| `apps/readest-app/src/services` | 104 | 22,241 |
| `apps/readest-app/src/utils` | 105 | 14,315 |
| `apps/readest-app/src/components` | 91 | 12,987 |
| `apps/readest-app/src/store` | 16 | 3,596 |
| `apps/readest-app/src-tauri/src` | 15 | 3,862 |
| `apps/readest-app/src-tauri/plugins` | 34 | — |
| `packages/foliate-js`（view.js/paginator.js/overlayer.js） | 3 | ~4,800 |
| 前端测试 | 406 文件 | 5,508 用例 |

**磁盘占用**：`target/` 构建缓存 30.5 GB、`.next/` 4.5 GB（cache 2.6 GB + dev 1.9 GB）、`out/` 34.8 MB、便携版目录 171.9 MB（exe 51.3 MB）。

---

## 2. 模块清单

| 模块 | 位置 | 职责 | 关键入口 |
|---|---|---|---|
| M1 书架/书库 | `src/app/library/*`、`src/store/libraryStore.ts` | 书单加载/排序/分组/筛选、封面、最近阅读、窗口生命周期 | `page.tsx`（1,897 行）、`Bookshelf.tsx`、`GroupingModal.tsx` |
| M2 阅读器渲染 | `src/app/reader/*`、`packages/foliate-js` | 打开/复用阅读窗口、翻页/滚动、字号主题、标注、导航、TTS 联动 | `FoliateViewer.tsx`、`useBooksManager.ts`、`usePagination.ts`、`ReaderContent.tsx` |
| M3 全文搜索 | `src/services/librarySearch*`、`src/utils/*Search*`、`src/workers` | 逐本搜索（contains/fuzzy/nearby/regex）、`search.db` 索引缓存、Worker 匹配 | `librarySearchService.ts`（965 行）、`librarySearchIndex.ts` |
| M4 导入/解析 | `src/services/ingestService.ts`、`src-tauri/src/{epub,mobi}_parser.rs`、`src/libs/document.ts` | 文件导入、EPUB/MOBI/PDF 解析、封面提取、目录构建 | `parse_epub_full`、`Mobi::from_path`、`computeBookNav` |
| M5 服务层 | `src/services/` | 备份/恢复、统计、词典、TTS、设置持久化 | `backupService.ts`、`statisticsDb.ts`、`dictionaries/*`、`tts/*` |
| M6 窗口/进程管理 | `src/utils/window.ts`、`readerWindowWatchdog.ts`、`src-tauri/src/lib.rs` | 双窗口复用（Plan A）、隐藏/唤醒、崩溃看门狗、退出保存 | `tauriHandleOnCloseWindow/MainWindow`、`startReaderWindowWatchdog` |
| M7 存储层 | `src-tauri/plugins/tauri-plugin-turso` | SQLite 连接管理、事务、路径校验 | `wrapper.rs`（275 行）、`commands.rs` |
| M8 平台层 | `src-tauri/src/{macos,windows,linux}` | 交通灯按钮、系统词典、目录扫描、窗口状态 | `traffic_light.rs`、`system_dictionary.rs`、`dir_scanner.rs`、`window_state.rs` |
| M9 工具链 | `bench/`、`scripts/`、`docs/` | 基准、构建脚本、离线审计 | `bench/index.ts`、3 个 `.bench.ts` |

---

## 3. 验证基线：测试与静态检查

| 检查项 | 命令 | 结果 |
|---|---|---|
| 单元测试 | `pnpm test`（vitest + jsdom） | **405 文件通过 / 5,498 用例通过 / 10 跳过 / 0 失败**，耗时 152.6 s |
| 类型检查 | `tsgo --noEmit` | ✅ 通过（1,070 文件，1,324 ms） |
| 前端 lint | `biome lint .` | ✅ 通过 |
| Rust lint | `cargo clippy -p Readest --no-deps -D warnings` | ✅ Readest 自身零警告（仅 vendored `tauri-macros` 有 1 条 linker 信息） |
| Rust 单测 | `cargo test -p Readest --lib` | ✅ **53/53 通过**（epub/mobi/range_file/window_state 各模块） |
| 基准 | `pnpm bench` | ❌ **Windows 上不可运行**（见 TF1/TF2），已绕过 harness 直接跑通 bench 主体 |
| 运行时采样 | release 便携版启动 | ✅ 可启动，数据见 §6 |

> 说明：`pnpm lint` / `pnpm test` 在 PowerShell `2>&1` 下显示 exit 1 属 stderr 重定向伪影；分开执行的 tsgo、biome、vitest 全部通过，无真实失败。

---

## 4. 上轮缺陷复核（B1–B16）

上轮报告（2026-08-13）的 16 项缺陷与闭环项，在本轮代码中的现状如下。行号为当前 HEAD。

| 编号 | 缺陷 | 现状 | 证据（当前代码） |
|---|---|---|---|
| B1 | 搜索索引重建风暴（`updatedAt` 双语义） | ✅ **已修复** | `librarySearchIndex.ts:91-92` `isSearchIndexFresh` 改用 `bookHash === book.hash` 判定，与阅读进度解耦；`updatedAt` 仅作历史字段 |
| B2 | reader 换书 viewState 泄漏 | ✅ **已修复** | `useBooksManager.ts:145-149` 生成新 key 时对旧 key `view.close()` + `clearViewState`；`MAX_HISTORY=3` 剪枝 `bookDataStore`（`:116-123`） |
| B3 | 看门狗杀僵尸后不唤醒书库 | ✅ **已修复** | `readerWindowWatchdog.ts:43-52` destroy 后 `show()+unminimize()+setFocus()`，均带 `.catch` |
| B4 | 翻页级联重渲 | ⚠️ **部分修复（残留见 NF3）** | `useLibrary.ts:11-12` 已 per-field selector；`readerStore.setProgress:398` 拆分出 `readerProgressStore`，**47 处 `useReaderStore()` 无 selector 订阅已确认不再随翻页重渲**（`setProgress` 不再调用 readerStore 自身 `set()`）；但 `setProgress` 仍对 primary view 每页 `bookDataStore.setState`（`readerStore.ts:438-456`）+ 每页 `updateBookProgress` 的 O(n) `slice+filter` 全库拷贝（`libraryStore.ts:118-123`，reader 窗口内无消费方、纯浪费） |
| B5 | foliate mediaOverlay 高亮 `=` 误用赋值 | ✅ **已修复** | `foliate-js/view.js:289` → `find(x => x.index === resolved.index)`（子模块提交 `1750809`） |
| B6 | foliate 拖选翻页死代码 | ⚠️ **有意保留** | `paginator.js:1563` 恒 false 条件仍在，但已加注释明确"dead by construction，勿在未复测 Android WebView 前修改"（提交 `0a2c5fc`） |
| B7 | 双窗口并发重建 search.db 竞态 | ⚠️ **部分修复** | `beginSearchIndex` 三表清空已原子化（`librarySearchIndex.ts:102-106`）；`completeSearchIndex` 校验 section 数才置 complete（`:143-154`）。**但无跨窗口互斥**，双窗口仍可能重复整本重建（见 SF3） |
| B8 | 关闭阅读页书库全量重载 | ⚠️ **部分修复** | `page.tsx:534-544` 去掉 settings 重载、数据加载与窗口恢复并行；但仍是**整库 `loadLibraryBooks` + `setLibrary`**，数千本时仍 O(n) 磁盘读+解析+书架重渲 |
| B9 | `open-book` 事件丢失 | ❌ **仍存在** | `nav.ts:67-69` `emitTo` 仅 `.catch` 吞掉 rejection，不重试/降级；reader 重建窗口的监听时序缺口仍在 |
| B10 | 读者侧急切解析全部结果 CFI | ⚠️ **部分修复** | `SearchBar.tsx:274-298` 改为**搜索结束后一次性批量** `resolveSearchResultCfis`（按 section 分组、每 section 只 `createDocument` 一次），仍是"全量急切"而非库页的"点击懒解析"（见 SF8） |
| B11 | EPUB manifest 百分号编码键未命中 sizes map | ⚠️ **部分修复** | `epub_parser.rs:496-504` 读字节已加 percent-decode 回退（有单测 `read_zip_entry_falls_back_to_percent_decoded_name`）；但 **sizes map 仍按原始 `entry.name()` 建键**（`:315`），`%20` href 仍会 miss → JS 回退 zip.js（见 RF6b） |
| B12 | 键盘焦点导航 DOM 属性累积 | ✅ **已修复** | `paginator.js:3106-3125` `#lastFocusedNode` 先清旧节点的 `tabIndex/outline` 再设新节点（提交 `0a2c5fc`） |
| B13 | 窗口销毁/退出无 `.catch`/不 flush | ✅ **已修复** | `window.ts:83/92/98` 全部 `.catch`；`tauriQuitApp:182-184` await 事件 flush；`ReaderContent.tsx:172` 带 catch |
| B14 | search.db WAL 不折叠 | ✅ **已修复** | `librarySearchService.ts:359-372` 30 s 周期 `wal_checkpoint(TRUNCATE)` + `session.close()` 前逐库 checkpoint（`:429-437`） |
| B15 | `GroupItem` 定时器未清理 | ✅ **已修复** | `GroupItem.tsx:53-64` effect 清理 |
| B16 | MOBI 整文件读入堆 | ❌ **仍存在** | `mobi_parser.rs:74/107` `Mobi::from_path` 仍整文件读取（50–100 MB 峰值 ≈ 文件大小）；模块注释自述"50MB AZW3 需数十 ms"（见 RF6） |

**上轮"已闭环"项复核**：Alt+F4 无窗口兜底（`page.tsx:529-543`）✅；崩溃看门狗（`page.tsx:557-562`）✅；web 白屏守卫（`nativeAppService` 初始化守卫 + EnvProvider 提示界面）✅；SSR 测试 30 s 超时 ✅；README 同步 ✅。

**复核结论**：上轮 16 项中 **9 项完全修复、5 项部分修复、2 项仍存在**（B9、B16），1 项（B6）为有意保留的已注释死代码。修复质量总体可靠，均有配套测试或注释说明。

---

## 5. 新发现缺陷

严重度分级：🔴 严重（用户可感知/安全/稳定性）、🟠 中等、🟡 轻微。

### 5.1 前端（React 状态与窗口流程）

| 编号 | 严重度 | 位置 | 描述 | 根因 | 影响 |
|---|---|---|---|---|---|
| NF1 | 🟠 | `page.tsx:537-544` | `Promise.all([loadLibraryBooks, show().then(unminimize+setFocus)])` 将**磁盘加载与窗口操作耦合**：`unminimize/setFocus` 任一 reject，整个 Promise.all 拒绝，`setLibrary` 不执行 | 用 `Promise.all` 并行化时未隔离失败域 | 书库窗口数据不刷新（书架显示旧进度）；reject 在 listen 回调内无 try/catch → unhandled rejection |
| NF2 | 🟠 | `window.ts:83` | reader 关闭时先排 `setTimeout(destroy, 500)`，**500 ms 硬宽限与异步保存赛跑** | destroy 被无条件调度，不感知保存是否完成 | 书签/笔记/进度较多时保存超 500 ms 会被截断 → 关闭即丢数据 |
| NF3 | 🟠 | `readerStore.ts:438-456`；`useBookDataStore()` 26 处无 selector 订阅 | **残余 B4**：`setProgress` 对 primary view **每页/每动画帧**执行 `bookDataStore.setState`（生成新 `booksData` 引用），26 处 `useBookDataStore()` 无 selector 订阅组件（约 22 处位于 reader 树内：`SideBar.tsx:38`、`Notebook.tsx:48`、`FooterBar.tsx:29` 等常驻组件）整树重渲；另有每页 `updateBookProgress` 的 O(n) `slice+filter` 拷贝（`libraryStore.ts:118-123`）reader 窗口内无订阅方消费 | 拆分 readerStore 时未同步改造 bookDataStore 订阅；每页写库本无渲染需求 | 翻页动画期间每帧数十组件重渲 + O(n) 数组分配，长章节+复杂侧栏时掉帧 |
| NF4 | 🟡 | `readerStore.ts:418-419`；`ReadingProgress.tsx:22` | `progressPercentage = round((current+1)/total*100)`：`total===0` 时 `1/0=Infinity` → `>=100` → 书被**误标 finished** | 分页未完成/异常时 total 可能为 0，无除零守卫 | 罕见时序下阅读状态错乱（unread→finished 不可逆） |
| NF5 | 🟡 | `useBooksManager.ts:64-70, 87-93` | `goToCfiWhenReady`/`startTTSWhenReady` 的 zustand `subscribe` 无超时、无卸载清理：view 初始化悬挂（不 error 也不 inited）时订阅**永不解除** | 依赖 `done` 终止条件，无兜底 | 每次深链打开累积一个僵尸订阅 |
| NF6 | 🟡 | `useBooksManager.ts:139-155` | reader 窗口内换书只更新本窗口的 libraryStore 内存副本，主窗口 store 靠关闭时全量重读对齐 | 双窗口各自持有完整 library 数组 | 窗口间数据短暂不一致；主窗口关闭时全量刷新放大 B8 成本 |
| NF7 | 🟡 | `useProgressAutoSave.ts:27-48, 73-80` | 卸载只 flush 库级节流（`flushPendingLibrarySave`），**不 flush 每本书的 debounce 定时器**；`tauriQuitApp` 的 `exit(0)` 可在 500 ms 延迟保存前杀进程 | debounce+setTimeout 两段延迟与退出路径无联动 | 快速关闭/退出时最后一页进度丢失（库页靠 config.json 兜底重建，但不保证） |
| NF8 | 🟡 | `ReaderContent.tsx`（handleCloseBooks 节流包装） | 节流包装函数每次渲染重建，卸载时可能残留待触发定时器；快速开关书时旧定时器与新书交互 | 未用 `useRef` 稳定节流实例 + 无清理 | 偶发重复保存/关闭错位 |
| NF9 | 🟡 | `window.ts:96-101` | 主窗口（非 reader）关闭路径 destroy 前**不 flush 待保存数据** | 主窗口关闭=退出，无 `flushPendingLibrarySave` | 退出瞬间丢失 30 s 节流窗口内的库写入（有 config.json 兜底，风险低） |
| NF10 | 🟡 | `useBooksManager.ts:145-149` | B2 修复中旧 view 的 `close()` 未 await，快速连续换书时异步 teardown 与新 key 初始化重叠 | fire-and-forget 清理 | 极快换书偶发资源竞态（低概率） |

### 5.2 foliate-js 渲染引擎

| 编号 | 严重度 | 位置 | 描述 | 根因 | 影响 |
|---|---|---|---|---|---|
| HF1 | 🔴 | `view.js:284-305`（配合 `epub.js:555-606`） | **mediaOverlay 高亮类累积**：`highlight` 只 `classList.add(activeClass)`，清理委托给 `unhighlight`；但 SMIL 驱动在"同一音频内连续推进到下一 item"时**只发 highlight 不发 unhighlight**（`epub.js:585-586`） | highlight/unhighlight 按固定配对设计，源头可能背靠背连发 highlight | 有声书连续播放时**多个 span 同时保持高亮**，视觉错乱 |
| HF2 | 🔴 | `paginator.js:406-474, 3169-3205` | **每翻一页整章 O(N) 强制布局读取**：`getVisibleRange` 用 TreeWalker 遍历整个 `doc.body`，对每个元素 `getBoundingClientRect()`、每个非空文本节点 `createRange+getBoundingClientRect()`（**先量矩形再判可见**，视口上方全部节点不跳过），`bisectNode` 边界再叠 O(log n) | 无视口邻域剪枝/分栏缓存，无"从上一锚点双向扩散" | 长章节（数千–数万节点）每翻一页 10–200 ms 主线程卡顿；多 view 预载路径再乘 ~8（`:3186-3199`）；滚动 settle 重复计算（`:1441-1446`） |
| HF3 | 🟠 | `overlayer.js:344-420`（`:350, 354-357`） | `Overlayer.bubble` **原地修改存储的 rect 数组**（`splice(1)` + 改 `firstRect` 字段）；`hitTest`（`:160-177`）复用同一数组 | draw 回调拿到的是存储引用而非副本 | 同一 key 重复 bubble 后命中检测/绘制基于被裁剪的几何，标注点击错位 |
| HF4 | 🟠 | `view.js:288-291` | highlight handler 对 `getContents().find(...)` 结果**无判空解构**：目标 section 的 view 未加载/已销毁时 `find` 返回 undefined → `TypeError` 抛在 `.then` 内无 catch → unhandled rejection，高亮丢失 | 依赖"目标 view 一定在 contents 中"的隐含前提 | 快速 SMIL 导航时偶发高亮丢失 + 控制台报错 |
| HF5 | 🟡 | `paginator.js:3105-3126` | B12 的焦点样式清理只在 `reason === 'navigation'` 生效；键盘选择（`:1569`）与 `focusin`（`:1572-1577`）路径走默认 reason，不触发清理 | 清理范围限定过窄 | 目前这两条路径不设内联样式，无实际泄漏；未来若复用需注意 |

### 5.3 Rust 后端

| 编号 | 严重度 | 位置 | 描述 | 根因 | 影响 |
|---|---|---|---|---|---|
| RF1 | 🔴 | `src/macos/traffic_light.rs:13-14, 54-66, 201-203` | **`static mut` 无同步数据竞争（UB）**：`TRAFFIC_LIGHTS_VISIBLE` / `TRAFFIC_LIGHT_HEADER_HEIGHT` 由 IPC 命令线程写（`:55-57`），AppKit 主线程回调读（`:132-137, 201-203`），无原子/锁；写 `static mut` 并发即 UB | 平台状态用全局可变静态度量，未做同步 | macOS 上随机读取到撕裂值，交通灯定位漂移；优化构建下属未定义行为 |
| RF2 | 🔴 | `src/dir_scanner.rs:22` | **ACL 绕过**：范围校验是 `!scope.is_allowed(path) && !path.contains("Readest")`——任何**路径字符串含 "Readest" 子串**的目录（如 `C:\xx\MyReadestData\...`）直接绕过 `fs_scope`，`read_dir` 递归返回该目录全部文件路径+大小 | 子串兜底写成 OR 放行 | 枚举任意目录内容（路径/大小泄露）；配合能力面（S2）放大 |
| RF3 | 🟠 | `plugins/tauri-plugin-turso/src/wrapper.rs:68` | `builder.build().await?` **未按本插件 AGENTS.md（"wrap in AssertUnwindSafe + catch_unwind → Error::InvalidDbUrl"）包裹**；turso builder 对畸形 URL 会 `unwrap()` panic | 文档约定未落实 | 畸形 `LoadOptions.path` 使 panic 逃出 async 任务 → IPC promise 悬挂、runtime worker 可能损坏 |
| RF4 | 🟠 | `wrapper.rs:84-86` | `resolve_local_path` 对**绝对路径原样放行**，`..`/base_path 包含校验只走相对路径分支 | 绝对路径分支无校验 | `load("sqlite:/任意路径")` 可在 base_path 外打开/写库，与插件"拒绝逃逸路径"约定矛盾 |
| RF5 | 🟠 | `plugins/tauri-plugin-native-bridge/src/desktop.rs:100` | `font_enumeration::Collection::new().unwrap()` 在 async 命令处理器上直接运行 | 无条件 unwrap 可失败系统枚举 | 系统字体枚举失败 → 命令 panic，IPC 永不返回 |
| RF6 | 🟠 | `src/mobi_parser.rs:74, 107` | **B16 未修 + panic 未包裹**：`Mobi::from_path` 整文件读堆，且在 `catch_cover_panic`（`:131-142`）**之外**调用；mobi crate 对损坏 PDB 偏移会 slice-index panic | 解析库的容错边界未覆盖整文件解析阶段 | 50–100 MB MOBI 每次导入/提取封面整读（数百 ms + 100 MB 级内存）；损坏文件导致整本导入失败（spawn_blocking 内被 JoinError 兜住，不崩进程） |
| RF6b | 🟡 | `src/epub_parser.rs:315` | sizes map 仍按原始 `entry.name()` 建键，`%20` href miss（B11 残项） | 键未统一 percent-decode | 仅性能损失：JS 回退 zip.js 重新开包 |
| RF7 | 🟠 | `src/parser_common.rs:62-94` | 封面 `image::load_from_memory` **全量解码且无像素/尺寸上限** | 无解压炸弹防护 | 恶意超大尺寸封面 = 无界内存/时间；4 并发导入时峰值无总量控制 |
| RF8 | 🟡 | `src/window_state.rs:75` | `std::fs::write` 非原子覆盖窗口状态文件 | 无 temp+rename | 写盘中途崩溃 → 状态文件损坏（下次启动 sanitizer 可兜底，低风险） |
| RF9 | 🟡 | `src/macos/traffic_light.rs:344,361,378,420`、`macos/window.rs:180` | AppKit 回调内 `.expect("Failed to emit event")` / `.lock().unwrap()` | 主线程回调直接 panic | 事件发送失败或锁中毒 → 主线程崩溃（窗口生命周期事件路径） |
| RF9b | 🟡 | `lib.rs:155,237,399,406,436`、`macos/menu.rs:15` | 主线程/启动路径的 `.unwrap()`/`.expect()`（`get_webview_window("main")`、`emit`、`win_builder.build()`、`run()` 等）——**进程级 abort 清单**：与 spawn_blocking 内解析器 panic（被 JoinError 兜住、只使该 IPC 失败）不同，这些 panic 直接终止进程 | 主线程代码无 unwind 兜底 | 仅限内部不变量/启动时序异常时触发；`lib.rs:155` 在 argv 带文件但窗口未就绪时可能命中 |
| RF9c | 🟡 | `capabilities-extra/webdriver.json`、`webdriver-remote.json` | webdriver 测试能力文件给远程 `http://127.0.0.1:*` 页面授权 `fs:write-all` 等 | 仅 `webdriver` feature / `--config` 测试覆盖时才挂载 | 生产构建不携带（已核实 inert）；**不要**在发布构建开启 `--features webdriver` |
| RF10 | 🟡 | `plugins/tauri-plugin-native-bridge/src/platform/macos.rs:169-199` | iCloud 文件下载轮询 `thread::sleep(250ms)` 最长 60 s，**在 async 命令内同步阻塞 tokio worker**（无 spawn_blocking） | 同步轮询放进 async 函数 | 单个慢速 iCloud 下载阻塞该 tokio worker 60 s，拖累并行异步任务 |

### 5.4 服务层

| 编号 | 严重度 | 位置 | 描述 | 根因 | 影响 |
|---|---|---|---|---|---|
| SF1 | 🟠 | `librarySearchIndex.ts:234-241` | `buildSearchIndexNodes` 后处理为 **O(n²)**：每个节点内层线性扫后续节点找下一同级 | 朴素双循环 | 2,000 章 TOC ≈ 200 万次比较；建索引时主线程耗时（未进 Worker） |
| SF2 | 🟠 | `librarySearchIndex.ts:122-128, 249-263` | 索引写入**逐节 DELETE+INSERT、逐节点 INSERT**，无 `batch()` 事务 | 未做批量写入 | 500 节书 ≈ 1,500 次 Rust IPC 往返；重建延迟显著 |
| SF3 | 🟠 | `librarySearchService.ts`（搜索主循环） | **双窗口并发建同一本书索引无互斥**（B7 残项）：`indexDbs` 缓存是会话级（每窗口一份），`beginSearchIndex` 只原子清空 + `completeSearchIndex` 只做数量校验 | 缺进程内"book.hash → in-flight build"互斥表 | 两窗口并发首搜同一本书时重复整本重建（双倍工作）；交错写入因内容确定性同源，仅余性能损失 |
| SF4 | 🟠 | `backupService.ts:340-354` | web 端 `createBackupZip` 将**整库 + 全部书籍数据构造成内存 zip**（web 分支） | 无流式/分块 | 大书库备份时内存峰值≈库+书数据总量；触发 GC 压力甚至 OOM |
| SF5 | 🟠 | `backupService.ts:453-507` | 恢复流程**非原子**：清库/写库多步无事务；`483/501/529` 校验不足 | 恢复无整体校验与回滚 | 恢复中断 → 半恢复状态；部分字段未校验直接写入 |
| SF6 | 🟠 | `services/statistics/statisticsDb.ts:131-141` + `ReadingStatsTracker.tsx:64-97` | **阅读统计每次翻页写库**（读时段/页数累计），无节流 | 逐事件直接写 | 长时间阅读的 IPC 写入放大；WAL 增长 |
| SF7 | 🟡 | `librarySearchWorker.ts`（worker 消息队列） | 搜索 worker 的 pending 消息无上限/无取消清理，快速连续搜索时旧消息堆积 | 未做队列管理 | 高频搜索时 worker 积压、结果错位风险 |
| SF8 | 🟡 | `SearchBar.tsx:274-298` | B10 残项：读者侧搜索完**一次性解析全部结果 CFI**（上限 2,000）后再渲染；库页为点击懒解析 | 读者侧需要 CFI 供 foliate in-page 高亮，属设计权衡但成本前置 | 搜索完成到结果可见之间增加整书重走 DOM 的耗时（多 section 时数百 ms） |
| SF9 | 🟡 | `SearchBar.tsx`（搜索事件循环） | **忽略 `event.truncated`**：命中全局上限（2,000/500）后静默截断，无"结果不完整"提示；库页有 "N+ 结果" 提示 | 截断标记未传到 UI | 用户误以为结果完整（一致性缺陷） |
| SF10 | 🟡 | `services/dictionaries/*` | 词典缓存无上限、blob URL 驻留：MDict `trackedUrls` 数组随每次查询的图片/音频 `createObjectURL` 无界增长（`mdictProvider.ts:661-670`，`data-mdd-audio/data-mdd-resolved` 直到 `dispose()` 才 revoke）；StarDict 首次读取即**整包 gunzip `.dict.dz`**（`starDictProvider.ts:8-10`）；MDict 急切加载整个 MDD 音频包（`mdictProvider.ts:435-476`） | 未做 LRU/释放/懒切片 | 多词典长会话内存缓慢增长；大词典首查/启动峰值内存高 |
| SF11 | 🟠 | `backupService.ts:483, 501, 529` | **恢复路径穿越**：`restoreFromBackupZip` 直接按 `entry.filename` 写盘，**不拒绝 `../`、绝对路径、盘符前缀**；`orphanHashes/bookDir` 过滤只约束已知 book hash 目录 | 恢复入口未做 entry 名校验 | 从不可信备份 zip 恢复时可**越界写任意文件**（arbitrary file write） |
| SF12 | 🟡 | `services/statistics/statisticsDb.ts`（`page_stat_data` 表） | 页级统计表**无 TTL/裁剪**：每 (book,page,start_time) 一行、只汇总不删除，`getMedianPageDurationSecs` 只读最近 50 条 | 无聚合清理任务 | 长期使用磁盘/WAL 逐年增长 |
| SF13 | 🟡 | `librarySearchIndex.ts:276-285` | **LIKE 预筛无长度/行数上限**：`MINIMUM_SEARCH_TERM_LENGTH_CJK=1` 使单字中文查询可命中全部 section（全量载入+匹配）；`loadSearchIndexSections` 无 LIMIT | 候选行无 cap | 退化查询扫描成本不受限（结果上限只挡产出、不挡扫描） |
| SF14 | 🟡 | TTS：`WebSpeechClient.ts:33-72`、`MediaOverlayClient.ts:273-301`、`NativeTTSClient.ts:326-332` | TTS 三处清理缺口：① Web Speech 长句**中途无法打断**（`signal.aborted` 仅在 utterance `onend` 后才检查）；② MediaOverlay `#waitUntil` 的 interval/listener 在 abort 未走 `finish` 时可能残留，逐段轮询到块生命周期结束；③ `NativeTTSClient.shutdown()` 先移除监听再 `stop()`，in-flight speak 的 `#activeUtterances` 条目可能遗留 | 中止/关闭路径未覆盖清理 | 停止延迟（Web Speech）、每段定时器/监听残留、少量内存驻留 |

### 5.5 工具链与环境

| 编号 | 严重度 | 位置 | 描述 | 根因 | 影响 |
|---|---|---|---|---|---|
| TF1 | 🟠 | `bench/index.ts:36` | **bench harness 在 Windows 上不可运行**：`import(resolve(BENCH_DIR, file))` 对 Windows 绝对路径报 `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'c:'`（实测复现） | 动态 import 需 `pathToFileURL`，未做平台适配 | `pnpm bench` 在 Windows 直接失败；本报告已用 `pathToFileURL` 绕过执行 bench 主体 |
| TF2 | 🟠 | `bench/library-search-turso.bench.ts:46` | `DB_ROOT = new URL(...).pathname` 直接当 fs 路径：Windows 上得 `/C:/Users/...%E9%98%85...`（前导斜杠 + 未解码百分号），`mkdir` 报 `ENOENT 'C:\C:\...'` | 需 `fileURLToPath` | turso 基准在 Windows 无法运行，索引架构数据缺失（README 引用的是 macOS 数据） |
| TF3 | 🟡 | 构建产物 | `.next/` 4.5 GB、`target/` 30.5 GB 磁盘占用（dev 缓存为主） | dev 缓存无清理策略 | 磁盘压力；非运行期问题 |

**环境观察（非代码缺陷）**：审计期间发现本机残留 **18 个孤儿 `msedgewebview2` 进程**（启动时间 09:28–10:33，早于本次 12:22 启动，合计 ≈ 550 MB），来自此前被强杀（`Stop-Process -Force`）的会话——**强制杀主进程不会带走 WebView2 子进程**，多次强杀会累积孤儿进程与内存。正常退出路径（`tauriQuitApp`）不受影响。

---

## 6. 性能实测数据

### 6.1 基准实测（本次新跑，本机）

`bench/library-search`（生产匹配器，不含文件加载/解析）与 `bench/vector-retrieval` 已用 `pathToFileURL` 绕过 harness 跑通；`library-search-turso` 因 TF2 无法运行。**参考列**为 bench README 记录的 Apple M1 Pro 数据（硬件不同，仅作量级对照）。

| 场景 | 本次实测（AMD 3700X / Windows） | 参考（M1 Pro） |
|---|---|---|
| 10 本书、缺失词 contains（英） | **220.7 ms** | ~24 ms |
| 10 本书、缺失词 contains（中） | **389.0 ms** | ~73 ms |
| 100 本混合、缺失词 contains | **1,098.3 ms** | ~0.48 s |
| 1000 本混合、缺失词 contains | **13,362.6 ms** | ~4.8 s |
| 1000 本、首条流式结果延迟 | 0.46 ms | — |
| 常见英文词（限 500 条） | 1.1 ms | ~0.55 ms |
| 常见中文词（限 500 条） | 7.6 ms | ~3.8 ms |
| fuzzy（10 本英/中） | 149.7 / 237.3 ms | 64 / 52 ms |
| fuzzy 100 KB 上限 500 条 | 130.0 ms | — |
| nearby 冷启动（英/中） | 30.4 / 136.0 ms | 7 / 31 ms |
| nearby 预分词（英） | 9.2 ms | — |
| 向量检索 400×768 | 1.07 ms | — |
| 向量检索 10K×768 | 62.3 ms | — |

**解读**：本机绝对耗时约为 M1 Pro 参考值的 2–9 倍（CJK 缺失词扫描 1000 本 ≈ 13.4 s）。CPU 密集点集中在 contains 匹配器（真实文本比合成文本慢 ~6 倍、CJK 再慢 ~3 倍，bench README 已注明）与 `Intl.Segmenter` 词典切分。上限 500/2,000 生效后常见词查询为亚 10 ms 级，命中索引缓存路径（`bookFresh.hit`）远快于 live path。

### 6.2 运行时采样（release 便携版）

| 指标 | 实测值 | 说明 |
|---|---|---|
| 单书库窗口总工作集 | **≈ 405 MB** | 主进程 33 MB + 6 个 `msedgewebview2` 子进程（121/119/70/36/21/9 MB） |
| 12 s → 22 s 采样漂移 | ~+7 MB | 启动期正常增长 |
| 双窗口预期 | ≈ 700–970 MB | 上轮实测区间，本机单窗口 405 MB 与之吻合（每窗口带独立多渲染进程） |
| 强杀残留 | 18 孤儿进程 ≈ 550 MB | 环境观察，见 §5.5 |

### 6.3 测试/静态检查耗时

| 项 | 耗时 |
|---|---|
| vitest 全套（5,498 用例） | 152.6 s（transform 314.6 s / setup 9.4 s / tests 139.9 s） |
| tsgo 类型检查 | 1.3 s |
| biome lint | 1.3 s |
| cargo clippy + 53 单测 | clippy 编译 2 m 42 s（dev profile）+ 测试 37 s |
| bench（library-search 23.1 s + vector-retrieval 16.3 s） | 39.4 s |

### 6.4 逐模块耗时/资源结构（代码路径量化）

| 模块 | 主要成本结构 | 量级（依据） |
|---|---|---|
| 全文搜索 live path | 每本 openDB（~1.2 ms，README 实测）+ 逐节 `createDocument`+`prepareSearchSection` + 逐节 DELETE+INSERT 写库（SF2）+ TOC O(n²)（SF1）+ 匹配器扫描 | 1000 本缺失词 13.4 s（本机实测）；重建风暴已消除（B1 修复后 `bookFresh.hit` 命中缓存路径） |
| 长章节分页 | 整章 CSS 多栏一次性布局 + 每翻一页 `getVisibleRange` 整章 TreeWalker + 每节点 1–2 次 `getBoundingClientRect`（HF2）+ `getCFI`（`epubcfi.js fromRange`）| 每页 10–200 ms（估计，依赖章节节点数）；字号/主题/resize 均整章重排、无分页缓存 |
| 翻页热路径（React） | `setProgress` → readerProgressStore 写入 + **primary 每页 `bookDataStore.setState`**（NF3）→ 26 处无 selector 订阅重渲 | 每动画帧一次；库级写入已节流（30 s throttle + 1 s debounce），磁盘写 ~1 次/s |
| 导入/解析 | EPUB：Rust `spawn_blocking` + zip 中央目录 + 大文件直拷（已优化，<0.5 s/100 MB）；MOBI：**整文件读堆**（RF6，B16）；封面解码无像素上限（RF7） | 100 MB EPUB 峰值 <50 MB 内存；50–100 MB MOBI 数百 ms + 等量内存 |
| 首开导航 | `computeBookNav` 逐节 loadText+createDocument 双解析 | 200 节书 300–500 ms（上轮实测；nav.json 缓存生产命中） |
| 字号/主题切换 | `saveViewSettings` 全 bookKeys 逐本 `setStyles`+`saveConfig`+ 整章重排 + overlayer 全量重绘 + 双写盘（.bak 有意保留）；滑块已 120 ms 节流（3f920eb） | 每次变更 100–500 ms（视开书数） |
| 书架/分组 | `sortedBookshelfItems` 全组排序 + `refreshGroups` O(n) MD5 + 关闭阅读页整库重载（B8 残项） | 数千本数百 ms 级 |
| 内存占用 | WebView2 每窗口多渲染进程（单窗口 ≈ 405 MB）+ 禁用后台节流（`lib.rs:346`）+ 3 s 心跳持续 | 双窗口 700–970 MB；viewStates 泄漏已修（B2） |

---

## 7. 逐模块性能对比

按**综合开销（时间+内存+CPU）从高到低**：

| 排名 | 模块 | 综合开销特征 | 主导维度 | 上轮对比 |
|---|---|---|---|---|
| 1 | 全文搜索与索引（M3） | 1000 本缺失词 13.4 s（本机）；live path 逐节 IPC 写库 + TOC O(n²)；**重建风暴已消除**（B1）→ 读过的书命中缓存 | 时间 | ⬇ 显著改善 |
| 2 | 长章节渲染与分页（foliate-js） | 整章多栏一次性布局 + 每翻一页整章矩形遍历（HF2）+ 无分页缓存 | CPU/时间 | ➖ 未变（明确暂缓） |
| 3 | 翻页热路径 React 级联（M2） | 每帧 `bookDataStore.setState` + 26 处无 selector 订阅重渲（NF3） | CPU | ⬇ 部分改善（readerStore 已拆分） |
| 4 | 导入/解析（M4） | EPUB 已高度优化；MOBI 整读（RF6）；封面解码无上限（RF7） | 时间/内存 | ➖ MOBI 未变 |
| 5 | 首开导航构建（M2） | 冷构建 300–500 ms/200 节；nav.json 缓存生产命中 | 时间 | ➖ 未变（有缓存兜底） |
| 6 | 字号/主题/字体切换（M2/M5） | 整章重排 + overlayer 全量重绘 + 逐本写盘；滑块已节流 | 时间 | ⬇ 部分改善（滑块节流） |
| 7 | 书架列表与分组（M1） | 全组排序 + refreshGroups O(n) MD5 + 关阅读页整库重载（B8 残项） | CPU/内存 | ⬇ 部分改善（B8 并行化） |
| 8 | 多窗口内存与后台节流（M6） | 单窗口 ≈ 405 MB；后台节流仍禁用 + 3 s 心跳 | 内存 | ➖ 未变（viewStates 泄漏已修） |
| 9 | scrolled 滚动模式 | `snapScrolledDistanceToLines` 取整节行盒 `getClientRects()` 再排序（O(总行数)） | CPU | ➖ 未变（明确暂缓） |

**关键改善（相对上轮）**：① 搜索重建风暴消除（B1，最大单项）；② 索引新鲜度判定已埋 `perfMark`（`bookFresh.hit`/`index.build`，release 日志可 grep）；③ 结果全局上限 2,000/本 500（3f920eb）；④ 库写入 30 s 节流 + 每书 config.json 即时落盘（容灾保留）；⑤ WAL 30 s 周期 checkpoint（B14）。

---

## 8. 瓶颈定位与优化建议

### 8.1 瓶颈 Top 3（按 ROI）

1. **长章节每翻一页整章布局遍历（HF2）**：唯一"用户每翻一页都在付钱"的 CPU 大头。建议：可见范围计算改为**从上一锚点双向扩散**，仅对视口邻近节点量矩形；或按分栏缓存 `contentPages` 结果、按内容 hash 失效。改动集中在 `paginator.js`（getVisibleRange + afterScroll）。
2. **翻页热路径 bookDataStore 级联（NF3）**：把 primary 的 `setProgress` 内 `bookDataStore.setState` 从每帧改为**节流**（如 1 s 或翻页 settle 时），并把 26 处 `useBookDataStore()` 无 selector 订阅改为 per-field selector（上轮 P1-2 只完成 useLibrary 一处）。这是纯前端改动、收益直接（掉帧改善）。
3. **搜索 live path 逐节 IPC 写库（SF2）+ TOC O(n²)（SF1）**：`writeSearchIndexSection`/`writeSearchIndexNodes` 改 `batch()` 多值事务（1,500 次往返 → 数十次）；TOC 后处理改单遍栈。叠加 `perfMark` 已验证的 `bookFresh` 命中率，重建场景延迟可再降一个量级。

### 8.2 建议优先级表

| 优先级 | 措施 | 涉及 | 预期收益 |
|---|---|---|---|
| **P0（修复即正确性/安全）** | 修 RF1：`traffic_light.rs` 改 atomics/`OnceLock` 消除 `static mut` 数据竞争 | macOS 平台层 | 消除 UB |
| | 修 RF2：`dir_scanner.rs` 去掉 "Readest" 子串放行，仅依 `fs_scope` | 后端命令 | 关闭 ACL 绕过 |
| | 修 RF3：turso builder 按 AGENTS.md 包 `catch_unwind`；RF4：绝对路径也做 base_path 校验 | tauri-plugin-turso | 消除命令级 panic 与越权路径 |
| | 修 SF11：恢复入口拒绝 `../`/绝对路径/盘符 entry 名（只允许 `[hash]/...`） | `backupService.ts:483,501,529` | 关闭不可信备份的任意文件写入 |
| | 修 NF2：`window.ts` reader 关闭的 500 ms destroy 改为"保存完成后 destroy"（带超时兜底） | 窗口/退出 | 关闭不丢进度 |
| **P1（翻页/渲染热路径）** | 见 8.1 ① HF2、② NF3 | foliate-js + 前端 | 每翻一页省 10–200 ms + 每帧 26 组件重渲 |
| | 见 8.1 ③ SF2/SF1 | 搜索索引 | 重建延迟降一个量级 |
| | B8 收尾：关阅读页改增量刷新（只同步进度/阅读状态字段） | `page.tsx:537-544` | 数千本时关阅读页不再整库重读重渲 |
| **P2（稳态与容量）** | 隐藏窗口心跳放宽（3 s→10 s+）或可见才发；评估 `background_throttling` 保持禁用的必要性 | `ReaderContent.tsx:159-163`、`lib.rs:346` | 后台 CPU/电池下降 |
| | 修复 TF1/TF2：bench 用 `pathToFileURL`/`fileURLToPath` 平台适配，让 Windows 可跑 turso 基准 | `bench/` | 获得 search.db 架构的 Windows 基线 |
| | SF4/SF5：web 备份改流式/分块；恢复加事务与校验回滚 | `backupService.ts` | 大库备份内存峰值下降、恢复原子 |
| | SF6：统计写入节流/批量 | `statisticsDb.ts` | 减少翻页期 IPC |
| | NF1/NF7/NF9：`Promise.all` 失败隔离、退出前 flush 全部待保存项 | `page.tsx`、`useProgressAutoSave.ts`、`window.ts` | 消除静默数据不一致与丢保存 |
| | 清理 TF3：.next/target 缓存瘦身或加清理脚本 | 构建产物 | 磁盘 35 GB 级回收 |

**明确不建议优先投入**（上轮已评估，本报告认同）：`safeSaveJSON` 双写（有意崩溃安全设计）、MOBI 自实现 PalmDB 头解析（改动成本/风险高）、getVisibleRange 大改（需 Android WebView 回归）、B6 死代码删除（有显式注释要求复测）。

---

## 9. 风险提示

1. **安全态势（最高风险面）**：`capabilities/default.json:20-21` 给 main/reader 窗口 `fs:read-all` + `fs:write-all`，而 reader 窗口渲染**不可信的 EPUB/HTML 内容**——一旦书内容存在 XSS 向量，攻击者即获近全盘读写。缓解：CSP 已收紧本地协议，但 `shell:allow-spawn` 校验正则 `^.*Readest(.*)\.exe$`（`:126`）未锚定、允许嵌入元字符，`dir_scanner` 的 "Readest" 子串绕过（RF2）进一步削弱 ACL。**另有一处"恢复即写盘"入口**：备份恢复按 `entry.filename` 直写、无路径校验（SF11），不可信备份 zip 可越界写任意文件。**建议在不影响功能前提下收窄能力面**（读限定 `$APPDATA/Readest/**`，spawn 校验改完整路径白名单，恢复入口补 entry 名校验）。
2. **数据丢失**：NF2（500 ms destroy 竞态）、NF7（快速退出丢最后一页保存）、SF5（恢复非原子）三处叠加，异常关闭/恢复中断时存在进度或书库数据丢失窗口。现有 config.json 逐书落盘 + .bak 双写是主要兜底，但不应依赖。
3. **平台特定**：macOS 存在 `static mut` 数据竞争（RF1）、AppKit 回调 unwrap/expect 崩溃路径（RF9）与主线程进程级 abort 清单（RF9b）；iCloud 同步轮询阻塞 async runtime（RF10）。Windows/Linux 不受影响。**macOS 未在本轮实机验证**（本机为 Windows）。
4. **内存稳态**：viewStates 泄漏已修（B2），但双窗口 700–970 MB 基线与后台节流禁用（`lib.rs:346`）仍意味着长会话内存压力；强杀遗留孤儿 WebView2 进程会跨会话累积（本机实测 18 个 ≈ 550 MB）。**请走正常退出，勿强杀**。
5. **工具链缺口**：bench 两处 Windows 缺陷（TF1/TF2）导致 `library-search-turso` 无法在任何 Windows 机器上产出数据——搜索索引架构的回归检测在 Windows 上不可用，建议优先修复。
6. **未覆盖项**：本轮未做 Tauri 集成测试（`test:tauri` 需 webdriver 构建）、Playwright 浏览器测试、以及 reader 窗口的真实翻页动画帧率实测（需要自动化 UI 驱动）；`macOS`/`Linux` 平台路径仅静态审查。以上为后续复测建议方向。

---

## 10. 结论

- **代码质量基线良好**：5,498 个前端用例 + 53 个 Rust 用例全绿，tsgo/biome/clippy 全过；上轮 16 项缺陷 9 项确认修复、5 项部分修复，修复均有测试或注释佐证。
- **最值得优先处理**：macOS `static mut` 数据竞争（RF1）、`dir_scanner` ACL 绕过（RF2）、turso builder panic 未包裹（RF3）、恢复路径穿越（SF11）、reader 关闭 500 ms 销毁竞态（NF2）、每翻一页整章布局遍历（HF2）、翻页热路径 bookDataStore 级联（NF3）。
- **性能主要矛盾已转移**：上轮最大的"搜索重建风暴"（B1）已闭环；当前三大成本是 ① 长章节分页的整章矩形遍历、② 翻页热路径 26 处无 selector 订阅重渲、③ 搜索 live path 的逐节 IPC 写库 + TOC O(n²)。三者均有明确、低风险的改造路径（见 §8）。
- **本次为只读调研**：除本报告（`reports/debug-performance-report-2026-08-14.md`）外未改动任何文件；工作区在分析前后 `git status` 均为干净。

---

## 11. 附：证据清单与复测方法

**验证证据**：
- 测试：`pnpm test`（405 文件 / 5,498 用例通过）、`cargo test -p Readest --lib`（53 通过）
- 静态：`npx tsgo --noEmit`（0 错误）、`npx biome lint .`（0 问题）、`cargo clippy -p Readest --no-deps -D warnings`（0 警告）
- 基准：本机新跑 `library-search`（13 场景）与 `vector-retrieval`（5 场景），数据见 §6.1；harness 绕过方式：`import(pathToFileURL(join(BENCH_DIR, file)).href)`
- 运行时：release 便携版启动 22 s 采样（进程树内存/CPU），数据见 §6.2

**复测方法**：
1. 修复后重跑 §3 全部检查项与 §6.1 基准，对比 `bench/results.jsonl`（`--no-record` 可避免污染）。
2. 用 release 日志 grep `[perf] search.bookFresh.hit/rebuild` 验证 B1 命中率；`[perf] setProgress.total` 验证 NF3 修复效果（`readerStore.ts:28-29` 采样周期 1 s）。
3. macOS 实机验证 RF1/RF9/RF10；Windows 上验证 `pnpm bench` 修复（TF1/TF2）。
4. 长会话（>1 h、连续换书 20+ 次）采样内存曲线，验证 B2 修复后无单调增长；正常退出确认无孤儿 WebView2 进程残留。
