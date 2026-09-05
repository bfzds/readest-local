# Readest Local Bug 修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏桌面端离线阅读、导入、标注、书库分组和 TTS 行为的前提下，按优先级修复 `bugfix-plan-2026-08-30.md` 中确认的安全、数据丢失、一致性和性能问题。

**Architecture:** 先建立文件权限、持久化事务和竞态测试护栏，再按“安全 → 数据一致性 → 功能正确性 → 低风险性能 → 高风险性能 → 代码清理”推进。涉及书库和配置的数据写入采用不可变内存更新、版本化冲突合并和“先写入、后清理”的提交顺序。

**Tech Stack:** Next.js 16.2.11、React 19.2.8、TypeScript、Zustand、Vitest、Playwright、Tauri v2、Rust、pnpm。

**Spec:** `docs/reports/bugfix-plan-2026-08-30.md`

## Global Constraints

- 目标平台以 Tauri 桌面端为准；不把 web-only 性能收益作为排期依据。
- 基线为 `e50da11`；实施前按符号重新确认文件位置，不能机械依赖旧行号。
- 所有行为修改遵循 TDD：先写一个能正确失败的测试，再写最小实现。
- 不改变已有数据格式，除非先增加迁移、回滚和旧数据兼容测试。
- 书内脚本即使被用户显式允许，也不能获得宿主 Tauri IPC 权限。
- routine library save 不能删除磁盘上已有记录；显式删除必须携带明确的 replace/删除语义。
- 所有批次完成后运行完整测试、lint、格式检查和对应平台验证。

## 0. 交付边界与依赖

### 实施顺序

1. T0：建立基线和故障注入工具。
2. T1-T3：文件权限、书内 iframe 隔离、shell/env 收紧。
3. T4-T8：标注、初始化、分组、导入事务和 library save 修复。
4. T9-T12：统计、TXT、URL、TTS、监听器、设置和 i18n 修复。
5. T13-T15：低风险性能优化。
6. T16-T17：排序、拖拽、分页器、transform 和虚拟化等高风险性能优化。
7. T18：死代码和代码卫生清理。
8. T19：完整回归、离线验收和发布前检查。

### 不能合并的提交边界

- capability/iframe 安全改动与业务重构分开提交。
- 导入事务、library revision、统计迁移分别可回滚。
- worker 协议变更与 UI 虚拟化分开提交。
- D-1~D-14 清理项不与 P0 数据修复混合。

## Task 0：建立基线和故障注入护栏

**Files:**

- Test: `apps/readest-app/src/__tests__/store/book-data-store.test.ts`
- Test: `apps/readest-app/src/__tests__/store/library-store.test.ts`
- Test: `apps/readest-app/src/__tests__/services/ingest-service.test.ts`
- Test: `apps/readest-app/src/__tests__/statistics/statisticsDb.test.ts`
- Test: `apps/readest-app/src/__tests__/services/tts-controller-lifecycle.test.ts`
- Create: `apps/readest-app/src/__tests__/helpers/failure-injection.ts`（仅测试辅助）

**Steps:**

- [ ] 记录 `e50da11` 下完整测试数量、skipped 数量和失败清单。
- [ ] 为 filesystem mock 增加按调用序号抛错的能力，至少覆盖 `writeFile`、`removeDir`、`saveLibraryBooks`。
- [ ] 为 fake TTS client 增加可控延迟、abort 不响应和晚到 `finally` 场景。
- [ ] 为 store 测试增加 fake timer 初始化和清理，避免节流 timer 泄漏到其他测试。
- [ ] 运行 `pnpm test -- --run`，确认所有新增测试在实现前按预期失败或尚未启用。

**验收：** 后续每个数据丢失和竞态修复都能注入单点失败，不依赖手工断电或随机复现。

## Task 1：统一 Tauri 文件 scope 校验（S-1、S-2）

**Files:**

