# Readest Local Debug 计划（2026-08-15）

- **基线**：`readest-local` @ `d836901`；工作区 `packages/tauri` 子模块有未提交改动（`m`，内容待确认）。
- **依据**：`reports/debug-performance-report-2026-08-14.md`（缺陷全清单，@`3f920eb`）+ 其后的 22 个修复提交。
- **性质**：计划文档，非修复提交。基于提交信息 + 抽查确认的现状，剩余项需按 §6 逐个验证。
- **待办总量**：报告列出的 60 项缺陷中约 40 项已在 22 个后续提交中修复；下文只列**仍待处理**项。

---

## 1. 目标

1. 复核 22 个后续修复提交的修复质量（防"修了但引入新问题"）。
2. 对仍存在的缺陷按优先级逐个修掉，每项带可验证的完成条件。
3. 审查 22 个提交引入的新代码风险点（自绘菜单 / AdwaitaSelect / worker 化批次）。
4. 产出可复跑的验证基线（测试 + 静态 + bench + 运行时采样）。

---

## 2. 验证基线（改动后必须全绿）

| 检查项 | 命令 |
|---|---|
| 前端单测 | `pnpm test`（405 文件 / ~5,500 用例，基线 152.6 s） |
| 类型检查 | `npx tsgo --noEmit` |
| 前端 lint | `npx biome lint .` |
| Rust lint | `cargo clippy -p Readest --no-deps -D warnings` |
| Rust 单测 | `cargo test -p Readest --lib`（基线 53 通过） |
| Rust fmt | `pnpm fmt:check`（仅 src-tauri 改动时） |
| 基准 | `pnpm bench`（7689748 已修 Windows harness，`pathToFileURL`） |
| 运行时日志 | `%LOCALAPPDATA%\com.local.readest\logs\Readest Local.log` 转发 `[perf]` 埋点 |

> 项目规则：修复必须先写失败单测再改代码（`apps/readest-app/.claude/rules/test-first.md`）。

---

## 3. 缺陷现状映射（报告 @3f920eb → 当前 @d836901）

### 3.1 已修复（含修复提交，需回归）

| 编号 | 缺陷 | 修复提交 | 备注 |
|---|---|---|---|
| B1/B2/B3/B5/B12/B13/B14/B15 | 上轮 9 项 | 报告前已修 | 已复核过 |
| NF2 | reader 关闭 500ms destroy 竞态 | `7c62f74` | 已抽查：`window.ts:11` `SAVE_DESTROY_TIMEOUT_MS=5000`，`Promise.race` 保存完才 destroy ✅ |
| RF1 | `static mut` 数据竞争 | `7c62f74` | traffic_light.rs |
| RF2 | dir_scanner ACL 子串绕过 | `7c62f74` | 已抽查：仅依 `fs_scope`（`dir_scanner.rs:26`）✅ |
| RF3/RF4 | turso builder panic / 绝对路径放行 | `7c62f74` | tauri-plugin-turso |
| SF11 | 恢复路径穿越 | `7c62f74` | 已抽查：`isSafeBackupEntry` 统一校验（`backupService.ts:429`）✅ |
| RF7/RF5 | 封面解码上限 / 字体枚举 | `7689748` | |
| NF1/NF4/SF9/TF1/TF2 | 失败隔离 / 除零 / 截断提示 / bench 平台 | `7689748` | |
| NF5/NF7/NF8/NF9/SF6/RF8 | 订阅超时 / 退出 flush / 节流稳定 / 统计批量 / 原子写 | `3020d64` | `window.ts:133` `flushPendingLibrarySave` ✅ |
| NF3 | bookDataStore 级联重渲 | `6aa5574`+`cbbb05f` | per-field selector + 减少每帧写入 |
| SF1 | TOC O(n²) | `cbbb05f` | 单遍栈 |
| SF13 | LIKE 预筛无上限 | `a1a2a38` | |
| P2 心跳 | 3s 心跳放宽 | `cbbb05f` | |
| HF1 | mediaOverlay 高亮类累积 | foliate `c03837e` | |
| HF3 | Overlayer.bubble 原地改 rect | foliate `a54e921` | |
| HF4 | highlight 目标 view 未加载 TypeError | foliate `b48ab1f` | |
| SF10（部分） | BGL worker 化 / 章节 LRU / 封面缩略 / zip worker / overlayer 单 path | `d1bf16e`+foliate `01919e9` | |

### 3.2 仍存在（待处理，见 §4 优先级）

