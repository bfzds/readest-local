# Readest Local Bug 修复清单（全项目审查 + 性能 debug 合并）

- **日期**：2026-08-30
- **来源**（去重合并）：
  - 全项目分区 code-review（6 模块并行）：书库层 / 阅读核心 / services+store / utils+workers+i18n / components / Rust+foliate-js
  - perf-debug-report-2026-08-30.md（性能瓶颈 4 P0 + 历史 13 项复核）
  - code-review 15e2775..HEAD（书库分组拖拽 + 阅读页整理，双轴）
  - perf-debug-report-2026-08-24.md（历史遗留编号参照）
- **基线**：5711 通过 / 10 skipped @e50da11（实测）

## 0. 修复路线图（按批次推进）

| 批次 | 目标 | 内容 | 估算 |
|---|---|---|---|
| **批次 1** | 安全 + 数据丢失 | S-1~S-4、B-1~B-9 | 8–12 人日 |
| **批次 2** | 一致性 / 功能 | C-1~C-14 | 6–9 人日 |
| **批次 3** | 性能 | P-1~P-11（含 8-30 报告 4 个 P0） | 9–15 人日 |
| **批次 4** | 代码卫生 / 死代码 | D-1~D-14（部分可选） | 4–6 人日 |
| **暂缓** | 高风险低收益 | 见 §4（H 项 + ❌/⚠️） | 不排期 |

工时按 **1 名熟练工程师**估算，含测试与回归。总修完 40–60 人日；只做批次 1+2 约 15–20 人日。

---

## 1. 批次 1：安全 + 数据丢失（8–12 人日）

### 安全（最高优先）

| 编号 | 问题 | 位置 | 修法 | 验证 | 估时 |
|---|---|---|---|---|---|
| S-1 | **fs 权限闸门被架空**：capabilities 给 fs:read-all/write-all，`lib.rs:95` 的 allow_paths_in_scopes 形同虚设 | `src-tauri/capabilities/default.json` + `src-tauri/src/lib.rs:95` | 去掉 read-all/write-all，收窄为显式 scope，恢复路径闸门语义 | 桌面普通操作（导入/打开/缩略图）仍正常；越权路径被拒 | 0.5–1 |
| S-2 | **parser 命令无 scope 校验**：读 OPF/nav/cover/partialMD5 只 `exists()`，配合 XSS 成"存在性 oracle" | `src-tauri/src/lib.rs:198-202` | 复用现成 fs_scope / asset_protocol_scope 校验 | 越权路径命令拒绝 | 0.5 |
| S-3 | **恶意书内 JS 可达宿主 IPC**：正文 iframe `sandbox="allow-same-origin allow-scripts"`+srcdoc，书内 script 未被清洗，同源可达 `__TAURI_INTERNALS__.invoke` → 完整 IPC | `packages/foliate-js/paginator.js:670,762` | ① 拆开 allow-same-origin（书 content 不与宿主同源）② 或 srcdoc 前剥离 `<script>`；注意别破坏正常 epub 交互（点击/选中/锚点） | 含 `<script>` 的恶意 epub 打开后 `window.__TAURI_INTERNALS__` 不可达；正常书划线/翻章不回归 | 1–2 |
| S-4 | shell/spawn 与 env 面（P2 合并）：`^.*Readest(.*)\.exe$` 允许 cmd 元字符；`get_environment_variable` 任意 env 可读 | `src-tauri/capabilities/default.json`、`src-tauri/src/lib.rs:163` | 白名单收紧放行模式；reduce env 暴露 | 命令列表核对无新增面 | 0.5 |

### 数据丢失 / 正确性