- Modify: `apps/readest-app/src-tauri/capabilities/default.json`
- Modify: `apps/readest-app/src-tauri/capabilities/desktop.json`
- Modify: `apps/readest-app/src-tauri/src/lib.rs`
- Modify: `apps/readest-app/src-tauri/src/epub_parser.rs`
- Modify: `apps/readest-app/src-tauri/src/mobi_parser.rs`
- Test: `apps/readest-app/src/__tests__/tauri/epub-parser-parity.tauri.test.ts`
- Create: `apps/readest-app/src/__tests__/tauri/path-scope.tauri.test.ts`

**Interface:**

```rust
fn validate_scoped_file(app: &AppHandle, raw: &str) -> Result<PathBuf, String>
```

**Steps:**

- [ ] 先写测试：允许用户通过 dialog 授权的文件，拒绝未授权文件、目录、空路径和 scope 外路径。
- [ ] 删除 `fs:read-all`、`fs:write-all`，保留应用数据、缓存和动态授权目录的显式 scope。
- [ ] 在 `lib.rs` 实现路径规范化、`canonicalize`、普通文件检查和 `fs_scope.is_allowed`。
- [ ] 让 EPUB/MOBI metadata、full parser、cover 命令统一调用校验函数。
- [ ] 运行 Tauri parser parity、path-scope 和导入回归测试。

**验收：** 越权路径命令返回拒绝；用户选择的外部书库仍能扫描、导入、打开和生成缩略图。

## Task 2：隔离书内 iframe 与宿主 IPC（S-3）

**Files:**

- Modify: `packages/foliate-js/paginator.js`
- Modify: `apps/readest-app/src/services/transformService.ts`
- Test: `apps/readest-app/src/__tests__/services/transformers/transformers.test.ts`
- Create: `apps/readest-app/src/__tests__/document/ebook-iframe-sandbox.browser.test.ts`

**Steps:**

- [ ] 先写恶意 EPUB fixture：书内脚本尝试读取 `window.__TAURI_INTERNALS__` 并调用 IPC。
- [ ] 首选保留 `allow-scripts`、移除 `allow-same-origin`，保持书内点击、选中、锚点和分页事件。
- [ ] 保持 `allowScript=false` 的清洗行为；`allowScript=true` 只允许书内脚本运行，不开放宿主 bridge。
- [ ] 若 WebKit 兼容性失败，再评估 srcdoc 入 iframe 前删除脚本的兼容方案。
- [ ] 在 Chromium/WebView2 和 WebKit 浏览器测试中分别验证隔离与交互行为。

**验收：** 恶意脚本无法调用宿主 IPC；正常 EPUB 交互和显式允许脚本的书内行为不回归。

## Task 3：收紧 shell 与环境变量（S-4）

**Files:**

- Modify: `apps/readest-app/src-tauri/capabilities/default.json`
- Modify: `apps/readest-app/src-tauri/src/lib.rs`
- Modify: `apps/readest-app/src/hooks/useFileSelector.ts`
- Modify: `apps/readest-app/src/__tests__/tauri/smoke.tauri.test.ts`

**Steps:**

- [ ] 先写测试：shell 参数含 `&|><%` 或换行时拒绝，正常 Readest 可执行文件路径仍通过。
- [ ] 优先将 `cmd /C start` 替换为 Tauri opener/受限启动接口。
- [ ] 若保留 shell，改为完整路径和平台专用参数白名单，不接受模糊的 `.*Readest.*`。
- [ ] 将 `get_environment_variable` 改为有限枚举，覆盖实际的 Gamescope 检测变量。
- [ ] 更新 smoke test，删除对任意 `HOME/PATH` 读取的依赖。

**验收：** 应用启动、Gamescope 检测和 AppImage/Windows 启动仍正常，任意环境变量和 shell 注入均被拒绝。

## Task 4：修复标注回填覆盖新数据（B-1）

**Files:**

- Modify: `apps/readest-app/src/app/reader/components/annotator/Annotator.tsx`
- Modify: `apps/readest-app/src/store/bookDataStore.ts`
- Test: `apps/readest-app/src/__tests__/store/book-data-store.test.ts`

