# Readest Local Debug 性能分析报告（2026-08-24，锚点刷新 + 全量审查）

- **日期**：2026-08-24
- **性质**：只读分析（§A 锚点自检触发 §B 快照刷新）+ 新提交缺陷审查。不改动代码、不提交 git。
- **旧锚点 → 新锚点**：`8218a6f` / perf-debug-report-2026-08-19.md → `1523c08` / perf-debug-report-2026-08-24.md
- **范围**：8218a6f..1523c08 共 22 个提交（约 1700 行源码改动），4 路并行子代理审查 + 主线程复现验证；历史遗留 13 项现场复核。

---

## 1. 基线块（实测 @1523c08，8-24）

| 日期 | HEAD | 前端文件数 | 用例数(通过) | tsgo | biome | clippy | Rust 单测 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 2026-08-24 | 1523c08 | 422（421+1 skipped） | 5669（5659 通过 + 10 skipped） | 0 错 | 1 warning | 0 警告 | 53 通过 | biome warning 为 mdictProvider.test.ts:1007 noUselessEscapeInString（测试文件）；Rust 层锚点以来零改动 |

## 2. §B 快照刷新摘要

- HEAD 从 `8218a6f` 前进到 `1523c08`（22 提交）：TXT 章节识别体系化重构（e749562/810891f/e90d3ea/1523c08）、搜索路径性能批次（78f9bbe/f11486a）、readerStore 兜底重读（b97a40b）、前台置前策略（aa01ce1）、设置搜索定位扫漏（a7b83b1/3524383）、SF10 补漏（668a8f3）、SF12（a53827c）等。
- 基线更新：5630 → 5659 用例（净增 29，全部通过）。
- 缺陷状态表大幅更新：SF10/SF12 确认已修；新增「新6~新14」编号（见 §3）。
- skill §C 快照区已随本报告同步更新。

## 3. 新提交缺陷审查发现（按严重度排序）

### 新6【P0】TXT 目录识别失败引导在 Tauri 桌面端完全不可达

- **位置**：`apps/readest-app/src/app/library/page.tsx:928-936`
- **描述**：进入引导的条件是 `typeof file === 'object'`。但桌面端三条导入路径产出的全是**字符串路径**：
  - 文件选择器 `useFileSelector.ts:111-118` 返回 `{ path, name }`；
  - 原生拖放 `useDragDropImport.ts:101-107` 用 `event.payload.paths` 映射为 `{ path: item }`；
  - watched-folder 自动导入（page.tsx:1080-1095）也是路径。
  
  于是桌面端 TXT「No chapters detected」时 `typeof file === 'object'` 为 false，直接落入 failedImports 报错分支，引导框永不弹出。
- **触发场景**：Windows 桌面导入任意无法识别章节的 TXT（本功能的核心场景）。只有浏览器 web 版拖拽才给 File 对象——与「web 端优化一律不采纳」的主战场约定相反，该功能等于没上线。
- **修复方向**：入队条件改为同时接受字符串路径（TxtGuideItem 存 path，确认回调里用 `fs.openFile(path)` 读回 File 再走重切）。

### 新7【P0→P1】zh 二级规则双捕获组导致 split 配对全面错位

- **位置**：`apps/readest-app/src/utils/txt.ts:59-68`（CHAPTER_RULES.zh[1].source）
- **描述**：e749562 重写 tier-2 时把 source 写成 `(?:^|\n)\s*(?:【)?(` + `'('` + inner + `')'` + `')'` —— **两个嵌套捕获组**（Node 实测组数=2；其余 zh/ja/ko/en 规则均 1 组）。`String.split` 为每个捕获组各插入一个元素，产出 `[前置, 标题, 标题, 正文, …]`；`extractChaptersFromSegment`（txt.ts:840-859）按 `j += 2` 配对取值，实测：
  ```
  输入 '\n正文开头\n1 标题甲\n内容A\n2 标题乙\n内容B'
  切分 → ["\n正文开头","1 标题甲","1 标题甲","\n内容A","2 标题乙","2 标题乙","\n内容B"]
  结果 → TITLE=1 标题甲 CONTENT=1 标题甲（标题重复进正文）
        TITLE=内容A   CONTENT=2 标题乙（正文行变标题）
  ```
  目录与正文双双损坏。锚点版是单捕获组无此问题，回归由 e749562 引入。
