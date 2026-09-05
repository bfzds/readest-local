# Readest Local 复核遗留问题可执行修复计划（2026-08-31）

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，按任务逐项执行。每项任务都要先写失败测试，再写最小实现；未完成验收前不得把条目标记为已修复。

**Goal:** 修复并准确关闭 `revision-fix-report-2026-08-31.md` 中仍未完成或被过度描述的安全、数据一致性、生命周期、可访问性和验收问题。

**Architecture:** 先修复会造成数据或权限风险的提交时序和跨窗口并发，再处理防御性上限、事件生命周期和焦点管理。报告状态修正与代码修复分开提交，所有持久化改动采用“准备副本 → 完成写入 → 提交内存/索引”的顺序；跨窗口 library 保存不能依赖单个 WebView 内的 JavaScript mutex，必须使用 Tauri 侧可共享的串行化机制。

**Tech Stack:** Next.js 16、React、TypeScript、Vitest、Playwright browser tests、Tauri v2、Rust、Tauri fs scope、SQLite/Turso statistics DB、pnpm 11。

**Spec:** `docs/reports/bugfix-followup-plan-2026-08-31.md`、`docs/reports/revision-fix-report-2026-08-31.md`。

## Global Constraints

- 本计划只处理复核后仍未关闭的缺口；已通过的 S-4、B-9、C-10、C-12、P-3 不做无关重构。
- 所有行为修复遵循 TDD：先写能稳定失败的回归测试，再实现最小变更。
- 失败路径不得更新调用方传入的数组、对象、lookup index、Zustand store 或磁盘快照。
- 任何权限收紧必须验证桌面端导入、打开、缩略图、部分 MD5、备份恢复和阅读流程。
- 计划中的测试由 `gpt-5.6-luna` 在独立子任务执行；Luna 只运行测试、记录命令和退出码，不修改代码。Sol/主模型负责解释失败并决定是否接受结果。
- 不使用 Codex 内置浏览器访问本地项目；浏览器测试使用仓库现有 Playwright/Vitest 命令。
- 本轮计划不改变 `allow-same-origin`；真正的 iframe origin 隔离仍需单独架构验证。

## 1. 修复范围与状态定义

### 1.1 必须修复的代码问题

| 优先级 | 编号 | 当前状态 | 本计划目标 |
| --- | --- | --- | --- |
| P0 | S-3 | 脚本清洗已完成，设置语义残留 | 删除死命令和残留字段，保持脚本永不执行；origin 隔离单独排期 |
| P1 | B-7 | 对象级 LWW 已完成，跨窗口原子冲突控制缺失 | 串行化 load-merge-save，增加真实交错保存测试 |
| P1 | B-6 | 数组副本已完成，`byFilePath` 提交时序错误 | 所有 index 更新延迟到最终提交点 |
| P1 | C-4 | await 和 generation 已完成，内存先于磁盘提交 | 保存成功后再提交内存状态，失败可回滚 |
| P1 | P-4 | worker 共享预算已完成，service 独立防线不完整 | 增加 service 端最终硬截断和 capped 语义测试 |
| P2 | C-6 | 未实施，仍有匿名 bind 和无 cleanup | 具名 handler、幂等 cleanup、重复 load 测试 |
| P2 | 焦点 | Dialog 已完成，CommandPalette 仅切换选中项 | 让 Tab 真正移动 DOM 焦点，并验证返焦 |

### 1.2 只需修正文档或状态的事项

- P-6：代码保留，删除“约 2⁶⁴”表述，改为“32 位输出，降低部分结构性碰撞风险”。
- S-1/S-2：保留已完成的 Temp 收紧和 parser scope 校验，状态改为“部分落地”；私有临时目录仅在确认真实生产落点后实施。
- Browser：5 个失败文件的数量属实，但 `EditorView > calls cancel after confirming` 单独归因；“截图失败”不能作为本轮已复核事实。
- 提交数量：从 13 更正为 11；`origin/readest-local` 已指向 `149311d` 的“已推送”描述可以保留。
- Tauri：本轮未重跑，不能将上轮 119/121 当成本轮结果。

## 2. 文件变更地图

### 2.1 代码文件