| 编号 | 问题 | 位置 | 修法 | 验证 | 估时 |
|---|---|---|---|---|---|
| B-1 | **标注回填吞新标注（P0）**：page 回填持有挂载时快照，5s 宽限 + 250ms 节拍后整数组覆写，期间用户新写/改的标注被收割 | `annotator/Annotator.tsx:736-873` + `bookDataStore.ts:183` | 回填尾写前 `getConfig(bookKey)` 重读并与最新 booknotes merge，再做整体替换 | 构造回填场景（多无 page 标注书）+ 回填期间新建标注 → 保留；单测覆盖 | 1–1.5 |
| B-2 | **initLibrary 无卸载守卫**：async 体 openWith/openLast 后仍 `setLibrary/setLibraryLoaded` 写已卸载组件 | `app/library/page.tsx:721-787` | async 体加 mounted 守卫（ref）+ 导航后短路剩余 setState | 深链激活后快速返回书库无 React 警告 / 无错写 | 0.5–1 |
| B-3 | **删书后空组残留**：`updateBook` 不调 `refreshGroups`，删组内最后一本后空组被 getGroups 重新捞上架，仅重启消失 | `store/libraryStore.ts:138-153` | `updateBook` 末尾补 `refreshGroups()`（一行） | 删组内最后一本 → 空组立即消失 | 0.5 |
| B-4 | **书→组格"提示换序实际并入"**：上半格高亮 swap 样式，落点却归组 | `components/Bookshelf.tsx:1257,1325-1328,1416-1445` | 命中判定区分拖拽源类型：书进组格一律 merge，仅"组→组"才支持上半 swap；对齐提示文案 | 手动拖书进组格上半 → 行为与提示一致；组→组上半仍 swap | 0.5–1 |
| B-5 | **mergeBooks 先删后写**：先删重复书目录再写合并配置，失败即丢重复书书签/进度 | `services/bookService.ts:359-365` | 先落盘 mergedConfig，成功后删 dup 目录；失败回滚保留原目录 | 模拟合并中断 → 重复书目录与其书签仍在 | 0.5–1 |
| B-6 | **导入中途原地改对象**：成功前已改 existingBook/dup.deletedAt/索引对象，抛错则内存脏而磁盘未存 | `bookService.ts:556-580`、`ingestService.ts:205-210` | 改在副本上，全部成功后再 commit 到 store + 落盘；失败不改动 | 批量导入注入失败 → 内存/订阅者不受影响 | 1 |
| B-7 | **30s 节流复活已删书**：阅读窗持旧 library，清除书库后一次节流保存按 hash 全覆盖把已删书写回 disk | `services/libraryService.ts:57-61` + `saveLibraryBooks` | 保存前与磁盘当前状态核对/并集；或改增量（版本号）融合而非旧数组全覆盖 | 双窗口下删书后观察 disk 不复活 | 1 |
| B-8 | **用户自定义正则复现双捕获组**：用户 pattern 含捕获组被外层再包 → split 多插元素、`j+=2` 错位，全书 TOC 损坏 | `utils/txt.ts:1029` + `validateChapterPattern`(:228) | 校验拒绝用户 pattern 含捕获组（或运行时去捕获）；按内置语言规则补测试护栏 | 输入 `(第.+章)` → 导入前被拒并提示；正常规则不回归 | 0.5–1 |
| B-9 | **statistics total_read_pages 仍回缩**（半修遗留）：只补了 total_read_time，`COUNT(DISTINCT page)` 现存行照旧缩水 | `services/statistics/statisticsDb.ts:170-180` | pages 同样用 retained 累积（recompute 时 + 历史保留值） | create 多页事件 → prune → 总量不回缩；单测 | 0.5–1 |

---

## 2. 批次 2：一致性 / 功能（6–9 人日）

| 编号 | 问题 | 位置 | 修法 | 估时 |
|---|---|---|---|---|
| C-1 | **URL 双通道竞态**：`updateUrlParams` 依赖 searchParams → 回调身份常变 → 反复规范化导航，与 Next 16.2 空搜索 hack 双写 | `Bookshelf.tsx:334,414-422` + `page.tsx:385-437` | updateUrlParams 依赖改为稳定（router 稳定、searchParams 用 ref/序列化后比较）；统一单写通道 | 1.5–2 |
| C-2 | **query 全等比较脆弱**：整 query 字符串全等判定"是否同步"，参数顺序一变就失效 | `page.tsx:353-354,808-812` | 改按参数键值字典序/对象级比较 | 0.5 |
| C-3 | **整页白屏占位易误置**：checkOpenWithBooks/checkLastOpenBooks 任一误置 → 整页空白 | `page.tsx:1695-1697` | 加判定守卫 + 超时兜底（标志置回） | 0.5–1 |
| C-4 | **processOpenWithFiles transient 语义矛盾**：无条件 setLibrary+save，但新书未入数组，还得盘上才存在 | `page.tsx:635-670` | 与 ingest/multi-import 路径统一：新书入内存后再写盘 | 0.5–1 |
| C-5 | **TTSController stop/新会话 abort 竞态**：3s 超时下旧 speak 的 finally abort 掉新 speak 的控制器 → 新会话无声 | `services/tts/TTSController.ts:962-1157` | abort 判定按会话代/仅中止当前代控制器 | 1 |
| C-6 | **Annotator onLoad 8+ 监听无清理**：touch/pointer/selectionchange 等仅靠 iframe 销毁回收 | `annotator/Annotator.tsx:339-422` | onLoad 返回 cleanup，随 doc 生命周期成对移除 | 0.5 |
| C-7 | **8 个设置命令点了没反应**：panelMap 缺 color/library 键，Theme 系命令永不切面板 | `components/settings/SettingsDialog.tsx:197` + `commandRegistry.ts:340+` | panelMap 补 `color:'Theme'`、`library:'Theme'`（一行） | 0.5 |
| C-8 | **设置对话框无焦点锁/aria**：`<dialog>` 无 focus trap、无 aria-modal/名，Tab 可逃 | `components/Dialog.tsx:179-185` | 加 ~30 行焦点环 + 补 aria-label 与 aria-modal | 0.5–1 |
| C-9 | **CommandPalette 选中索引错位**：跨类交错命中时高亮行重复、Enter 执行不一致 | `CommandPalette.tsx:226` | 全局索引改扁平化结果序，弃 startIndex+catIndex | 1 |
| C-10 | **simplecc 划词无 init 守卫**：未 await init → wasm 未载时每次划词抛错、搜索静默失效 | `utils/simplecc.ts:35` | 调用改 async 或前置 await initSimpleCC；Annotator 端 try/catch | 0.5 |
| C-11 | **编码探测双实现 + 阈值不一致**：`detectTxtEncodingFromFile`(:160, 5%) 与 `detectEncodingFromFile`(:649, 30%/10%) 并存，同文件两次探测可能不同 | `utils/txt.ts:160,649` | 合并单实现，统一阈值；候选提取与正式导入共用 | 0.5–1 |
| C-12 | **ReadingRuler 节流丢末位置**：throttle 10s 保存，拖动后 10s 内卸载丢位置 | `ReadingRuler.tsx:293-298` | 卸载 flush 或响应式周期存档 | 0.5 |
| C-13 | **i18n 回退空壳 + zh-TW 缺键**：en 仅 140 键（回退显示 key 名），zh-TW 缺 19/11 键 | `public/locales/*`、`i18n.ts:22` | zh-TW 按 zh-CN diff 补齐；en 至少保证关键 UI 有值 | 0.5–1 |
| C-14 | **description 未净化直插**：`i18n escapeValue:false` + dangerouslySetInnerHTML 插入 epub 描述原文 | `BookDetailView.tsx:368`、`i18n.ts:46` | 描述过一轮 HTML 净化白名单或改纯文本渲染 | 0.5 |