- **触发场景**：全书没有「第X章」式标题（tier-1 判不合格）但有『一、』『二、』或纯数字编号行时启用 tier-2——散文/网文外作品常见。
- **修复**：去掉内层多余括号，一行改动。

### 新8【P1】【】标题捕获结果含游离右括号『】』

- **位置**：`apps/readest-app/src/utils/txt.ts:50-51`（tier-1 source，e90d3ea 引入）
- **描述**：`(?:【)?` 在捕获组**外**消费左括号，但右括号靠 `ZH_CHAPTER_UNIT` 尾部 `[^\n-]{0,36}` 吞掉——它落在捕获组**内**。实测捕获：
  - `【第十章、下山（吕凡视角）】` → capture=`"第十章、下山（吕凡视角）】"`
  - `【第五章】` → `"第五章】"`；`【序章】` → `"序章】"`
  
  该捕获值直接成为 TOC `<text>` 与章节标题（txt.ts:854 `escapeXml(title)`），目录每条带尾随脏字符。e90d3ea 新增测试只断言匹配与否、未断言捕获内容，故全绿但输出错误。
- **修复**：右括号移出捕获组（如 `(?:】)?(?!\S)` 收尾，或在提取后 strip 尾部孤立『】』）。

### 新9【P1】ReDoS 校验可绕过 + 病态规则在生产路径永久冻结主线程

- **位置**：校验 `apps/readest-app/src/utils/txt.ts:178-216`（validateChapterPattern）；执行 `apps/readest-app/src/services/bookService.ts:448`
- **描述**两点叠加（均实测）：
  - **校验绕过**：嵌套量词检测正则 `/\([^()]*[+*?][^()]*\)[+*?]/` 只认 `+ * ?`，**不含 `{n,m}` 区间量词**。实测 `(a+){20}` 与 `(?:\d+\d*){10}x` 均放行（problems=[]）。长度 ≤512、深度 ≤4 两道闸拦不住该形态。
  - **主线程冻结**：`(a+){20}b` 对仅 32 字符的失败输入 **>120 秒不返回**（探针进程被强杀终止）。生产导入 `bookService.ts:448` 是主线程同步 `new TxtToEpubConverter().convert(...)`；带 120s 超时的 worker 路径 `convertTxtToEpubWithFallback`（txt-worker.ts:98）经全仓 grep 确认**零生产调用方**（仅测试引用，死代码）。病态规则一旦入库（全局设置每次 TXT 导入都执行），UI 永久冻结只能杀进程。
- **修复方向**：① 检测正则补 `{` 量词形态；② 导入改走已有 worker 链路（接线 convertTxtToEpubWithFallback 即可，代码现成）。

### 新10【P1】extractTxtChapterCandidates 整文件解码 + 编码探测退化 + 候选正则误报面大

- **位置**：`apps/readest-app/src/utils/txt.ts:149-169`；调用方 `TxtChapterGuideDialog.tsx:29-39`（useEffect 主线程直调）
- 三点：
  - **内存/卡顿**：`file.arrayBuffer()` 全量读入 → 全量解码 → `text.split(/\r?\n/)` 无惰性先建完整行数组（百万行级字符串对象）才开始过滤；`max=40` 早停在 split 之后救不了峰值。100MB TXT 估算主线程卡顿数秒、内存峰值数百 MB。
  - **编码探测未复用** `detectEncodingFromFile`（txt.ts:598，含 utf-16 BOM 探测）：这里只试 utf-8 fatal → 失败即 gb18030，UTF-16 文件解出 mojibake，候选为空，引导功能对 UTF-16 TXT 失效。
  - **候选正则 `/^[第卷回楔序【後记终扉]|章|回|更|卷|部|話/` 因 `|` 优先级**，后半分支是任意位置包含单字：实测『更新说明：作者有话说』『下部预告』『本章说：感谢打赏』全部命中。短正文行密集的书，40 个名额被正文占满，真标题进不了候选列表。
- **修复方向**：复用 detectEncodingFromFile；流式扫描早停（file.stream() 逐 chunk 解码，凑满 40 行即停）；候选正则加行首锚定。