- `apps/readest-app/src/services/bookService.ts`：B-6 的 `byFilePath` 延迟提交。
- `apps/readest-app/src/services/libraryService.ts`：B-7 保存协议和合并接口。
- `apps/readest-app/src/app/library/page.tsx`：C-4 保存成功后的内存提交。
- `apps/readest-app/src/services/librarySearchService.ts`：P-4 service 端总上限防御。
- `apps/readest-app/src/app/reader/components/annotator/Annotator.tsx`：C-6 监听器生命周期。
- `apps/readest-app/src/components/command-palette/CommandPalette.tsx`：真实 DOM 焦点循环。
- `apps/readest-app/src/services/commandRegistry.ts`、`apps/readest-app/src/services/constants.ts`、`apps/readest-app/src/types/book.ts`：S-3 死命令和残留字段清理。

### 2.2 测试文件

- `apps/readest-app/src/__tests__/services/import-metahash.test.ts`
- `apps/readest-app/src/__tests__/services/library-merge.test.ts`
- `apps/readest-app/src/__tests__/services/library-search-worker.browser.test.ts`
- `apps/readest-app/src/__tests__/components/CommandPalette.test.tsx`
- `apps/readest-app/src/__tests__/reader/*.test.tsx`
- 新增 `apps/readest-app/src/__tests__/services/library-save-concurrency.test.ts`
- 新增 `apps/readest-app/src/__tests__/services/annotator-listener-lifecycle.test.tsx`（如现有测试工具支持挂载 Annotator）

### 2.3 文档文件

- `docs/reports/revision-fix-report-2026-08-31.md`：修正事实、状态、测试分类和提交数量。
- `docs/reports/revision-fix-executable-plan-2026-08-31.md`：本执行计划，不在执行阶段改写历史结论。

## 3. Task 0：先修正实施报告，建立可追踪基线

**Files:**

- Modify: `docs/reports/revision-fix-report-2026-08-31.md`
- Test: 无代码测试；使用 Git 命令核对提交和远端指针

**Interfaces:**

- Produces: 一份不把部分落地项写成完整修复的实施报告，供后续代码任务引用。

- [ ] **Step 1：更正提交数量和测试事实**

  将“本会话新增 13 个主仓提交”改为“从 `eedf1d6` 到 `149311d` 共 11 个提交”；保留 `origin/readest-local` 已指向 `149311d` 的事实。

- [ ] **Step 2：更正 P-6 描述**

  将“碰撞空间约 2⁶⁴”改成：

  > “两路 32 位 hash 与长度组合，降低部分结构性碰撞风险；最终指纹仍为 32 位，不能视为 64 位 hash。”

- [ ] **Step 3：调整项目状态**

  将 B-7、B-6、C-4、S-1/S-2、CommandPalette 焦点项改为“部分落地”或“有遗留风险”，并保留已完成的子项。

- [ ] **Step 4：修正 Browser 失败分类**

  把 `EditorView > calls cancel after confirming` 单独列为待归因失败；将“截图失败”改成“本次完整 browser 运行未到达截图断言，无法单独确认截图问题”。

- [ ] **Step 5：提交文档修正**

  ```bash
  git add docs/reports/revision-fix-report-2026-08-31.md
  git commit -m "docs: correct revision fix verification status"
  ```

**验收标准：** 报告中的数字、提交范围和状态与 `git rev-list`、Luna 测试记录及现场代码一致；没有把未重跑的 Tauri 套件写成当前通过。

## 4. Task 1：清理 S-3 的死设置入口（P0）

**Files:**

- Modify: `apps/readest-app/src/services/commandRegistry.ts:518`
- Modify: `apps/readest-app/src/services/constants.ts:337`
- Modify: `apps/readest-app/src/types/book.ts:233`
- Modify: 使用 `allowScript` 的 locale key、设置快照和常量测试
- Test: `apps/readest-app/src/__tests__/services/constants.test.ts`、命令注册表完整性测试

**Interfaces:**

- Consumes: 现有 sanitizer、`FoliateViewer` 的 `detail.allow = false`。
- Produces: 运行时不再存在可执行的 `allowScript` 设置命令；旧 JSON 中的 `allowScript` 被忽略而不是重新启用脚本。

- [ ] **Step 1：增加失败测试**

  在命令注册表测试中断言 `settings.control.allowJavascript` 不存在；在设置加载测试中提供带 `allowScript: true` 的旧配置，断言最终渲染仍走 sanitizer 且不会出现脚本开关。

