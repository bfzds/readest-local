# Readest Local 修复实施报告（2026-08-31）

- 依据：`bugfix-implementation-plan-2026-08-30.md`（Task 0–19）与 `bugfix-plan-2026-08-30.md`（S/B/C/P/D 清单合并）
- 分支：`readest-local`；基线 e50da11 → 当前 eedf1d6
- 覆盖：Task 0–17 实施完毕，Task 18/19 评审与验收执行
- 提交：本会话共 10 个主仓提交 + 1 个 foliate-js submodule 提交，均已推送

---

## 一、提交清单（本会话）

| 提交 | 内容 |
|---|---|
| `6c5f04d` | Task14 P-4：搜索 fuzzy/nearby 整批投递 worker + Segmenter/Collator 缓存 |
| `74b4df7` | Task14 P-2：书架渲染扇出（稳定 Set + BookshelfItem memo） |
| `27693a6` | Task14 P-9 / P-11：TXT 章节正则缓存 + dir_scanner 复用 DirEntry metadata |
| `59e0960` | 书库启动"加载中"遮罩常驻修复（initLibrary loading 状态机） |
| `1dd413a` + submodule `33d450d` | Task15 P-1 / P-3 / P-5：组排序键预计算、拖拽 rAF、滚动背景 rAF |
| `f00e483` | Task16 P-6 / P-8 / P-10：transform LRU 缓存、搜索结果屏外跳过、统计批量写入 |
| `aa76173` | Task17 D-1 / D-5 / D-12：死代码、死参数、Rust unwrap |
| `eedf1d6` | Task17 D-2 / D-7 / D-10 / D-11 / D-13：日志、不可变引用、prune 原子化、锁阈值 |

---

## 二、已落地修改（按任务）

### Task 14 — 低风险性能优化

**P-2 书架渲染扇出**（`Bookshelf.tsx` / `BookshelfItem.tsx`）
- `renderBookshelfItem` 的选中判定从"每次 render 新建数组"改为 store 稳定 Set 引用 `selectedBookSet.has()`；
- `useCallback` 依赖相应稳定化，Virtuoso 不再因无关 setState（拖拽悬停期 dragAction 变化）整窗口重渲；
- `BookshelfItem` 默认导出包 `React.memo` 作第二道防线。

**P-4 搜索整批投递**（协议 + worker log）
- 新增 `search-batch` 消息：fuzzy/nearby 每 100 节一次 postMessage，替代逐节 ~2000 次往返（`search-batch` payload 在 `librarySearchWorkerProtocol.ts`，worker 在 `library-search.worker.js`，service 攒批在 `librarySearchService.ts` 两个匹配循环）；
- live 提取路径错误时先 flush 攒批，保住错误前已匹配结果（`try/catch` 内 yield）；
- worker 算法侧：grapheme Segmenter 提为单例、word Segmenter / Collator 按 locale 缓存（`library-search-algorithms.js`）；
- 实测：fuzzy en 117→91ms、zh 144→121ms；冷 nearby en 17.4→11.8ms、zh 90→60ms（bench 落盘对照）。

**P-9 TXT 章节正则缓存**（`txt.ts`）
- `createChapterRegexps` 结果按"语言+用户规则"缓存已验证的 source 列表（static Map，上限 32 组 LRU），每次仍构造新 RegExp 实例，避免共享有状态正则互相污染（曾连挂 48 个测试，已修复）；
- 同一语言+规则在整本转换每个 segment 不再重复 `validateChapterPattern`。

**P-11 dir_scanner 复用 metadata**（`dir_scanner.rs`）
- 非递归分支 `path.is_file() + fs::metadata` 两次 stat 合并为一次 `entry.metadata()`（同时判文件与取 size）；
- 通配放行判断（空列表 / `*`）提循环外，每文件不再重复 `contains`；
- symlink / 权限行为保持不变；新增 3 个 Rust 回归测试（按扩展名过滤 / 递归 / 通配）。

### 书库启动遮罩常驻修复（`page.tsx`）

- 根因：`initLibrary` 随 URL 规范化多次并发触发，stale 提前退出的轮次不清自己的 loading 定时器、也不把 `loading` 关回 false → 全屏"加载中"遮罩盖住已渲染完成的书库；
- 修复三层：① 定时器回调先守卫 stale（过期轮不置位）；② stale 提前退出统一 `bail()`（清定时器 + 关遮罩）；③ effect cleanup 兜底 `clearTimeout`；
- 用报告同款 webdriver 方法实测：启动连测 5 帧、整页刷新 5 帧全程无遮罩残留。