**Steps:**

- [ ] 先写测试：回填期间新增、编辑、删除标注，最终结果都必须保留。
- [ ] 回填过程只保存待处理 annotation ID，不持有旧数组作为最终写入快照。
- [ ] 每个回填批次结束前重新读取 `getConfig(bookKey)`。
- [ ] 以 `note.id + updatedAt + deletedAt` 合并，只给当前仍缺少 page 的标注补值。
- [ ] 禁止原地修改旧 annotation；保存失败时保留内存状态并记录可重试错误。

**验收：** 回填不会吞掉用户在 5 秒宽限和 250ms 节拍期间产生的任何标注操作。

## Task 5：初始化 generation 和 Open With 一致性（B-2、C-3、C-4）

**Files:**

- Modify: `apps/readest-app/src/app/library/page.tsx`
- Modify: `apps/readest-app/src/store/libraryStore.ts`
- Test: `apps/readest-app/src/__tests__/app/library/migrate-data-window.test.tsx`
- Test: `apps/readest-app/src/__tests__/services/ingest-service.test.ts`

**Steps:**

- [ ] 先写测试：初始化尚未完成时卸载组件，旧 promise 不得修改新页面状态。
- [ ] 为每次 `initLibrary()` 分配 generation token，所有 `await` 后检查 token。
- [ ] 将多个 loading/check 布尔值的转换顺序固定为 `idle → loading → opening → ready/error`。
- [ ] `processOpenWithFiles()` 使用新数组，导入完成后一次性 `setLibrary(nextLibrary)`。
- [ ] 保存成功后再设置 pending navigation；保存失败时不写入旧数组。

**验收：** 快速返回、深链、Open With、Open Last Books 均无白屏、旧请求覆盖和部分库覆盖。

## Task 6：分组刷新与拖拽语义（B-3、B-4）

**Files:**

- Modify: `apps/readest-app/src/store/libraryStore.ts`
- Modify: `apps/readest-app/src/app/library/components/Bookshelf.tsx`
- Test: `apps/readest-app/src/__tests__/store/library-store-groups.test.ts`
- Test: `apps/readest-app/src/__tests__/app/library/reassign-to-group.test.ts`

**Steps:**

- [ ] 先写测试：删除组内最后一本书后空组立即消失，普通阅读进度更新不触发无谓重建。
- [ ] `updateBook()` 仅在 `groupName/groupId/deletedAt` 变化时调用 `refreshGroups()`。
- [ ] 将拖拽命中逻辑整理成“源类型 × 目标类型 × 区域”纯函数。
- [ ] 书拖入组无论上半区还是下半区都执行 merge；只有组拖组上半区执行 swap。
- [ ] 增加同组、空组、嵌套组、祖先组和无效目标测试。

**验收：** 高亮提示与实际行为一致；组删除、嵌套移动和保序逻辑不回归。

## Task 7：导入和合并事务化（B-5、B-6）

**Files:**

- Modify: `apps/readest-app/src/services/bookService.ts`
- Modify: `apps/readest-app/src/services/ingestService.ts`
- Modify: `apps/readest-app/src/store/libraryStore.ts`
- Test: `apps/readest-app/src/__tests__/services/ingest-service.test.ts`
- Create: `apps/readest-app/src/__tests__/services/book-service-transaction.test.ts`

**Steps:**

- [ ] 先写故障注入测试：配置写入失败、书文件复制失败、封面失败、旧目录删除失败。
- [ ] 将导入拆成“计算、提交、清理”三阶段；计算阶段只操作副本。
- [ ] `mergeBooks()` 返回不可变合并计划，不在函数内部设置 `deletedAt` 或删除目录。
- [ ] 先写目标配置和新文件，再写 library 索引；所有成功后才提交 store 对象。
- [ ] 清理旧目录放到最后；清理失败保留 tombstone，并允许下次重试。

**验收：** 任一中间步骤失败时，旧书目录、旧配置、内存 store 和 library 文件仍一致。