- [ ] **Step 2：运行失败测试**

  ```bash
  cd apps/readest-app
  pnpm test -- --run src/__tests__/services/constants.test.ts
  ```

  预期：命令注册表断言失败，证明旧入口仍存在。

- [ ] **Step 3：删除死命令和新配置写入语义**

  从 `commandRegistry.ts` 删除 `settings.control.allowJavascript` 条目；从默认设置和 `Book`/`ViewSettings` 类型中移除仅用于运行时开关的字段。读取旧数据时不要求迁移删除，只允许未知字段被忽略。

- [ ] **Step 4：更新测试和 locale 引用**

  删除只验证 `allowScript` 类型存在的测试；删除不再可达的 locale key 断言；保留 sanitizer 的“即使传入 `allowScript: true` 也清洗”回归测试，证明旧配置不会恢复执行路径。

- [ ] **Step 5：运行通过测试并提交**

  ```bash
  pnpm test -- --run src/__tests__/services/constants.test.ts src/__tests__/services/transformers/transformers.test.ts
  git add apps/readest-app/src docs/reports/revision-fix-report-2026-08-31.md
  git commit -m "security: remove obsolete allow-javascript setting"
  ```

**验收标准：** 搜索设置、命令面板和旧配置加载都不会暴露或启用 JavaScript；`FoliateViewer` 仍没有 eval 路径，iframe origin 隔离状态仍明确标记为未完成。

## 5. Task 2：修复 B-6 的 index 提交时序

**Files:**

- Modify: `apps/readest-app/src/services/bookService.ts:800-830`
- Test: `apps/readest-app/src/__tests__/services/import-metahash.test.ts`

**Interfaces:**

- Consumes: `originalExistingHash`、草稿 `existingBook` 和现有最终提交块。
- Produces: `commitImportedBook()`（可在 `bookService.ts` 内定义为局部纯提交函数），统一更新 `books`、`byHash`、`byMetaKey`、`byFilePath`。

- [ ] **Step 1：增加失败注入测试**

  构造 `lookupIndex` 和已有书对象，让 `generateCoverImageUrl` 在 `byFilePath.set` 之后的原实现路径抛错；断言失败后：

  ```ts
  expect(books[0]).toBe(originalBook);
  expect(lookupIndex.byHash.get(originalHash)).toBe(originalBook);
  expect(lookupIndex.byFilePath.get(normalizedPath)).toBe(originalBook);
  ```

- [ ] **Step 2：运行测试确认当前失败**

  ```bash
  pnpm test -- --run src/__tests__/services/import-metahash.test.ts
  ```

  预期：新增的 `byFilePath` 引用断言失败。

- [ ] **Step 3：把路径索引更新改成待提交变更**

  在 `importBook` 中只记录 `pendingFilePathKey` 和 `pendingFilePathBook`，删除最终提交前的 `lookupIndex.byFilePath.set(...)`。在文件、封面、配置和 cover URL 全部成功后，再由统一提交块执行 `byFilePath.set`。

- [ ] **Step 4：补充成功路径断言**

  成功导入后断言 `books` 数组、`byHash`、`byMetaKey` 和 `byFilePath` 都指向同一个副本对象；重复导入仍能通过路径索引命中该副本。

- [ ] **Step 5：运行并提交**

  ```bash
  pnpm test -- --run src/__tests__/services/import-metahash.test.ts
  git add apps/readest-app/src/services/bookService.ts apps/readest-app/src/__tests__/services/import-metahash.test.ts
  git commit -m "fix: commit book lookup indexes atomically"
  ```

**验收标准：** 任一文件、封面、配置或封面 URL 生成失败时，数组和三个 lookup index 都保持原引用；成功时所有索引指向同一已提交对象。

## 6. Task 3：修复 C-4 的内存/磁盘提交顺序

**Files:**

- Modify: `apps/readest-app/src/app/library/page.tsx:638-684`
- Modify: `apps/readest-app/src/services/libraryService.ts`（如需返回最终合并结果）
- Test: `apps/readest-app/src/__tests__/helpers/open-with.test.ts`、`apps/readest-app/src/__tests__/app/library/library-navigation.test.ts`，以及新增的 library save 失败注入测试

**Interfaces:**

- Consumes: `processOpenWithFiles(appService, openWithFiles, libraryBooks)`。
- Produces: 保存成功后提交的最终 library 快照；保存失败时不改变当前 store、不导航。