### 新11【P2】buildChapterPatternFromSamples 单样本数字通配易误伤正文

- **位置**：`apps/readest-app/src/utils/txt.ts:116-147`
- 用户只勾选一行『第一章』→ 生成 `第[0-9零〇...]+章[^\n]*`，对『第十一章 试炼』命中属预期；但勾选单行『1.』→ `[0-9...]+\.[^\n]*` 会把『1998年冬天，他出生在南方。』类含数字开头的正文行切章（实测确认）。通配档尾部 `[^\n]*` 无长度上限放大误伤面。缓解：规则仅本次导入生效 + UI 已提示「勾选得越全越准」。定 P2。

### 新12【P2】SF12 prune 导致 total_read_time/total_read_pages 回缩

- **位置**：`src/services/statistics/statisticsDb.ts:139-165`（prunePageEvents / recomputeBookTotals）、`ReadingStatsTracker.tsx:67-73`（persist 顺序 insert→recompute→prune）
- recomputeBookTotals 的聚合是对裁剪后的 page_stat_data 求和：单本事件超过 10000 条后 prune 删最老行，下次 flush 触发 recompute 时 book 表总量比真实累计缩水。TTS 记录器（ttsStatsRecorder.ts:305）写同一张表但不 prune，混计同一上限。现有测试只断言行数上限，测不出回缩。
- 影响面说明：total_read_time 目前**无 UI 消费方**（grep 确认唯一读取链 useMedianPageDurationSecs 只用 id 查中位数），故实际影响限于 KOReader 兼容数据正确性，定 P2。修法：prune 移到 recompute 前 + 删除时保留聚合补偿，或累计值独立累加不受裁剪影响。

### 新13【P2】toSelectionSearchTerm 单向判定：s2t 显示方向的划词搜索回归

- **位置**：`src/utils/simplecc.ts:34-43`；调用点 `Annotator.tsx:1286-1296`
- 761f1bd 的新判定只在繁体系书（/hant|tw|hk/i）时反向转换。但显示变体还有 s2t/s2tw/s2hk/s2twp 族（LangPanel.tsx:127-131）：**简体书 + 简→繁显示**时正文显示为繁体，用户选中繁体词 → 书语言 zh-CN 不匹配 → 不反向 → 繁体词搜简体索引必 miss。旧代码（无条件 reverse）此场景原本命中。等于修好默认 t2s 场景却弄坏 s2t 场景。测试（simplecc.test.ts:44-64）只覆盖 t2s 侧。
- 修法：按变体方向对称判定——variant 含 `2s` 且书繁体系 → 反向；variant 以 `s2` 开头且书简体系 → 也反向。

### 新14【P2】搜索封面缩略图 LRU 驱逐会 revoke 书架正在显示的 blob URL

- **位置**：`LibrarySearchResults.tsx:92-101` + `coverThumbnailCache.ts:51-55`（容量默认 128）
- f11486a 让搜索结果复用书架同款全局缩略缓存。全文搜索命中 >128 本时插入压力驱逐最老条目并 `revokeObjectURL`：书架 `BookCover` 正在显示的同源 blob URL 被吊销 → 封面永久退化为文字占位（handleImageError 关图后本次不恢复），直至 updatedAt 变化重新生成。
- 缓解：错误有占位兜底不崩不漏内存；频率低（需 >128 封面同批命中）。修法：搜索侧用独立大容量实例，或驱逐时不 revoke 改引用计数。

### 其余核实为正确的部分（简列）