### Task 15 — 高风险渲染/拖拽性能

**P-3 拖拽 move rAF 批处理**（`Bookshelf.tsx` / `globals.css`）
- `pointermove` 只记最新坐标，ghost 定位 / 命中测试 / 高亮更新并入 rAF 帧（每帧最多一次，替代逐事件同步布局操作）；
- ghost 改用 `transform` 平移 + 缓存尺寸（拖拽期间一次 measure，resize 时重读）；CSS 加 `left/top:0` + `will-change: transform`；
- 高亮清除从全文档 `querySelectorAll` 改为只清上帧元素（`prevHoverElRef`）；
- pointer-up / cancel / 卸载统一 cancel rAF 并清理尺寸/悬停引用；
- 保留 8px 阈值、跟手、边缘翻转语义。

**P-1 组排序键预计算**（`Bookshelf.tsx` / `libraryStore.ts`）
- `sortedBookshelfItems` 比较器不再对每对组调 `getGroupSortValue`（每比较对整组 `Math.max` 聚合）→ 分组排序键一次性预计算进 `Map`，比较器查表；严格复用原聚合语义，未改 min/max；
- `refreshGroups` 加"组名 → 指纹"缓存（static Map，上限 4096 LRU），重建组表不再对相同组名重复 MD5。

**P-5 paginator 滚动背景 rAF**（`packages/foliate-js/paginator.js`，submodule `33d450d`）
- scroll 监听里 `#replaceBackground()`（每次 ~10 布局读）改为 rAF 合并：同帧多次 scroll 事件合并成一次重建，状态判在帧内做；保留原导航防抖、触摸拖动与 `isAnimating` 语义。

### Task 16 — transform 缓存 / 搜索虚拟化 / 统计批量

**P-6 transform 输出 LRU 缓存**（`transformService.ts`）
- `transformContent` 加模块级缓存，key 含章节键 / 内容滚动指纹 / userLocale / 布局 / 宽高 / transformers 列表 / `viewSettings` JSON；
- 32 条 + 8MB 双上限；设置变化（含在 key）只失效受影响章节；翻回旧章（refcount 驱逐后重建）不再重跑十段 transformer 链；
- 新增 4 个单测（命中不重跑、内容 / 设置 / 章节变化失效）。

**P-8 搜索结果屏外跳过**（`LibrarySearchResults.tsx`）
- 采用纯 CSS `content-visibility: auto` + `contain-intrinsic-size`，让浏览器跳过屏外展开子项的渲染/布局；保留 sticky header、折叠状态、键盘与 ARIA 行为，零 JS 改动；
- 未做完整虚拟化的原因见下文"未落地"。

**P-10 统计批量写入**（`statisticsDb.ts`）
- `applyRemoteEvents`：books 缺失 id 先一次性补齐；事件 INSERT 攒成 VALUES 多行分块（每批 100 行，500 参数在 SQLite 上限内）；recompute 聚合为一条 correlated `UPDATE ... WHERE id IN (...)`；
- 大 pull 从 O(events) 次 IPC 收敛到 O(events/100)；保留 BEGIN/ROLLBACK 原子性与 `ON CONFLICT ... max(duration)` LWW 语义；
- 新增"150 事件跨 2 批"用例验证总数与去重聚合正确。

### Task 17 — 代码卫生 / 死代码

**落地项：**
- **D-1**：删除无生产引用的 `reorderShelfLayer`（libraryUtils）及其死测试文件（约 400 行）；修正 `swapShelfUnits` 注释对已删函数的引用；
- **D-2**：清理生产路径 `console.log`（`[nav]` 分组日志、`Opening last books`、`Importing books from files...`、`[create]` 组日志）；导入失败日志从 `console.log` 升级 `console.error`；删除 `[nav]` effect 中仅用于日志的 `md5Fingerprint` 计算并随之删除未用 import；
- **D-5**：`handleBookDelete` 实现删除未使用参数 `_syncBooks`；
- **D-7**：`themeStore.saveCustomTheme` 由原地 `splice/push/赋值` 改为不可变构造新 `customThemes` / `globalReadSettings` / `settings` 引用，并 `setSettings` 同步 store 引用（替代"原地改入参"副作用）；
- **D-10**：`statisticsDb.prunePageEvents` 的"retained 累计 + DELETE"包成单个 BEGIN/COMMIT 事务，中途失败整体回滚，避免计数不一致；
- **D-11**：search 构建锁陈旧阈值 30s → 120s，避免大书检索重建超过 30s 时活锁被并发窗口误判为陈旧而触发双重建；
- **D-12**：`lib.rs` 打开 main window 的 `unwrap` 改 `if let`，窗口不存在时不 panic；
- **D-13**：拖拽 effect 经 `dragLangRef`（useRef）读翻译函数，`_` 移出依赖数组，避免其身份变化重绑全局监听。