- [ ] **Step 1：增加保存失败测试**

  mock `appService.saveLibraryBooks` 抛错，调用 Open With 流程，断言：

  ```ts
  expect(setLibrary).not.toHaveBeenCalled();
  expect(setPendingNavigationBookIds).not.toHaveBeenCalled();
  expect(result).toBe(false);
  ```

- [ ] **Step 2：运行失败测试**

  ```bash
  pnpm test -- --run src/__tests__/helpers/open-with.test.ts src/__tests__/app/library/library-navigation.test.ts
  ```

  预期新增断言在当前实现中失败，因为 `setLibrary` 位于 await 之前。

- [ ] **Step 3：保存前只构造草稿**

  保留局部变量 `library`，但删除保存前的 `setLibrary(library)`。Open With 导入期间只收集 `bookIds` 和待保存数组。

- [ ] **Step 4：保存成功后提交最终快照**

  如果 `saveLibraryBooks` 继续只返回 `void`，则保存成功后重新 `loadLibraryBooks()` 获取磁盘最终快照再调用 `setLibrary`；更优方案是让 `saveLibraryBooks` 返回实际写入的 merged 数组，并由调用方提交该返回值。不得把未合并的旧 `library` 当作最终状态。

- [ ] **Step 5：补 generation 交错测试**

  同时启动两次初始化，第一轮在保存前失效；断言第一轮既不 `setLibrary`、不导航，也不关闭第二轮 loading。

- [ ] **Step 6：运行并提交**

  ```bash
  pnpm test -- --run src/__tests__/app src/__tests__/services/library*
  git add apps/readest-app/src/app/library/page.tsx apps/readest-app/src/services/libraryService.ts apps/readest-app/src/__tests__
  git commit -m "fix: commit Open With library state after persistence"
  ```

**验收标准：** 保存失败时内存、磁盘和导航状态都不出现半提交；保存成功后 store 反映实际磁盘快照；旧 generation 不能改变新 generation 的 loading 或导航状态。

## 7. Task 4：为 B-7 增加跨窗口串行化保存

**Files:**

- Modify: `apps/readest-app/src/services/libraryService.ts`
- Modify: `apps/readest-app/src-tauri/src/lib.rs` 或现有 Tauri 文件服务模块
- Modify: `apps/readest-app/src/types/system.ts` 与 AppService bridge 类型
- Test: 新增 `apps/readest-app/src/__tests__/services/library-save-concurrency.test.ts`

**Interfaces:**

- Produces: `saveLibraryBooksSerialized(fs, books, options): Promise<Book[]>`，保证一次只有一个进程内/桌面窗口保存事务处于 load-merge-save 阶段，并返回最终写入数组。
- Produces: Tauri 侧 `with_library_lock` 或等价的独占锁接口；锁必须跨 WebView 共享，不能只是模块级 JS 变量。

- [ ] **Step 1：定义锁协议**

  使用应用数据目录下固定的 library lock 文件；Tauri 侧以独占创建方式取得锁，记录 owner token 和创建时间，成功后返回 token；释放时只允许持有 token 的调用方删除锁。锁等待超过固定 5 秒返回可识别错误，不静默覆盖其他窗口。

- [ ] **Step 2：增加锁单元测试**

  覆盖：首次获取成功、第二个 owner 等待、持有者释放后第二个 owner 成功、错误 token 不得释放、超时返回明确错误。

- [ ] **Step 3：增加真实交错保存测试**

  用可控 fake fs 在 A/B 保存之间插入 barrier，验证没有锁时会丢更新；接入锁后最终文件同时保留 A 的标题和 B 的阅读进度。

- [ ] **Step 4：把 LWW 合并放入锁内**

  `saveLibraryBooks` 的顺序固定为：获取锁 → 读取最新磁盘数组 → `mergeLibraryRows` → 原子写 backup/main → 返回 merged 数组 → 释放锁。释放锁必须放在 `finally` 中。

- [ ] **Step 5：保留 tombstone 和 replace 语义**

  routine save 继续保护 tombstone；`replace: true` 只能由初始化、迁移和明确的全量替换调用使用，并增加调用点测试，避免普通节流保存绕过锁。