## Task 8：library save 版本化，阻止删除复活（B-7）

**Files:**

- Modify: `apps/readest-app/src/store/bookDataStore.ts`
- Modify: `apps/readest-app/src/services/libraryService.ts`
- Modify: `apps/readest-app/src/services/deleteLibraryService.ts`
- Modify: `apps/readest-app/src/utils/window.ts`
- Test: `apps/readest-app/src/__tests__/store/book-data-store.test.ts`
- Test: `apps/readest-app/src/__tests__/services/suites/library-tests.ts`

**Steps:**

- [ ] 先写测试：旧阅读窗口在主窗口删除书籍后，30 秒节流保存不能复活书籍。
- [ ] 为保存任务记录 generation/revision；删除全库或 replace save 时使旧任务失效。
- [ ] routine save 按 revision 合并，不能让旧 incoming 无条件覆盖更新的磁盘数据。
- [ ] 删除操作保留 tombstone，物理清理由独立流程执行。
- [ ] `flushPendingLibrarySave()` 在提交前后检查 revision，避免 flush 期间的更新被覆盖。

**验收：** 双窗口修改、删除、清空书库、窗口关闭和节流 flush 均不会出现旧记录复活。

## Task 9：TXT 章节规则和统计页数（B-8、B-9）

**Files:**

- Modify: `apps/readest-app/src/utils/txt.ts`
- Modify: `apps/readest-app/src/services/statistics/statisticsDb.ts`
- Test: `apps/readest-app/src/__tests__/utils/txt-extension.test.ts`
- Test: `apps/readest-app/src/__tests__/statistics/statisticsDb.test.ts`
- Create: `apps/readest-app/src-tauri/migrations/` 下的统计迁移（仅在确认需要新增字段后）

**Steps:**

- [ ] 先写 TXT 测试：用户捕获组、非捕获组、非法规则和 ReDoS 规则分别得到明确结果。
- [ ] 第一版将用户规则契约固定为“不带捕获组”，并给出迁移提示；不要悄悄改变规则含义。
- [ ] 先写统计测试：同一页出现在已裁剪区和保留区时只能计数一次。
- [ ] prune 时计算“被删页集合减去保留页集合”，再累计到历史唯一页数。
- [ ] 累计、DELETE 和 recompute 放在同一事务中，补充旧数据库迁移测试。

**验收：** TXT 目录不再因双捕获组错位；统计总页数在 prune 后不回缩、不重复累计。

## Task 10：统一书库 URL 同步（C-1、C-2）

**Files:**

- Modify: `apps/readest-app/src/app/library/page.tsx`
- Create: `apps/readest-app/src/app/library/libraryQueryParams.ts`
- Test: `apps/readest-app/src/__tests__/app/library/library-navigation.test.ts`

**Interface:**

```ts
parseLibraryQuery(search: string): LibraryQueryState
serializeLibraryQuery(state: LibraryQueryState): string
```

**Steps:**

- [ ] 先写参数顺序不同但语义相同的比较测试。
- [ ] 统一键顺序、空值处理和布尔值编码。
- [ ] `router.replace()` 作为唯一导航写入通道。
- [ ] 将 Next.js 空 `group=` workaround 封装为单独函数，禁止其他代码直接改 history。
- [ ] 测试搜索、进入虚拟分组、返回父组、浏览器 back/forward。

**验收：** 参数顺序变化不触发重复导航，URL、书架状态和 sessionStorage 始终一致。

## Task 11：TTS 会话和章节监听生命周期（C-5、C-6、P-7）

**Files:**

- Modify: `apps/readest-app/src/services/tts/TTSController.ts`
- Modify: `apps/readest-app/src/app/reader/components/annotator/Annotator.tsx`
- Modify: `apps/readest-app/src/app/reader/components/FoliateViewer.tsx`
- Test: `apps/readest-app/src/__tests__/services/tts-controller-lifecycle.test.ts`
- Test: `apps/readest-app/src/__tests__/services/tts-proofread-doc-sync.test.ts`