- b97a40b readerStore 兜底重读机制本身正确：miss → 磁盘重读一次 → setLibrary → 再查，仍无才抛；无死循环；返回类型匹配。残留两点 P2 级备注：① 兜底只试一次，大批量库下主窗口写盘未完成时仍可能失败（窗口收窄非消除）；② `setLibrary(reloaded)` 整体覆盖阅读窗口内存态，会冲掉本会话 transient 条目与其它书的进度时间戳（与 useLibrary.ts「跳过磁盘重载防冲掉内存条目」的设计意图相悖，影响仅显示层）。
- aa01ce1 前台策略三分支逻辑正确、权限齐备（core:window:default 含 is-visible/is-minimized/is-focused）、测试三态齐全。备注：三探测各自 catch，若 isVisible 成功而另两个 reject，最小化窗会被判入「可见未聚焦」只 setFocus 不还原——需同轮 IPC 部分失败才触发，概率极低。
- 78f9bbe 批次四项（booksKey useMemo、CachedImage 上限逐出、search_nodes/sections 批量写 SQL 转义、批量写失败原子性）核实无缺陷；批量写在 Rust 层 BEGIN/COMMIT + op_lock 下原子全或无，失败索引判脏重建，优于旧实现。CachedImage 是 FIFO 非 LRU（注释如实），且生产代码目前无人使用该组件，上限属预防性。
- 设置搜索扫漏（a7b83b1/3524383）：registry 63 个 settings id 与面板逐一比对，删除的 4 条僵尸翻译命令无悬挂引用。遗留两处备注级：① 五个命令 id（themeMode/themeColor/backgroundTexture/highlightColors/ttsHighlightStyle）传给了不转发 data-setting-id 的子组件（ThemePanel/TTSPanel → ThemeModeSelector 等四个组件接口未声明该属性），deep-link 点击只切面板不滚动不高亮——锚点期就存在，非本轮引入，但与本轮「扫漏」目标相悖；② eink 两命令桌面端无渲染目标（ControlPanel.tsx 仅 web 渲染该行），预先存在。
- TOC 清理（5672005）：侧边栏隐藏期间 SearchBar 已卸载并 abort 进行中搜索，clearSearch 只清陈旧结果，无误杀回归；toc-after-search-regression 测试有效。49dcb2f 纯删减+图标指示无回归。
- TxtChapterGuideDialog key={line} 无冲突：extractTxtChapterCandidates push 前 Set 去重保证行文本唯一。
- 临时 pattern 不写全局设置核实无误：onConfirm 只透传 ingestFile 的 chapterPatterns 参数，ingestService 只合并读取不写回。

## 4. 历史遗留 13 项现状复核（@1523c08）

| # | 编号/项 | 现场 文件:行号 | 现状 |
|---|---|---|---|
| 1 | HF2 整章遍历 | packages/foliate-js/paginator.js:406-452 | 仍存在：getVisibleRange 仍 TreeWalker 走完整章 body 把所有可见节点 push 进数组（:447-449），只为取首尾节点。调用点：滚动 debounce 250ms 后 afterScroll(:3276)、flushScrolledState(:1615)。暂缓不变 |
| 2 | RF6 MOBI 整读 | src-tauri/src/mobi_parser.rs:74,107 | 仍存在 Mobi::from_path 整文件读入；命令包了 spawn_blocking 不卡主线程，内存峰值不变 |
| 3 | NF10 close 未 await | useBooksManager.ts:167 | 仍存在：close() 火后不理，紧接 :170 开新书 |
| 4 | turso 阻塞 SQL | src-tauri/plugins/tauri-plugin-turso/src/wrapper.rs:73,137-188 | 仍存在：block_on(builder.build()) 在 :73（已包 catch_unwind）；execute/select/batch 直接 await 占共享 worker，无 spawn_blocking |
| 5 | range_file 无 fd 缓存 | src-tauri/src/range_file.rs:134,162 | 仍存在：每 range 请求 File::open + seek，无 fd/mmap 缓存 |
| 6 | Blob 逐字节 JSON 数组 | plugins/tauri-plugin-turso/src/decode.rs:23-28 + parser_common.rs | 仍存在：into_iter().map(Number::from)，无 base64 |
| 7 | dir_scanner 串行+重复 stat | src-tauri/src/dir_scanner.rs:51-66,97-115 | 仍存在：单线程 WalkDir；已知 file_type 后仍每文件再 std::fs::metadata |
| 8 | 只读命中路径仍 checkpoint | librarySearchService.ts:906-908 | 仍存在：ownsIndexDb=!session 路径 finally 无条件 checkpoint+close（纯读也写 WAL）；B14 的 30 秒惰性 checkpoint（:366-379）同样不区分是否发生过写 |
| 9 | fuzzy/nearby 逐节 postMessage | librarySearchService.ts:555-574 + librarySearchIndex.ts:304 | 仍存在：worker 分支按节构造 payload 逐次往返（2000 节=2000 次）；索引侧 loadSearchIndexSections 一次性 SELECT 全部节全文 |
| 10 | statisticsDb 同步回填 | statisticsDb.ts:260-276 | 部分修（d43678b 起 BEGIN/COMMIT 单事务包裹）；N+1 IPC 往返批量化（多行 VALUES 合并插入、touched 书聚合合并）仍未做 |
| 11 | SF10 方案1/2 跨卡片 blob 复用 | mdictProvider.ts:555-560,696-700,714-722 | 回收闭环已完成（revokeUrls/promote/dispose 清空 trackedUrls）；跨卡片复用未做：每次查询重新 locateBytes + 新建 objectURL 并 revoke 上一轮 |
| 12 | 搜索结果虚拟化 | LibrarySearchResults.tsx:435-436 | 未实施：displayedGroups.map 全量 render。缓解事实：分组默认折叠（isExpanded 才渲染组内 subitems）、每本上限 500 条、全局上限 2000 条（MAX_TOTAL_SEARCH_RESULTS），最坏 DOM 数有界；booksKey memo 与缩略图两小点已修 |
| 13 | 章节 transform 输出缓存 | transformService.ts:4-19 + FoliateViewer.tsx:264-307 | 仍存在：transformContent 十段管线零缓存，每次章节加载重建 ctx 重跑；document.ts:332 chapterTextCache 注释自述「仅缓存解压结果」 |