- [ ] **Step 6：运行并提交**

  ```bash
  pnpm test -- --run src/__tests__/services/library-merge.test.ts src/__tests__/services/library-save-concurrency.test.ts
  pnpm fmt:check
  pnpm clippy:check
  git add apps/readest-app/src/services/libraryService.ts apps/readest-app/src-tauri apps/readest-app/src/types/system.ts apps/readest-app/src/__tests__
  git commit -m "fix: serialize cross-window library saves"
  ```

**验收标准：** 两个窗口同时保存不会丢失较新的字段或复活 tombstone；并发测试覆盖实际交错顺序，而不是只测试 `mergeLibraryRows` 纯函数。

## 8. Task 5：补 P-4 service 端最终硬截断

**Files:**

- Modify: `apps/readest-app/src/services/librarySearchService.ts:600-710` 及结果汇总循环
- Test: `apps/readest-app/src/__tests__/services/library-search-worker.browser.test.ts`、新增 service 层总量测试

**Interfaces:**

- Consumes: worker 返回的 `matches`、`truncated`、`capped`。
- Produces: service 对每本书最多 `MAX_BOOK_SEARCH_RESULTS`、全库最多 `MAX_TOTAL_SEARCH_RESULTS`，无论 worker 返回是否异常。

- [ ] **Step 1：增加异常 worker 测试**

  mock worker 返回超过 `remaining` 的结果，断言 service 最终 yield 数量不超过全库和单书上限，并将结果标记为 truncated/capped。

- [ ] **Step 2：运行失败测试**

  ```bash
  pnpm test -- --run src/__tests__/services/library-search*.test.ts
  ```

- [ ] **Step 3：在 service 汇总入口二次截断**

  在把每个 section 结果加入 `bookMatches`/`totalMatches` 前执行 `slice(0, remaining)`；remaining 小于等于 0 时停止消费后续结果，但保留正确的 capped 状态。

- [ ] **Step 4：验证排序和取消**

  对单 section、多 section、100 section、AbortSignal 中断分别断言排序、去重、取消和 capped 语义不变。

- [ ] **Step 5：运行并提交**

  ```bash
  pnpm exec vitest run --config vitest.browser.config.mts src/__tests__/services/library-search-worker.browser.test.ts
  pnpm test -- --run src/__tests__/services/library-search*.test.ts
  git add apps/readest-app/src/services/librarySearchService.ts apps/readest-app/src/__tests__
  git commit -m "fix: enforce library search limits at service boundary"
  ```

**验收标准：** 恶意或异常 worker 不能突破 service 的全库硬上限；正常 worker 的结果顺序和取消行为不变。

## 9. Task 6：完成 C-6 Annotator 监听器生命周期

**Files:**

- Modify: `apps/readest-app/src/app/reader/components/annotator/Annotator.tsx:339-430`
- Test: 新增或扩展 Annotator 生命周期测试

**Interfaces:**

- Produces: `attachSectionListeners(doc, index): () => void`，返回幂等 cleanup；同一 `Document` 重复 load 时只注册一次。

- [ ] **Step 1：增加监听器计数测试**

  mock `addEventListener/removeEventListener`，连续调用同一 `doc` 的 `onLoad` 两次；断言每类事件只注册一次，cleanup 后每个 handler 都被移除一次。

- [ ] **Step 2：运行失败测试**

  ```bash
  pnpm test -- --run src/__tests__/services/annotator-listener-lifecycle.test.tsx
  ```

  预期：当前 WeakSet 方案没有 cleanup，remove 计数断言失败。

- [ ] **Step 3：把匿名 handler 改为具名闭包**

  在 `attachSectionListeners` 内创建并保存 `handleTouchEndForDoc`、`handlePointerDownForDoc`、`handlePointerMoveForDoc`、`handleSelectionChangeForDoc` 等实际函数引用；所有 options 与监听器引用放入同一 cleanup 闭包。

- [ ] **Step 4：使用 Map 保存 cleanup**

  将 `WeakSet<Document>` 替换为 `WeakMap<Document, () => void>`；重复 load 直接返回已有 cleanup；cleanup 执行后从 Map 删除记录，避免同一 doc 后续重新 load 无法绑定。

- [ ] **Step 5：覆盖异常和卸载路径**

  在 iframe 替换、章节预加载、组件卸载、异常加载和窗口失焦时调用 cleanup；确认 renderer/global listener 不被重复挂到 section document 上。