**Steps:**

- [ ] 先写 fake client 测试：旧 speak stop 超时后，新 speak 仍能发声。
- [ ] 为 `#speak()` 增加 session ID；`finally` 只清理当前 session 的 controller/promise。
- [ ] 为 Annotator section 监听器使用 `AbortController`，避免匿名 bind 无法清理。
- [ ] 为 FoliateViewer 的 `transformTarget` load/data 监听保存具名 handler 并在 effect cleanup 移除。
- [ ] 测试同书反复打开、章节预加载 100 次、关闭 view 后无重复回调。

**验收：** TTS 不会因旧会话晚到而无声；监听器数量不会随重复打开线性增长。

## Task 12：设置、命令面板和 i18n 安全（C-7～C-14）

**Files:**

- Modify: `apps/readest-app/src/components/settings/SettingsDialog.tsx`
- Modify: `apps/readest-app/src/components/Dialog.tsx`
- Modify: `apps/readest-app/src/components/command-palette/CommandPalette.tsx`
- Modify: `apps/readest-app/src/components/metadata/BookDetailView.tsx`
- Modify: `apps/readest-app/src/i18n/i18n.ts`
- Modify: `apps/readest-app/public/locales/en/translation.json`
- Modify: `apps/readest-app/public/locales/zh-TW/translation.json`
- Test: `apps/readest-app/src/__tests__/components/CommandPalette.test.tsx`
- Test: `apps/readest-app/src/__tests__/components/BookDetailView.test.tsx`
- Test: `apps/readest-app/src/__tests__/services/command-registry-extended.test.ts`

**Steps:**

- [ ] 先写命令面板分类交错、Enter 执行和设置面板映射测试。
- [ ] `panelMap` 增加 `color/library -> Theme`，并用命令注册表完整性测试防止再次缺键。
- [ ] Dialog 增加 `aria-modal`、焦点保存/恢复和 Tab 循环；验证移动端底部弹层。
- [ ] CommandPalette 使用 `commandId -> globalIndex`，不再通过分类起始索引推导。
- [ ] BookDetailView 优先纯文本渲染；若保留格式，使用 DOMPurify 白名单并测试恶意 HTML。
- [ ] 增加 locale key diff 测试，补齐 `zh-TW` 和关键英文文案。

**验收：** 设置命令可达、键盘焦点不逃逸、恶意描述不执行、关键 locale 不显示内部 key。

## Task 13：simplecc、编码探测和 ReadingRuler（C-10～C-12）

**Files:**

- Modify: `apps/readest-app/src/utils/simplecc.ts`
- Modify: `apps/readest-app/src/utils/txt.ts`
- Modify: `apps/readest-app/src/utils/throttle.ts`
- Modify: `apps/readest-app/src/app/reader/components/ReadingRuler.tsx`
- Test: `apps/readest-app/src/__tests__/utils/txt-converter.test.ts`
- Test: `apps/readest-app/src/__tests__/components/ReadingRuler.test.tsx`

**Steps:**

- [ ] 先写 simplecc 未初始化、并发初始化和初始化失败测试。
- [ ] 使用共享初始化 Promise；转换失败时返回原文或明确可恢复错误。
- [ ] 合并两个编码探测实现，统一阈值、候选顺序和采样策略。
- [ ] 为 throttle 增加 `flush()`、`cancel()`，ReadingRuler 卸载时 flush。
- [ ] 使用 fake timers 验证拖动结束、卸载、取消拖动三种保存路径。

**验收：** 首次划词不会因 WASM 未完成而静默失败；大 TXT 不重复完整读取；阅读尺卸载不丢最后位置。

## Task 14：低风险性能优化（P-2、P-4、P-7、P-9、P-11）

**Files:**