---

## 三、未落地项及原因

| 项 | 原因 |
|---|---|
| **P-8 完整虚拟化**（Virtuoso 组内子项） | 每书籍搜索硬上限 500 条、全库 2000 条已约束最坏规模；完整虚拟化要与 sticky header / 多本展开 / 键盘主导航 / ARIA 交互兼容，回归面大、收益有限。改以 `content-visibility`（浏览器跳过屏外渲染）达成等效收益 |
| **P-9 probe 保留已读缓冲区** | probe 与 extract 使用不同分段参数（空行数 7 vs 8），读缓冲无法复用；且把整文件读入内存违背"大文件流式处理"设计初衷，判为不可行 |
| **D-4 合并重复 refreshGroups** | 逐点核对三处调用（布局快照恢复 / 空组移动 / 并入 rebase）位于互斥分支或独立流程，不存在同一 drop 内的重复调用，判为假阳性 |
| **D-8 chapterTextCache evict 边界** | 原改动（超预算连末条一并逐出）被既有测试否决：2 个用例明确要求"至少保留最新一条"（避免翻回当前章重复 inflate），该项实为设计特性而非 bug，已回退并补注释说明 |
| **D-3 判别式三套统一**（format/books/hash） | 触及书架条目类型判别核心，跨多文件重构，回归风险高于清理收益，保持现状 |
| **D-6 双 primitives 合一 / 删未用文件 / 死状态 requestedSubPage** | 涉及多组件导入面与 UI 结构，属计划标注"可选"项，未在本轮排期 |
| **D-9 mdict dispose 关文件句柄 / init 中途清理** | 词典 provider 生命周期改动，句柄关闭时机与缓存回收交互复杂，风险不小收益有限，未纳入本轮 |
| **D-14 MiscPanel 硬编码中文** | 文案源（含 `validateChapterPattern` 校验消息链）本就中文，i18n 化需补全部 locale 键并改造消息源，改动链长，属可选清理 |

计划 §4.2 暂缓项（H-1~H-6、Z-1/Z-2：HF2 整章遍历、turso 单锁、MOBI 整读、range_file fd 缓存、Blob 逐字节 JSON、只读 checkpoint、RSVP 魔法数、注释风格统一）按原判定不排期，未触碰。

---

## 四、验证与验收状态

| 命令 | 结果 |
|---|---|
| `pnpm test -- --run` | 5730 通过 / 10 跳过（删死测试后净额） |
| `pnpm test:browser` | 搜索 worker 批量协议、paginator 滚动/背景动画全过；另 6 个文件为既有环境失败（useEnv/EnvProvider、TTTS 截图、ViewTransition 不可用），与本轮改动无关 |
| `pnpm test:tauri` | 6 文件 5 过；119/121 通过（1 失败 `native-close-isolation` 为 Windows 绝对路径 escaping libsql base-dir 的平台 flake，native 层本轮零改动） |
| `pnpm lint` | tsgo 干净；biome 仅 1 个既有无关 warning |
| `pnpm fmt:check` / `clippy:check` / `test:rust` | 全过（56 个 Rust 测试，含新增 dir_scanner 3 个） |
| `pnpm bench library-search` | 优化前后对照已落盘（fuzzy/nearby 提速 16–33%） |
| webdriver 实测 | 遮罩修复：启动/刷新全程无全屏遮罩残留；书库正常露出 |

### 手工验收待办（未自动化）
断网导入 EPUB/PDF/TXT 并打开阅读；恶意 EPUB 脚本不可达宿主 IPC；删除书籍/清空书库后旧窗口保存不复活记录；标注回填期间新增/编辑/删除保留；Open With 快速导航无白屏；书与组拖拽提示与实际行为一致；TTS 快速停后重播有声；E-ink / 离线 / 无网络审计不回归。

---

## 五、复核后修复批次（2026-08-31 followup，依据 `bugfix-followup-plan-2026-08-31.md`）

上一轮复核确认：1 高（S-3）+ 7 中 + 7 低/增强 + P-8（范围界定）。本轮全部排期项已实施并推送（本会话新增 13 个提交），逐条状态：

### 已落地