---

## 3. 批次 3：性能（9–15 人日）

沿用 8-30 报告 P0/P1 编号。优先做无回归项（P-2/P-4/P-7/P-9），要点场景再动排序核心（P-1）。

| 编号 | 瓶颈 | 位置 | 修法 | 预期收益 | 估时 |
|---|---|---|---|---|---|
| P-1 | drop 全链重建：refreshGroups O(N·depth) MD5 + 全量重排比较器 O(组内书数) | `libraryStore.ts:184,212-239`、`Bookshelf.tsx:424-523,446-510` | 组排序键预计算；refreshGroups 仅 name 变化时算 MD5；避免原地改 memo 产物 | 每次 drop 主线程清理成本 O(N·B·log)→O(N+G·logG) | 1–2 |
| P-2 | **Virtuoso 渲染扇出**（低风险优先）：selection 身份每 render 变 → 全窗口重渲 | `Bookshelf.tsx:817,1031-1048` | store 暴露稳定 Set 引用 + useCallback 稳定 deps + BookshelfItem memo | 重渲粒度"每次 render"→"仅变化" | 0.5–1 |
| P-3 | 拖拽 move 每帧强制 reflow：rect+querySelectorAll+elementFromPoint | `Bookshelf.tsx:1275-1337` | ghost 用 transform+缓存尺寸；高亮清除存上帧元素 ref；rAF 帧批处理 | 拖拽 60fps 稳定 | 1–2 |
| P-4 | **搜索 fuzzy/nearby 逐节往返 + 每节重建 Segmenter**（低风险优先） | `librarySearchService.ts:574,580`、`library-search-algorithms.js:12,242` | 整批节一次投递 worker 内循环；Segmenter 提单例；nearby 传 words；索引分页读 | 整本搜索数秒→<1s，内存降 | 1–2 |
| P-5 | 滚屏每事件整背景重建：scroll 未防抖 + 每次 ~10 布局读 | `foliate-js/paginator.js:1449-1512,1768-1825` | scroll rAF 合并；背景仅位置/尺寸变化时更新 | 滚动主线程占用下降 | 0.5–1 |
| P-6 | 翻章 transform 无缓存，refcount 驱逐即重跑 | `epub.js:897-913`、`transformService.ts:4-19`、`FoliateViewer.tsx:264` | transform 输出按 (chapterKey+设置hash) LRU，随设置失效 | 翻回旧章 CPU 减半（估算） | 2–3 |
| P-7 | **transformTarget 监听泄漏**（低风险优先）：无 cleanup，同书重开 handler 累积 | `FoliateViewer.tsx:647,678` | open effect 返回 cleanup 移除监听 | 重复打开同书不再 N 倍放大 | 0.5 |
| P-8 | 搜索结果未虚拟化 | `LibrarySearchResults.tsx:437` | 组内子项虚拟化渲染 | 高命中查询首屏/滚动流畅 | 2–3 |
| P-9 | **TXT 多趟重读 + 逐 segment 重编译正则**（低风险优先） | `txt.ts:504-535,865:1019-1042` | probe 合并进一次流；字母正则池复用 | 大 TXT 识别收敛到 1 趟流 | 1–2 |
| P-10 | 统计 N+1 IPC（历史②） | `statisticsDb.ts:275-291` | 回填路径 VALUES 多行合并 + touched 聚合 | 大 pull 从小时级 IPC 降秒级 | 1 |
| P-11 | dir_scanner 重复 stat | `dir_scanner.rs:99,107` | 复用 entry.metadata()；extensions 判空移循环外 | 扫描大目录耗时近半 | 0.5 |