turso wrapper.rs 位于 submodule（不在主仓历史内），现场代码与历史报告逐行吻合。

## 5. 优先级矩阵（当前应修清单）

| 优先级 | 编号 | 一句话 | 修复难度 |
|---|---|---|---|
| **P0** | 新7 | tier-2 双捕获组切分错位（一行去括号） | 低 |
| **P0** | 新6 | 引导入口改收字符串路径 + openFile 读回 | 中 |
| P1 | 新8 | 【】捕获游离右括号 | 低 |
| P1 | 新9 | ReDoS 检测补 {n,m} 形态 + 导入接线 worker（120s 超时兜底） | 中 |
| P1 | 新10 | 候选提取：流式扫描 + 复用编码探测 + 正则加锚 | 中 |
| P2 | 新13 | toSelectionSearchTerm 按 s2 方向对称判定 | 低 |
| P2 | 新11 | 单样本数字通配收紧（如要求样本 ≥2 或通配段限长） | 低 |
| P2 | 新12 | prune 与 recompute 顺序/补偿 | 低 |
| P2 | 新14 | 搜索缩略图独立缓存实例 | 低 |
| P2 | （§3 备注） | readerStore 兜底二次重试（延时 ~250ms 补一次） | 低 |
| P2 | （§3 备注） | 五个 data-setting-id 断锚组件补转发 | 低 |

## 6. 本轮验证方法记录

- 基线：`pnpm test -- run`（91s）、`pnpm lint`（tsgo+biome）、`cargo clippy -p Readest --no-deps -- -D warnings`、`cargo test -p Readest --lib`，全部实测。
- 正则行为用 Node 独立探针脚本复现（tier-1/tier-2 捕获内容、split 配对输出、候选正则误报、ReDoS 冻结时长），临时脚本已清理，未触碰源文件。
- 4 个并行只读子代理分区审查（TXT 重构 / 搜索与 readerStore / 窗口管理与设置搜索 / 历史遗留复核），关键结论由主线程对照现场代码逐条验证后才采信。
- Rust 层 8218a6f..HEAD 零改动（`git diff --name-only` 确认），历史项 2/4/5/6/7 行号漂移风险低，仍逐一现场核对。

## 自检清单

- [x] §A 已跑：任务分级为只读分析（未跑冗余双基线）；锚点过期已按 §B 刷新快照区
- [x] 已读最新报告（指针指向者），历史项无重复立项（13 项逐一现场复核）
- [x] 新6 属桌面端可达性问题（非 web-only 优化项，正常立项）；web-only 问题未立项
- [x] 命令按 Windows 分支执行；代理模式用了 run 变体
- [x] 数值带单位；运行时结论附实测证据（正则探针/冻结计时），未编造
- [x] `文件:行号` 引用已对照当前代码核实
- [x] 本轮纯分析未改代码，无需基线前后对比
- [x] 报告未提交 git；指针 PERF-DEBUG-LATEST.md 已更新；§C 快照区已刷新