- Modify: `apps/readest-app/src/app/library/components/Bookshelf.tsx`
- Modify: `apps/readest-app/src/app/library/components/BookshelfItem.tsx`
- Modify: `apps/readest-app/src/services/librarySearchService.ts`
- Modify: `apps/readest-app/src/services/librarySearchWorker.ts`
- Modify: `apps/readest-app/public/workers/library-search-algorithms.js`
- Modify: `apps/readest-app/src/utils/txt.ts`
- Modify: `apps/readest-app/src-tauri/src/dir_scanner.rs`
- Test: `apps/readest-app/src/__tests__/services/library-search-worker.browser.test.ts`
- Test: `apps/readest-app/src/__tests__/services/library-search-service.test.ts`

**Steps:**

- [ ] 先记录 library-search 基线：耗时、postMessage 次数、结果顺序和内存峰值。
- [ ] Bookshelf 直接使用已有稳定 `selectedBookSet.has()`，并对 `BookshelfItem` 使用 `React.memo`。
- [ ] 搜索 worker 新增 bounded `search-batch`，每批 50～200 个 section，不发送一个超大消息。
- [ ] Segmenter 按 locale 缓存；批量结果保留逐节实现的顺序、截断和取消语义。
- [ ] TXT probe 保留已读取缓冲区，正则按规则集合缓存且有上限。
- [ ] Rust scanner 复用 DirEntry metadata，并保持 symlink/权限行为不变。

**验收：** 单次拖拽 hover 不再造成全窗口重渲；搜索往返次数下降；结果与旧实现逐项一致。

## Task 15：高风险渲染和拖拽性能（P-1、P-3、P-5）

**Files:**

- Modify: `apps/readest-app/src/app/library/components/Bookshelf.tsx`
- Modify: `packages/foliate-js/paginator.js`
- Test: `apps/readest-app/src/__tests__/document/paginator-background-anim-perf.browser.test.ts`
- Test: `apps/readest-app/src/__tests__/document/paginator-scrolled.browser.test.ts`

**Steps:**

- [ ] 先建立拖拽 1000/2000 本书和滚动背景的性能基线。
- [ ] ghost 尺寸只在拖拽开始、内容变化和 resize 时读取；逐帧用 transform。
- [ ] pointermove 只记录最新坐标，命中测试、高亮和 ghost 更新放入 rAF。
- [ ] pointer-up、pointer-cancel、组件卸载时 flush/cancel rAF。
- [ ] 排序键预计算时严格复用现有 `getGroupSortValue()` 的聚合语义，禁止统一改成 min/max。
- [ ] paginator 背景更新加 rAF，但保留现有导航 debounce、触摸拖动和稳定化行为。

**验收：** 拖拽跟手、边缘翻转、高亮和 drop 语义不变；滚屏不出现背景错位；长任务明显下降。

## Task 16：transform 缓存、搜索虚拟化和统计批量写入（P-6、P-8、P-10）

**Files:**

- Modify: `apps/readest-app/src/services/transformService.ts`
- Modify: `apps/readest-app/src/app/reader/components/FoliateViewer.tsx`
- Modify: `apps/readest-app/src/app/library/components/LibrarySearchResults.tsx`
- Modify: `apps/readest-app/src/services/statistics/statisticsDb.ts`
- Test: `apps/readest-app/src/__tests__/services/tts-proofread-doc-sync.test.ts`
- Test: `apps/readest-app/src/__tests__/app/library/library-search-results.test.tsx`
- Test: `apps/readest-app/src/__tests__/statistics/statisticsDb.test.ts`

**Steps:**

- [ ] 先测量翻回旧章节、展开 2000 条搜索结果、远端回填 1000 条事件的基线。
- [ ] transform cache 使用章节、内容版本、transformer、locale 和相关设置组成的 key。
- [ ] LRU 同时限制条目数和总字节数；设置变化只失效受影响 key。
- [ ] 搜索结果仅虚拟化展开内容，保留 sticky header、折叠状态、键盘和 ARIA 行为。
- [ ] statistics remote pull 使用分块 VALUES/批量 insert，按 SQLite 参数上限切块。
- [ ] 验证批量写入部分失败时整个事务回滚。