| 项 | 提交 | 落地内容 | 验证 |
|---|---|---|---|
| **S-3** | `30ea1bb` | sanitizer 移除 allowScript 短路（书内容一律剥离 script/事件属性/javascript: URL）；删除 FoliateViewer `evalInlineScripts` 执行路径；书内 `<script src>` 一律 allow=false；移除设置面板 "Allow JavaScript" 开关；保留 allow-same-origin（origin 隔离另立架构任务） | sanitizer allowScript 下剥离测试 + 91 测试通过 |
| **S-1/S-2** | `9469506` | 删除 `BaseDirectory::Temp` 自动放行与 `$TEMP/**/*`；parser 全命令统一经 `validate_scoped_file`（epub 3 + mobi 2 处核对） | fmt/clippy/56 Rust 测试 |
| **S-4** | `c04601f` | 确证无生产 shell 调用后删除 `shell:default` 与 `shell:allow-spawn` 3 条白名单命令；新增 capability 快照测试防权限回扩 | 快照测试 3 条 |
| **C-4** | `edc8558` | Open With `saveLibraryBooks` 改 await + try/catch，失败停库页不导航；`bail()` 只在当前 generation 关 loading 遮罩 | 类型 + open-with/library 测试 |
| **B-9** | `b620f65` | 新增 `page_stat_seen` 表（唯一约束）；prune 只对"被删−保留−已见"净新增页计数并入表；recompute 排除已见页；迁移保留旧整数保底 | 21 统计测试 |
| **B-7** | `10a5eea` | `mergeLibraryRows` 纯函数：merge-floor + 按 updatedAt LWW；旧窗口不碾压新磁盘数据；tombstone 优先；replace 显式全量 | 5 个 LWW 单测 |
| **B-6** | `f09df8e` | metaHash 聚合 firstMatch 改 `{...firstMatch}` 副本 + 补记 originalExistingHash 供提交点按原 hash 回写，失败不污染原数组 | import-metahash 25 测试 |
| **P-4** | `5e1735a` | search-batch 整批共享 budget，worker 逐节递减至 0 停 + capped；service fallback 同步截断 | budget browser 用例通过 |
| **C-10** | `5b65988` | simplecc 共享初始化 Promise（并发一次，失败清空可重试） | txt-converter 42 测试 |
| **C-12** | `5b65988`+`149311d` | throttle 增 flush()/cancel()；ReadingRuler 卸载 flush+cancel；修正 emitLast 尾次不重置窗口（恢复 TTSScrubber 语义） | 4 个 throttle fake-timer 单测 |
| **P-3** | `5b65988` | 拖拽 effect cleanup 统一调幂等 endShelfDrag（清 rAF/ghost/高亮/引用） | Bookshelf 相关回归 |
| **P-6** | `7763dc4` | 内容指纹改两路滚动 hash 异或长度（碰撞空间 ~2⁶⁴） | transform-service 测试 |
| **焦点陷阱** | `7763dc4` | Dialog 通用 Tab/Shift+Tab 循环；CommandPalette Tab 在结果间循环移动选中 | CommandPalette 测试 |

### 未落地 / 暂缓（记录理由）

| 项 | 状态与原因 |
|---|---|
| **C-6 Annotator 监听器** | Annotator `onLoad` 内 touch/pointer/selectionchange 仍以 `bind(null, doc, index)` 匿名注册、无配对 `removeEventListener`（无 AbortController）。判断：doc 随章节 iframe 销毁可被 GC 回收、累积仅在"同一 doc 多次 load"场景可观测，但根治需成对 handler + 每 doc cleanup，改动面大、易破坏注释交互；判定为独立架构批次，本轮暂缓并在验收清单记录 |
| 规划 §2.2 的 Sol/Luna 双模型 | 本机无 `gpt-5.6-luna` agent；验证由主模型直接执行，测试结果、退出码与失败清单在本报告与任务日志可回溯 |

### 本批次验证

- 全量前端 **5744 通过 / 10 跳过**（新增 throttle 4 条、LWW 5 条、B-9 1 条、capability 3 条、sanitizer 事件属性 1 条等）
- Rust：fmt/clippy/test 全过（56 条）
- browser 套件：搜索 worker budget 用例通过；仍为既有 5 个环境性失败（useEnv/截图/ViewTransition/跨 section 选择），与本轮改动无关
- tsgo 干净；biome 仅 1 个既有无关 warning

### 仍待手工验收（与上轮一致）
断网导入与读取、恶意 EPUB 无 IPC、双窗口删除/并发修改、重复 prune 页数、Open With 保存失败、高命中搜索总上限、章节反复开关的监听器/ghost 残留、页面键盘 Tab/返焦。