**P1（体验/热路径）**：HF2、SF2、SF3、B8、NF6、NF10（复核）。
**P2（稳态/容量）**：SF10 剩余（MDict/StarDict）、SF12、SF14、SF4/SF5、RF6/RF6b、RF9/RF9b/RF10、TF3。
**上轮明确暂缓**：B6 死代码、B9 open-book 事件丢失、SF8 CFI 急切解析、B16/MOBI 自实现头解析。

---

## 4. 待处理缺陷明细（按优先级）

### 4.1 P1（用户可感知 / 热路径）

#### P1-1 HF2 长章节每翻一页整章布局遍历 🔴
- **位置**：`packages/foliate-js/paginator.js` `getVisibleRange`（约 406-474、3169-3205）。
- **问题**：TreeWalker 整章遍历 + 每节点 1-2 次 `getBoundingClientRect`，视口上方不跳过；长章节每翻一页 10-200ms 主线程卡顿。
- **方向**：① 从上一锚点双向扩散，仅对视口邻近节点量矩形；② 或按分栏缓存 `contentPages`、内容 hash 失效。**改动风险高，需 Android WebView 回归 + 滚动态回归**。
- **验证**：构造数千节点章节，采样翻页帧耗时（reader 窗口 + 正文 `foliate-view` shadow DOM）；对比修复前后。

#### P1-2 SF2 搜索 live path 逐节 IPC 写库 🟠
- **位置**：`src/services/librarySearchIndex.ts` `writeSearchIndexSection/Node`（报告 :122-128、249-263）。
- **问题**：500 节书 ≈ 1,500 次 Rust IPC 往返，重建延迟显著。
- **方向**：改 `batch()` 多值事务，1500 往返 → 数十次。
- **验证**：`pnpm bench` library-search 对比；重建 500 节书计时。

#### P1-3 SF3 双窗口并发建同一本书索引无互斥 🟠
- **位置**：`librarySearchService.ts` 搜索主循环 + `indexDbs` 会话级缓存。
- **问题**：双窗口首搜同一本书重复整本重建（双倍工作）。
- **方向**：进程内 `book.hash → in-flight build` 互斥表，并发时等待/复用。
- **验证**：双窗口并发首搜同一本书，观察 `[perf] search.index.build` 只触发一次。

#### P1-4 B8 关阅读页整库重载 🟠
- **位置**：`src/app/library/page.tsx:537-544`（报告）。
- **问题**：关阅读页仍整库 `loadLibraryBooks` + `setLibrary`，数千本时 O(n) 重读重渲。
- **方向**：只同步进度/阅读状态字段的增量刷新。
- **验证**：数千本库，关阅读页测书架响应耗时。

#### P1-5 NF6 / NF10 复核 🟡
- **位置**：`useBooksManager.ts`。
- **问题**：窗口间 library 数据不一致（NF6）；换书异步 teardown 竞态（NF10，`3020d64` 可能已部分处理）。
- **验证**：长会话连续换书 20+ 次，采样内存曲线 + 双窗口数据一致性。

### 4.2 P2（稳态 / 容量）

| 编号 | 问题 | 位置 | 方向 | 优先级 |
|---|---|---|---|---|
| SF10 剩余 | MDict `trackedUrls` 无界增长 / StarDict 整包 gunzip | `dictionaries/mdictProvider.ts`、`starDictProvider.ts` | LRU/懒切片/revoke | 高 |
| SF12 | `page_stat_data` 无 TTL | `statisticsDb.ts` | 聚合清理任务 | 中 |
| SF14 | TTS 三处清理缺口 | `WebSpeechClient.ts`、`MediaOverlayClient.ts`、`NativeTTSClient.ts` | abort/关闭路径清理 | 中 |
| SF4/SF5 | web 备份整库内存 zip / 恢复非原子 | `backupService.ts` | 流式分块 / 事务+回滚 | 中 |
| RF6/RF6b | MOBI 整文件读堆 / sizes map percent-decode | `mobi_parser.rs`、`epub_parser.rs:315` | 上轮不建议投入，记录即可 | 低 |
| RF9/RF9b/RF10 | macOS AppKit 回调 panic / 主线程 abort / iCloud 阻塞轮询 | `traffic_light.rs`、`lib.rs`、`macos.rs` | 无 macOS 实机，静态修复 + 注释 | 低 |
| TF3 | `.next/` 4.5GB + `target/` 30.5GB 磁盘 | 构建产物 | 清理脚本 | 低 |

---

## 5. 新提交风险点审查清单（22 个提交引入的新代码，未审查）

> 即上轮会话被中止的「深读新提交找新 bug」批次。每项建议读 diff + 相关测试后标记 通过/待修。