**验收：** 翻回旧章不重复执行全部 transform；大搜索结果首屏和滚动可用；大批量统计回填不再 N+1 IPC。

## Task 17：代码卫生和死代码（D-1～D-14）

**Files:**

- Modify/Delete: `apps/readest-app/src/app/library/utils/libraryUtils.ts`
- Modify/Delete: `apps/readest-app/src/__tests__/app/library/reorder-shelf-layer.test.ts`
- Modify: `apps/readest-app/src/app/library/page.tsx`
- Modify: `apps/readest-app/src/app/library/components/Bookshelf.tsx`
- Modify: `apps/readest-app/src/store/settingsStore.ts`
- Modify: `apps/readest-app/src/store/themeStore.ts`
- Modify: `apps/readest-app/src/store/customFontStore.ts`
- Modify: `apps/readest-app/src/store/customTextureStore.ts`
- Modify: `apps/readest-app/src/utils/chapterTextCache.ts`
- Modify: `apps/readest-app/src/services/mdictProvider.ts`
- Modify: `apps/readest-app/src/services/searchIndexLock.ts`
- Modify: `apps/readest-app/src-tauri/src/lib.rs`
- Modify: `apps/readest-app/src/app/library/components/MiscPanel.tsx`

**Steps:**

- [ ] 先用 `rg` 确认死代码、死参数和未使用 primitive 没有运行时引用。
- [ ] D-1、D-5、D-6 单独提交，避免和功能修复混合。
- [ ] console.log 不直接全部删除；需要保留的诊断改为统一 debug logger。
- [ ] Set/object 原地突变改为新对象，并为引用变化增加 store 测试。
- [ ] cache eviction、mdict dispose、lock owner token、Rust unwrap 替换分别补回归测试。
- [ ] 删除文件前确认文件由本次创建或已明确列入清理范围；不删除用户文件。

**验收：** lint、类型检查、死代码检查通过；清理不改变公开行为和持久化数据。

## Task 18：暂缓项复评标准

以下项目不进入本轮实施：HF2 整章遍历、Turso 单锁、MOBI 整读、range file fd 缓存、Blob 逐字节 JSON、只读 checkpoint、RSVP 魔法数清理和英文注释统一。

重新排期的条件：

- 有桌面端真实样本证明当前问题影响用户体验或数据安全。
- 有可重复的性能/内存/错误率基线。
- 能给出不改变分页、离线和跨平台行为的最小设计。
- 至少有一个可自动化的回归测试或基准。

## Task 19：最终验收

**自动化命令：**

```powershell
cd apps/readest-app
pnpm test -- --run
pnpm test:browser
pnpm test:tauri
pnpm lint
pnpm fmt:check
pnpm clippy:check
pnpm test:rust
pnpm bench library-search --no-record
```

**手工验收：**

- [ ] 断网导入 EPUB、PDF、TXT，并打开阅读。
- [ ] 恶意 EPUB 脚本不能访问宿主 IPC。
- [ ] 删除书籍、清空书库后旧窗口保存不会复活记录。
- [ ] 标注回填期间新增/编辑/删除标注均保留。
- [ ] Open With 快速导航无白屏、无旧请求覆盖。
- [ ] 书和组拖拽提示与实际行为一致。
- [ ] TTS 快速停止后重新播放有声音。
- [ ] 设置命令、焦点锁、键盘导航和屏幕阅读器行为正常。
- [ ] 搜索、滚动、拖拽和翻章无明显掉帧。
- [ ] E-ink 模式、离线功能、备份/恢复和无网络审计不回归。

## 完成定义

- 所有 P0 安全和数据丢失项有自动化回归测试。
- 每个批次有独立提交，能够单独回滚。
- 失败注入场景没有残留半写入文件、旧数据复活或内存/磁盘不一致。
- 性能结论同时记录硬件、数据规模、基线和优化后数值。
- 只在完成上述验收后，才将原始审查清单标记为已处理。