- [ ] **Step 6：运行并提交**

  ```bash
  pnpm test -- --run src/__tests__/services/annotator-listener-lifecycle.test.tsx src/__tests__/reader
  git add apps/readest-app/src/app/reader/components/annotator/Annotator.tsx apps/readest-app/src/__tests__
  git commit -m "fix: clean up annotator section listeners"
  ```

**验收标准：** 同一 section 重复 load 100 次不会增加监听器；cleanup 后不会触发旧回调；注释、划词、触摸、指针和右键翻译行为保持不变。

## 10. Task 7：修复 CommandPalette 的真实 DOM 焦点循环

**Files:**

- Modify: `apps/readest-app/src/components/command-palette/CommandPalette.tsx:95-115, 293-320`
- Test: `apps/readest-app/src/__tests__/components/CommandPalette.test.tsx`；新增 Tab/Shift+Tab 焦点断言

**Interfaces:**

- Produces: `resultButtonRefs` 或等价 ref 列表；Tab 在 input、clear button、result buttons 之间按弹层规则循环。

- [ ] **Step 1：增加焦点测试**

  打开 palette 后断言 input 获得焦点；聚焦最后一个结果后按 Tab，断言焦点移动到第一个结果；聚焦第一个结果后按 Shift+Tab，断言焦点移动到最后一个结果；关闭后断言焦点回到触发控件。

- [ ] **Step 2：运行失败测试**

  ```bash
  pnpm test -- --run src/__tests__/components/CommandPalette.test.tsx
  ```

  预期：当前实现只改 `selectedIndex`，DOM `activeElement` 不变化。

- [ ] **Step 3：给结果按钮建立稳定 refs**

  为每个 `CommandResultItem` 传入 `ref` 或通过 `data-command-id` 查询当前可见按钮；结果变化后清理失效 ref，避免焦点落到已删除项。

- [ ] **Step 4：实现 Tab/Shift+Tab 移焦**

  在 `handleKeyDown` 中读取当前可聚焦元素列表，计算首尾并调用 `.focus()`；只有成功移动焦点时 `preventDefault()`。ArrowUp/ArrowDown 继续控制选中项，不与 Tab 语义混用。

- [ ] **Step 5：验证空结果和清除按钮**

  无结果、清空按钮存在、查询结果变化和鼠标点击后按 Tab 都要有明确焦点目标；保留 `aria-modal`、`role=listbox`、`role=option` 和返焦逻辑。

- [ ] **Step 6：运行并提交**

  ```bash
  pnpm test -- --run src/__tests__/components/CommandPalette.test.tsx
  git add apps/readest-app/src/components/command-palette/CommandPalette.tsx apps/readest-app/src/__tests__/components/CommandPalette.test.tsx
  git commit -m "fix: trap command palette DOM focus"
  ```

**验收标准：** Tab/Shift+Tab 在 palette 内移动真实 DOM 焦点，不逃逸到背景页面；Dialog 原有焦点循环和关闭返焦不回归。

## 11. Task 8：P-6 指纹策略与 S-1/S-2 私有临时目录决策

**Files:**

- Modify: `docs/reports/revision-fix-report-2026-08-31.md`
- Modify: `docs/reports/bugfix-followup-plan-2026-08-31.md`（同步状态说明）
- Test: capability snapshot 和 parser scope 回归测试；本任务不要求新增 hash 算法

**Interfaces:**

- Produces: 明确的“不扩空间”说明，以及私有临时目录的触发条件。

- [ ] **Step 1：补 P-6 代码注释**

  把 `transformService.ts` 注释中的“约 2⁶⁴”改成 32 位输出和结构性退化说明；不改变当前代码行为。

- [ ] **Step 2：补 S-1/S-2 状态表**

  明确删除 `$TEMP/**/*` 和统一 parser 校验已完成；私有临时目录未实施的原因是当前生产代码没有系统 Temp 导入/解压落点，不把它写成已修复。

- [ ] **Step 3：设置复评触发器**

  在计划中写明：未来新增 `os.tmpdir()`、`BaseDirectory::Temp`、系统临时解压目录或临时书籍文件流时，必须同时新增应用私有目录、生命周期清理、授权 token 和跨平台 scope 测试。

- [ ] **Step 4：运行静态护栏测试**

  ```bash
  pnpm test -- --run src/__tests__/tauri/capability-snapshot.test.ts
  pnpm fmt:check
  ```