| # | 提交 | 风险点 | 审查重点 |
|---|---|---|---|
| 5-1 | `d3f7717`+`71bd891` | 右键菜单自绘 `BookContextMenuPopup` + `useSuppressDefaultContextMenu` | 菜单定位/键盘可达性/焦点管理；事件抑制副作用（文本选择、copy）；macOS 原生菜单弃用后行为 |
| 5-2 | `e5a3474` | `AdwaitaSelect` 替换全部原生 select | 键盘操作（方向键/Enter/Esc）、a11y role、与表单/节流联动、打开态溢出布局 |
| 5-3 | `d836901`+`f1b65d2` | 阅读页/书库页 UI 统一批次（~19 文件） | 非语义色清理引入的对比度回归；自绘控件在深色/浅色主题下的可读性 |
| 5-4 | `d1bf16e` | 内存优化批次：zip worker / 章节 LRU / BGL worker / 封面缩略缓存 / overlayer 单 path | worker 生命周期与错误路径、LRU 失效与内存上限、封面缓存一致性（换源后刷新）、`foliate 01919e9` 高亮矩形合并的几何正确性 |
| 5-5 | `c9faef5` | F 键开关搜索栏 + 侧键后退 | 与阅读快捷键冲突、焦点捕获/释放、侧键在输入框内的行为 |
| 5-6 | `c781b85` | 划词悬浮窗 pointerup 清理 | 选择清空 vs 复制操作时序、触摸端 |
| 5-7 | `ee7c96a` | 鼠标侧键历史去重列表 | 历史顺序正确性、跨窗口同步 |
| 5-8 | `58f38ac`+foliate `e239650` | 搜索匹配高亮主题遮罩 + 性能基准 | 遮罩在 `color-mix` 不支持环境的回退（`ba6e77e` 已用 rgba 变量，复核）；遮罩性能基准数据 |

---

## 6. 执行顺序建议

**Step 0 — 基线确认**（半天内）
1. 确认 `packages/tauri` 子模块未提交改动内容，决定提交/还原。
2. 跑 §2 全部验证命令，确认当前 HEAD 全绿（基线）。

**Step 1 — 新代码审查**（§5，8 项，可并行子代理，每项输出 通过/待修 两值）
- 复用上轮被中止的审查 prompt 模板，分批派 agent（自绘菜单/UI 统一 一批；内存优化/搜索高亮 一批）。

**Step 2 — 回归已修复项**（§3.1）
- 重点：NF2（关 reader 不丢进度）、SF11（构造含 `../` 的恶意备份拒绝恢复）、RF2（越权路径拒绝）、HF1/HF3/HF4（有声书连续播放高亮、bubble 后命中检测）。
- 已修复项有测试的跑测试；无测试的手工路径补测。

**Step 3 — 修 P1**（§4.1）
- 顺序建议：P1-2 SF2（纯后端、收益确定）→ P1-3 SF3 → P1-4 B8 → P1-1 HF2（改动风险最高，放最后，单独分支）。
- 每项：先写失败单测 → 修复 → 全量回归。

**Step 4 — 修 P2**（§4.2）
- 按上表优先级，SF10 剩余先行（内存增长可测）。

**Step 5 — 收尾**
- 长会话（>1h、换书 20+）内存采样；正常退出确认无孤儿 WebView2 进程；产出 2026-08-15 报告。

---

## 7. 明确不做 / 暂缓

- **B6 死代码删除**：需 Android WebView 复测。
- **B16/MOBI 自实现 PalmDB 头解析**：改动成本/风险高。
- **SF8 CFI 急切解析**：设计权衡，成本前置但功能需要。
- **RF9/RF9b/RF10 macOS 实机验证**：本机 Windows，无实机。
- **宽泛的 getVisibleRange 大改**：除非 P1-1 的锚点扩散方案在模拟+Android 回归通过。

---

## 8. 复测方法与证据

- 修复后重跑 §2 全项 + §6.1 bench，对比 `bench/results.jsonl`。
- 日志 grep：`[perf] search.bookFresh.hit`（索引命中）、`[perf] search.index.build`（重建触发次数）、`[perf] setProgress.total`（NF3 效果）。
- WebDriver（`pnpm tauri:dev:test`，端口 4445）驱动窗口可见性用 Win32 `IsWindowVisible` 判定；关闭事件需点 UI 按钮（JS `window.close()` 不触发 Tauri `onCloseRequested`）。
- 每项缺陷完成标准：失败用例转绿 + 相关全量用例无回归 + （适用时）运行时采样证据。