---

## 4. 批次 4：代码卫生 / 死代码 + 暂缓项

### 4.1 可做（4–6 人日）

| 编号 | 问题 | 位置 | 估时 |
|---|---|---|---|
| D-1 | 删 `reorderShelfLayer` 死代码 + 360 行死测试 | `libraryUtils.ts:1146`、`reorder-shelf-layer.test.ts` | 0.5 |
| D-2 | 清生产 console.log（[nav]/[create]/open-with 等） | `page.tsx:640,661,685,796,802`、`Bookshelf.tsx:1198` | 0.25 |
| D-3 | 判别式三套统一（format/books/hash） | `Bookshelf.tsx:428,764` 等 + `libraryUtils.ts` | 0.5 |
| D-4 | 合并重复 refreshGroups 调用 | `Bookshelf.tsx:960,1442,1486` | 0.25 |
| D-5 | 删死参数 `_syncBooks` | `page.tsx:1141` | 0.25 |
| D-6 | 双套 primitives 合一；删未用 12 文件；清理死状态 requestedSubPage | `components/primitives/**`、`store/settingsStore.ts:29` | 0.5–1 |
| D-7 | set 原地突变 → 重建新对象（themeStore/customFont/customTexture/saveSysSettings/ThemePanel/MiscPanel） | `themeStore.ts:204-221`、`customFontStore.ts:387`、`customTextureStore.ts:404`、`helpers/settings.ts:109-120` 等 | 0.5–1 |
| D-8 | chapterTextCache evict 边界（size>1 永不驱逐末条） | `utils/chapterTextCache.ts:46` | 0.25 |
| D-9 | mdict dispose 关文件句柄 + init 中途 throw 清理 | `mdictProvider.ts:456-521,714-723` | 0.5 |
| D-10 | statisticsDb prune「retained+DELETE」两步原子化 | `statisticsDb.ts:160-167` | 0.25 |
| D-11 | searchIndexLock 30s 陈旧抢占放宽 | `searchIndexLock.ts:9,33` | 0.25 |
| D-12 | `lib.rs:155` 生产 unwrap → if-let | `src-tauri/src/lib.rs:155` | 0.25 |
| D-13 | drag effect 依赖含 `_`（useTranslation 身份不稳）|`Bookshelf.tsx:1511-1522` | 0.25 |
| D-14 | 硬编码中文（MiscPanel）|`MiscPanel.tsx:164-170` | 0.25 |

### 4.2 暂缓（高风险/低收益，不排期）

| 项 | 内容 | 裁决 |
|---|---|---|
| H-1 | HF2 整章遍历（paginator.js:406-474） | ❌ 触碰分页核心正确性，暂缓 |
| H-2 | turso 阻塞+单锁（wrapper.rs:134-189） | ⚠️ 高影响高难度，需连接池分片；桌面主战场才值得 |
| H-3 | MOBI 整读（mobi_parser.rs:74,107） | ⚠️ 已包 spawn_blocking 不卡主线程，仅内存峰值 |
| H-4 | range_file 无 fd 缓存 | ❌ 仅 Android 走 rangefile |
| H-5 | Blob 逐字节 JSON（decode.rs:23-28） | ❌ 休眠（迁移表无 BLOB 列） |
| H-6 | 只读命中 checkpoint（librarySearchService.ts:906-908） | ⚠️ 残留非 session 分支，生产传 session 已不可达 |
| Z-1 | RSVP setTimeout(:521,660) 脆弱、魔法数清理 | ⚠️ 当前安全，低价值 |
| Z-2 | 注释/变量英文混用风格统一 | ⚠️ 无功能价值 |

---

## 5. 备注

- 所有 `文件:行号` 指审查时现场（@e50da11）；实施前先 re-read 目标代码确认未漂移。
- 每批完成验收：`cd apps/readest-app && pnpm test -- run`（富测试是重构安全网）；仅改 src-tauri 时补 `pnpm clippy:check` + `pnpm test:rust` + `pnpm fmt:check`。
- 文档未提交 git；如需把本清单归档到 git 请明示。