- [ ] **Step 5：提交文档和注释修正**

  ```bash
  git add docs/reports/bugfix-followup-plan-2026-08-31.md docs/reports/revision-fix-report-2026-08-31.md apps/readest-app/src/services/transformService.ts
  git commit -m "docs: clarify hash and temp-scope status"
  ```

**验收标准：** 报告、计划和代码注释对 P-6 与 S-1/S-2 使用同一口径；没有为了“完成计划”而凭空引入无真实调用方的临时目录架构。

## 12. Task 9：补齐 Browser/Tauri 验收与失败归因

**Files:**

- Modify: `docs/reports/revision-fix-report-2026-08-31.md`
- Test: Browser 全套、Tauri 全套及各项定向测试

- [ ] **Step 1：由 Luna 复制 Sol 的测试命令**

  Luna 使用 `gpt-5.6-luna`，在 `apps/readest-app` 执行：

  ```bash
  pnpm test -- --run
  pnpm test:browser
  pnpm fmt:check
  pnpm clippy:check
  pnpm test:rust
  ```

  `pnpm test:tauri` 必须在 Git Bash 或提供 `bash` 的环境执行。

- [ ] **Step 2：记录 Browser 失败分类**

  分别记录：

  - `useEnv must be used within EnvProvider`：环境/测试装配问题；
  - ViewTransition fallback：单独确认实现或测试假设；
  - 跨 section 选择：单独确认选区实现；
  - `EditorView > calls cancel after confirming`：新报告中单独列项，不自动归入既有环境失败；
  - 截图断言：只有实际执行到截图断言并失败时才记录为截图问题。

- [ ] **Step 3：记录 Tauri 结果**

  每次记录命令、工作目录、退出码、通过/跳过/失败数量、首个堆栈和环境。PowerShell 报 `/bin/bash` 不存在时换 Git Bash 重跑，不修改测试脚本。

- [ ] **Step 4：执行手工验收**

  验证恶意 EPUB 无脚本/IPC、本地授权书库导入、Open With 保存失败、双窗口 library 并发、重复 prune、100 次 Annotator load、拖拽卸载、CommandPalette Tab/Shift+Tab 和 Dialog 返焦。

- [ ] **Step 5：更新最终报告**

  只有在代码测试和手工验收均有记录后，才把对应项从“部分落地”改为“已修复”。Browser 环境失败、未重跑的 Tauri 和未完成 origin 隔离必须继续单独列出。

## 13. 推荐执行顺序与提交边界

1. Task 0：先修正文档，固定共同事实。
2. Task 1：清理 S-3 死命令和残留字段。
3. Task 2：修复 B-6 index 提交时序。
4. Task 3：修复 C-4 保存成功后的内存提交。
5. Task 4：实现 B-7 跨窗口串行化保存。
6. Task 5：补 P-4 service 最终硬截断。
7. Task 6：完成 C-6 listener cleanup。
8. Task 7：完成 CommandPalette 真实 DOM 焦点循环。
9. Task 8：统一 P-6、S-1/S-2 状态和触发条件。
10. Task 9：由 Luna 执行完整回归，主模型统一判定。

每个 Task 单独提交；数据库、Tauri capability、跨窗口锁和 iframe 行为不得与普通 UI 清理混在同一提交。任何一项失败都应回滚该 Task 的提交，而不是回滚其他已验证修复。

## 14. 完成定义

本计划全部完成必须同时满足：

- B-6、B-7、C-4 有失败注入和真实交错测试，不只依赖纯函数测试。
- S-3 的安全主防线和残留设置入口都已关闭；origin 隔离另有明确未完成记录。
- P-4 service 端即使面对异常 worker 也不能突破结果上限。
- C-6 监听器可观测地成对注册和清理。
- CommandPalette 的 Tab/Shift+Tab 改变真实 DOM 焦点，而不是只改变 `selectedIndex`。
- P-6 不再出现 64 位空间的错误宣传；S-1/S-2 的私有临时目录状态和复评触发条件清楚。
- 前端、Rust、Browser、Tauri 和手工验收结果均有命令、退出码和失败归因记录。
- 只有主模型在审阅 Luna 结果后，才能在实施报告中写“已修复”或“验收通过”。

本文件是执行计划，不代表上述问题已经修复；生成本计划时未修改代码，也未执行修复。
