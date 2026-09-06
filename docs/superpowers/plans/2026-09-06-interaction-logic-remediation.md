# 前端交互逻辑问题修复计划（2026-09-06）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 2026-09-06 前端交互审查确认的约 40 处交互逻辑缺陷，按"错误行为 > 可用性 > 一致性/卫生"三批落地。

**Architecture:** 全部为既有前端（Next.js + React + zustand + vitest）内的小步修复，不引入新依赖、不重构目录。按文件/子系统分组成任务，每任务独立可测、独立提交。跨任务共享的两类根因（keydown 监听器清理、settings 同引用 set）在对应任务内一并修复其所有实例。

**Tech Stack:** TypeScript / React 18 / zustand / vitest + testing-library / biome

**Spec:** 本对话 2026-09-06 四份探索代理审查结论（阅读器主界面、书库、设置与通用组件、阅读器内功能面板），问题清单与 file:line 证据已内嵌到各任务。与 2026-09-05 UX 计划（T1–T6，均已落地 commit 5528d60/18abb56/0072ff0/4da729a）无重叠。

## Global Constraints

- 不修改 `apps/readest-app/release/` 下任何内容（含用户数据）。
- 遵循仓库 conventional commits（`fix:` / `feat:` / `refactor:`），小写祈使句，单任务单提交。
- 每任务实现前先写/先跑失败测试（纯函数与 store 逻辑可单测；纯 DOM 手势类允许以现有组件测试模式 mock 事件验证）。
- 验证命令：`pnpm --filter readest-local test -- --run`（全量回归收尾），改动面板/样式后另跑 `pnpm fmt:check`。
- 不改变现有快捷键绑定的对外行为，除非任务明确说明（D1/D2 两项决策除外）。
- TTS、iframe、Rust 桥接相关改动必须手动冒烟（`pnpm tauri dev` 或便携版），不能只靠单测。
- i18n：新增用户可见文案需同步 `i18n-langs.json` 涉及语言（至少 zh-CN / en-US，scanner 流程照旧）。

## 已定决策（2026-09-06 用户确认）

- **D1 Backspace 硬拦截：收敛。** 用户有将 Backspace 绑定为快捷键的需求。`useShortcuts.ts:22-23` 的拦截范围收敛到 MessageEvent（iframe-keydown）路径，原生键盘 Backspace 恢复正常快捷键匹配。已核实 useGamepad 默认映射无 Backspace 键（Back→Tab、B/Start→Escape），桌面 WebView2 下 Backspace 无后退默认行为，收敛无回归风险。对应 T23。
- **D2 移动端：本项目只做桌面端，不做任何移动端相关修复。** T11 取消；T22 中移动端专属项（拖拽把手 a11y、hover 触发守卫、重复点当前 tab 收侧栏）移除。理由：640px 断点仅靠缩窗触发，非产品目标场景。

---

## 批次一：错误行为（P0，优先）

### Task 1: 打开 Font 面板不再清空缩放锚点

**Files:**
- Modify: `apps/readest-app/src/components/settings/FontPanel.tsx:247-253`
- Test: `apps/readest-app/src/__tests__/`（就近找 FontPanel 相关测试；无则新建）

**Interfaces:**
- Consumes: `saveViewSettings(envConfig, bookKey, key, value)`（helpers/viewSettings）
- Produces: 无新接口；行为约束为"挂载不改写 effectiveFontSize，仅 defaultFontSize 实际变化时联动清空"

- [ ] **Step 1 写失败测试**：渲染 FontPanel（mock viewSettings，`effectiveFontSize=120, defaultFontSize=18`），断言未调用 `saveViewSettings(..., 'effectiveFontSize', undefined)`；再变更 `defaultFontSize` 后断言调用一次。
- [ ] **Step 2 跑测试确认失败**（当前挂载即调用）。
- [ ] **Step 3 实现**：effect 内加未变化守卫，照 `LayoutPanel.tsx:170` 模式：
  ```ts
  useEffect(() => {
    if (defaultFontSize === viewSettings.defaultFontSize) return;
    saveViewSettings(envConfig, bookKey, 'defaultFontSize', defaultFontSize);
    void saveViewSettings(envConfig, bookKey, 'effectiveFontSize', undefined);
  }, [defaultFontSize]);
  ```
- [ ] **Step 4 跑测试通过 + 全量**。
- [ ] **Step 5 手动冒烟**：Ctrl+滚轮缩放 → 开设置 → 关设置 → 缩放保留。
- [ ] **Step 6 提交** `fix: preserve zoom anchor when opening font settings panel`

### Task 2: 确认弹窗 Enter 双触发 + 元素级 keydown 监听器泄漏（同根因合修）

**Files:**
- Modify: `apps/readest-app/src/hooks/useKeyDownActions.ts:31-49`
- Modify: `apps/readest-app/src/components/Dialog.tsx:105-125`
- Modify: `apps/readest-app/src/components/Alert.tsx:71-79`
- Test: `apps/readest-app/src/__tests__/`（Alert/Dialog 现有测试处就近）

**Interfaces:**
- Produces: `useKeyDownActions` 的 cleanup 同时移除 window 与 elementRef 上的 keydown；effect 依赖纳入回调或用 ref 持有最新回调（消除陈旧闭包）。

- [ ] **Step 1 写失败测试**：①挂载后卸载（或 ref 从有到无），spy `removeEventListener` 断言元素上也移除；②Alert：焦点在确认按钮时派发 `keydown Enter`，断言 `onConfirm` 恰好调用 1 次。
- [ ] **Step 2 跑测试确认失败**（当前：监听不移除；Enter 触发 2 次）。
- [ ] **Step 3 实现**：
  - `useKeyDownActions`：cleanup 补 `elementRef.current?.removeEventListener('keydown', handleKeyDown)`；用 `useRef` 保存最新 `onCancel/onConfirm`，监听器读 ref（依赖保持 `[enabled]`）。
  - `Dialog.tsx`：同样补元素级 removeEventListener。
  - `Alert.tsx`：确认按钮 click 处理加 `isProcessing` 早退已有，但 keydown 路径与 click 路径共用守卫——在 `useKeyDownActions` 层对 `event.key === 'Enter'` 且目标是可聚焦按钮时 `preventDefault()`（阻断浏览器派发 click），或 Alert 的 window 级 Enter 处理改为检查 `document.activeElement` 不为该确认按钮。二选一以测试定案，倾向前者（修在根因层）。
- [ ] **Step 4 跑测试通过 + 全量**；手动验证书库删除确认回车只删一次。
- [ ] **Step 5 提交** `fix: dedupe Enter confirmation and clean element keydown listeners`

### Task 3: 书库多选一致性（残留选中 / 全选回选 / 删除口径统一）

**Files:**
- Modify: `apps/readest-app/src/app/library/components/Bookshelf.tsx:570-616, 769-784, 1803-1805`
- Modify: `apps/readest-app/src/app/library/page.tsx`（搜索词/分组变化处清空 selection）
- Test: Bookshelf 相关现有测试就近补充

**Interfaces:**
- Produces: `getBooksToDelete()` 作为删除确认与实际删除的唯一口径（确认弹窗计数、执行删除都基于它）；`clearSelection()` 在 searchQuery 变化与分组导航（`handleLibraryNavigation`/`handleNavigateToPath`）时调用。

- [ ] **Step 1 写失败测试**：
  - 搜索词变化后 `selectedBooks` 为空；
  - `isSelectAll` 状态下变更 `currentBookshelfItems` 不覆盖用户手动取消的项（即 effect 不再无条件重选）；
  - 分组 A 选 2 本 → 切分组 B → 删除：确认弹窗计数为 0 且按钮禁用（而非显示 2）。
- [ ] **Step 2 跑测试确认失败**。
- [ ] **Step 3 实现**：
  - 搜索/分组导航处派发清空（`setSelectedBooks([])`、`setIsSelectAll(false)`）。
  - 全选 effect 改为仅在 `isSelectAll` **边沿**（从 false→true）时执行全量选择；手动取消后进入"部分选中"态（`isSelectAll` 置 false），任何 items 变化不再重置选择。头部按钮文案跟随实际选择数。
  - 删除入口改用 `getBooksToDelete()`：计数为 0 时禁用删除按钮并提示；确认文案、删除执行、toast 三处同源。
- [ ] **Step 4 跑测试通过 + 全量**。
- [ ] **Step 5 提交** `fix: consistent multi-select lifecycle and delete scope in library`

### Task 4: TTS 章节索引 0 被当作"未传"

**Files:**
- Modify: `apps/readest-app/src/app/reader/hooks/useTTSControl.ts:828`
- Test: 就近 useTTSControl 测试（纯逻辑部分）

- [ ] **Step 1 写失败测试**：`handleTTSSpeak` 传 `index: 0` 时 `ttsLocation` 基于 section 0 构造（不回退 `progress.index`）。
- [ ] **Step 2 确认失败**。
- [ ] **Step 3 实现**：`if (!ttsFromIndex)` → `if (ttsFromIndex === null)`。
- [ ] **Step 4 测试通过**。
- [ ] **Step 5 提交** `fix: treat section index 0 as valid tts start index`

### Task 5: TTS 空章节回滚完整 + isPaused 状态机收敛

**Files:**
- Modify: `apps/readest-app/src/app/reader/hooks/useTTSControl.ts:871, 953-958, 1029-1050, 757-765`
- Modify: `apps/readest-app/src/app/reader/components/tts/TTSControl.tsx:59`（expand 手势反馈，见 Task 15a 可合入本任务）
- Test: useTTSControl 状态测试

**Interfaces:**
- Produces: `handleTTSSpeak` 的失败回滚统一走一个 `resetTtsUiState()`（`isPlaying=false, isPaused=false, showIndicator=false`）；`handleStop` 同样重置 `isPaused=false`。

- [ ] **Step 1 写失败测试**：ssml 为空时断言 `showIndicator=false`、`isPaused=false`、mini player 不显示；`handleStop` 后 `isPaused=false`。
- [ ] **Step 2 确认失败**。
- [ ] **Step 3 实现**：抽 `resetTtsUiState` 供"无可朗读内容"分支与 `handleStop` 共用；"无可朗读内容"分支不再执行 `setTTSEnabled(bookKey, true)`（或保持但 UI 完全复位——以测试定案）。
- [ ] **Step 4 测试通过 + 手动冒烟**：空章节书（如仅封面的 EPUB）启动朗读 → 播放器不滞留、可重新播放。
- [ ] **Step 5 提交** `fix: complete tts rollback and isPaused state transitions`

### Task 6: 元数据编辑防误关

**Files:**
- Modify: `apps/readest-app/src/components/metadata/BookDetailModal.tsx:84-88`
- Test: 组件测试（editMode 下 Esc/遮罩关闭被拦截）

**Interfaces:**
- Consumes: `Dialog` 的 `dismissible` prop
- Produces: `handleClose` 在 `editMode && 有未保存修改` 时改走确认（复用 `Alert` confirm 模式："放弃修改？"），确认后才 `handleCancelEdit + onClose`。

- [ ] **Step 1 写失败测试**：editMode 下派发 Esc → 出现确认而非直接关闭；确认后关闭。
- [ ] **Step 2 确认失败**。
- [ ] **Step 3 实现**：`Dialog` 传 `dismissible={!editMode}`；`handleClose` 分支化 + Alert 确认。
- [ ] **Step 4 测试通过**。
- [ ] **Step 5 提交** `fix: confirm discard on closing metadata edit mode`

### Task 7: 设置对话框关闭前拦截未 Apply 草稿

**Files:**
- Modify: `apps/readest-app/src/components/settings/MiscPanel.tsx`（暴露草稿状态）
- Modify: `apps/readest-app/src/components/settings/SettingsDialog.tsx:462-467`
- Test: 组件测试

**Interfaces:**
- Produces: MiscPanel 通过 store/回调向上报告 `hasUnsavedDraft`；SettingsDialog 在关闭/切 tab 时若为 true 先 Alert 确认（"放弃未应用的更改？"）。

- [ ] **Step 1 写失败测试**：修改 CSS 草稿不 Apply → 关闭对话框 → 出现确认；确认后草稿丢弃，取消后留在面板。
- [ ] **Step 2 确认失败**。
- [ ] **Step 3 实现**：草稿状态提升（zustand 小 store 或 props 回调，取改动最小方案）；SettingsDialog 关闭路径统一走一个 `requestClose()`。
- [ ] **Step 4 测试通过 + 全量**。
- [ ] **Step 5 提交** `fix: warn on unsaved misc settings drafts before closing`

---

## 批次二：明显可用性（P1）

### Task 8: ESC 关闭顺序（弹层栈）

**Files:**
- Modify: 新建 `apps/readest-app/src/app/reader/utils/escapeStack.ts`（~40 行）
- Modify: `SideBar.tsx:174`、`Notebook.tsx:91`、`NoteEditor.tsx:91-99`、搜索栏（SearchBar）注册处
- Test: escapeStack 单测 + 组件集成测试

**Interfaces:**
- Produces: `pushEscapeHandler(id, handler) / popEscapeHandler(id)`；栈顶唯一响应 Esc，处理完或不再处理则弹出后由下一层接管。所有 useShortcuts 的 `onEscape` 消费点迁移到栈模型（useShortcuts 的其他键位不动）。

- [ ] **Step 1 写 escapeStack 单测**：后进先出；栈顶 handler 返回 false（未消费）则传递下一层；同 id 重复 push 幂等。
- [ ] **Step 2 确认失败 → 实现 escapeStack → 测试通过**。
- [ ] **Step 3 迁移消费点**：NoteEditor > Notebook > SideBar > SearchBar 的注册顺序与实际 z 序一致（NoteEditor 最顶）。每处保留原有行为函数作为 handler。
- [ ] **Step 4 集成测试**：侧栏+笔记编辑同开，一次 Esc 只退出编辑；再 Esc 关笔记本；再 Esc 关侧栏。
- [ ] **Step 5 全量 + 手动冒烟**。
- [ ] **Step 6 提交** `fix: layered escape handling across reader panels`

### Task 9: iframe 内鼠标侧键双重触发

**Files:**
- Modify: `apps/readest-app/src/app/reader/utils/iframeEventHandlers.ts:356-377, 404-411`
- Modify: `apps/readest-app/src/app/reader/hooks/usePagination.ts:288-293`
- Test: 消息派发单元测试

- [ ] **Step 1 写失败测试**：iframe 转发 button 3/4 的 mousedown 后，mouseup 消息不再触发 `view.history.back()`（只保留 library-nav 一条路径）；同步对齐窗口路径行为：搜索栏打开时后退键=收起搜索栏（复用 `useMouseNavigation.ts:46-50` 的互锁判断，通过共享工具函数）。
- [ ] **Step 2 确认失败**。
- [ ] **Step 3 实现**：`iframeEventHandlers` 的 mouseup 转发里对 button 3/4 直接吞掉（与注释"we will handle mouse back and forward buttons ourselves"一致）；usePagination 移除 3/4 分支；互锁逻辑抽 `shouldMouseBackCollapseSearchBar()` 共享。
- [ ] **Step 4 测试通过 + 手动冒烟**（书内与书外按侧键各一次）。
- [ ] **Step 5 提交** `fix: single handling path for mouse side buttons in reader iframe`

### Task 10: 进度条 scrub 结束的合成 click 误隐藏页脚

**Files:**
- Modify: `apps/readest-app/src/app/reader/components/ProgressBar.tsx:242-324`
- Test: 组件测试（pointer 序列后 click 被抑制）

- [ ] **Step 1 写失败测试**：strip 上 pointerdown→move→up 后派发 click，`dismissed` 不翻转；纯 click（无拖动）正常翻转。
- [ ] **Step 2 确认失败**。
- [ ] **Step 3 实现**：照 `useDragScroll.ts:100-107` 的 `suppressClickRef` 模式：scrub 实际发生位移时置位，click 捕获阶段检测并吞掉，up 后下一 tick 复位。
- [ ] **Step 4 测试通过 + 手动冒烟**（滚动模式/分页模式/竖排三态）。
- [ ] **Step 5 提交** `fix: suppress synthetic click after progress bar scrub`

### Task 11: （已取消 — D2 决策：不做移动端修复）

原"目录/批注跳转后自动收起侧栏"仅服务移动布局场景，按用户决策取消。如未来恢复移动端支持再重开。

### Task 12: 清空搜索词后残留"未找到结果"

**Files:**
- Modify: `apps/readest-app/src/app/reader/components/sidebar/SearchBar.tsx:96, 346`
- Modify: `apps/readest-app/src/app/reader/components/sidebar/SearchResults.tsx:280-281`（防御）
- Test: 组件测试

- [ ] **Step 1 写失败测试**：完成一次搜索后点击清除按钮 → SearchResults 不再渲染（或渲染空态而非"No results found"）。
- [ ] **Step 2 确认失败**。
- [ ] **Step 3 实现**：`resetSearch` 同时重置 `searchProgress=0`、`searchStatus`（store 对应 setter）；`SearchResults` 增加 `results.length===0 && !searchQuery` 早退 null 的防御分支。
- [ ] **Step 4 测试通过**。
- [ ] **Step 5 提交** `fix: clear stale search progress and results panel on reset`

### Task 13: 书库拖拽导入反馈三件（空书库无指示 / 指示闪烁 / 部分不支持静默丢弃）

**Files:**
- Modify: `apps/readest-app/src/app/library/page.tsx:2022-2026`（hero 分支补 `drag-over`）
- Modify: `apps/readest-app/src/app/library/hooks/useDragDropImport.ts:43-58, 77-122`
- Modify: `apps/readest-app/src/styles/globals.css`（如需）
- Test: hook 测试（dragenter/leave 计数、部分不支持 toast）

**Interfaces:**
- Produces: `useDragDropImport` 内部维护 `dragEnterCount`；对不支持文件返回 `{ skipped: string[] }` 供 toast。

- [ ] **Step 1 写失败测试**：①空书库分支渲染含 `drag-over` 条件类；②dragenter(2 次)→dragleave(1 次) → `isDragging` 仍 true，dragleave 至 0 才 false；③混合文件（1 支持 1 不支持）→ toast 提到 1 个未支持文件。
- [ ] **Step 2 确认失败**。
- [ ] **Step 3 实现**：hero 分支 `className={isDragging ? 'hero drop-zone drag-over ...' : ...}`；enter/leave 计数器（dragenter++、dragleave--，<=0 复位）；`handleDroppedFiles` 对被过滤文件计数并在有新增导入时附加 info 级提示。
- [ ] **Step 4 顺手修本文件已知缺陷**：Tauri 分支 cleanup 补 DOM `removeEventListener`（原 effect 依赖 `[group]` 反复叠加泄漏，见审查#4）。
- [ ] **Step 5 测试通过 + 全量**。
- [ ] **Step 6 提交** `fix: drag import feedback, flicker guard and dom listener leak`

### Task 14: 手动导入并发守卫 + 文件选择器错误提示

**Files:**
- Modify: `apps/readest-app/src/app/library/page.tsx:332-354, 955-969, 1370-1376`
- Test: hook/页面测试

- [ ] **Step 1 写失败测试**：`importBooks` 在 `loading=true` 时直接返回且不再进入 `runImportBooks`；`selectFiles` 返回 error 时出现 toast。
- [ ] **Step 2 确认失败**。
- [ ] **Step 3 实现**：`importBooks` 开头 `if (loading) return { skipped: ... }`（对齐 useAutoImportFolders 的守卫模式）；error 分支 `showToast(_('Failed to open file selector'))`（i18n）。
- [ ] **Step 4 测试通过**。
- [ ] **Step 5 提交** `fix: guard concurrent manual imports and surface selector errors`

### Task 15: TTS mini player 交互三件

**Files:**
- Modify: `apps/readest-app/src/app/reader/components/tts/TTSMiniPlayer.tsx:142-157`（offset 重测）
- Modify: `apps/readest-app/src/app/reader/components/tts/TTSControl.tsx:59`（expand 反馈）
- Test: 组件测试

- [ ] **Step 1 写失败测试**：①面板元素尺寸变化触发 `panelTopOffset` 重算（ResizeObserver mock）；②`ttsClientsInited=false` 时点击封面区出现禁用态样式/提示而非无响应。
- [ ] **Step 2 确认失败**。
- [ ] **Step 3 实现**：useLayoutEffect 内对面板 cell 挂 `ResizeObserver`（cleanup 断开），依赖不变；expand 手势未就绪时给卡片加 `aria-disabled` + 视觉减淡，或显示"准备中"微标（取改动小者）。
- [ ] **Step 4 测试通过 + 手动冒烟**。
- [ ] **Step 5 提交** `fix: tts mini player offset remeasure and expand affordance`

### Task 16: 搜索/批注导航索引竞态

**Files:**
- Modify: `apps/readest-app/src/app/reader/hooks/useSearchNav.ts:58`
- Modify: `apps/readest-app/src/app/reader/hooks/useBooknotesNav.ts:76`
- Test: hook 测试

**Interfaces:**
- Produces: 回写索引的 effect 从 useMemo 移到独立 `useEffect`，依赖仅"当前页首命中项的绝对索引"变更；且用户手动导航后 N 秒内（或同页）不覆盖。

- [ ] **Step 1 写失败测试**：翻页后索引被设为当页首项；紧接手动 `navigateToResult(next)` 后索引保持用户值不被立即覆盖。
- [ ] **Step 2 确认失败**。
- [ ] **Step 3 实现**：`useEffect(() => { if (firstIndex !== -1 && !userNavigatedRecently) setSearchResultIndex(...) }, [firstIndex])`；`userNavigatedRecently` 用时间戳 ref（用户导航时刷新，500ms 窗口）。
- [ ] **Step 4 测试通过**。
- [ ] **Step 5 提交** `fix: avoid racing user search result navigation on page turn`

---

## 批次三：一致性与卫生（P2，可拆小提交）

### Task 17: settings 同引用突变改不可变更新

**Files:**
- Modify: `apps/readest-app/src/components/settings/theme/ThemePanel.tsx:355-359, 301`
- Modify: `apps/readest-app/src/components/settings/TTSPanel.tsx:101-105`
- Modify: `apps/readest-app/src/components/settings/MiscPanel.tsx:174-176`
- Modify: `apps/readest-app/src/helpers/settings.ts:114-118`
- Test: settingsStore 订阅测试

- [ ] **Step 1 写失败测试**：浅拷贝后 `setSettings` 时 selector 订阅者收到新引用（对 `s => s.settings`）。
- [ ] **Step 2 确认失败**。
- [ ] **Step 3 实现**：四处统一 `{ ...settings, globalReadSettings: { ...settings.globalReadSettings, xxx } }` 模式；`saveSysSettings` 内部同样复制后再 set。
- [ ] **Step 4 测试通过 + 全量**（主题/TTS 面板手动冒烟）。
- [ ] **Step 5 提交** `fix: immutable settings updates for highlight colors, tts and stylesheet`

### Task 18: 设置面板控件三修（ColorInput / NumberInput / FontDropDown）

**Files:**
- Modify: `apps/readest-app/src/components/settings/theme/ColorInput.tsx:36-78`
- Modify: `apps/readest-app/src/components/settings/NumberInput.tsx:56,60`
- Modify: `apps/readest-app/src/components/settings/FontDropDown.tsx:44-133`
- Test: 各组件测试

- [ ] **Step 1 写失败测试**：①ColorInput 开着时点击色块自身 → 关闭；②NumberInput 清空失焦 → 恢复原值（不钳到 min）；③FontDropDown 选中项后菜单关闭、Esc 可关。
- [ ] **Step 2 确认失败**。
- [ ] **Step 3 实现**：①click 处理改在 mousedown 同源判断（`isOpen` 时点色块即关）或对 picker 内 click stopPropagation；②空值分支 `displayValue.trim()===''` 时 commit 上一个有效值；③FontItem onClick 后 `e.currentTarget.blur()` 或改受控 `open` 状态 + Esc 监听（受控方案与 AdwaitaSelect 对齐，优先）。
- [ ] **Step 4 测试通过**。
- [ ] **Step 5 提交** `fix: color input toggle, empty number input and font dropdown close behavior`

### Task 19: 破坏性操作与子页面行为对齐

**Files:**
- Modify: `apps/readest-app/src/components/settings/DialogMenu.tsx:52-60`（清除字体加确认）
- Modify: `apps/readest-app/src/components/settings/ControlPanel.tsx:76,393-400`（子页拦截 Back/Esc，参照 FontPanel.tsx:184 模式）
- Modify: `apps/readest-app/src/app/library/components/GroupingModal.tsx:121-217`（不可变更新 + await save + 失败 toast）
- Test: 就近组件测试

- [ ] **Step 1 写失败测试**：①清除字体出现 DeleteConfirmAlert；②工具栏自定义子页按 Esc 返回 ControlPanel 而非关整个对话框；③移出分组后 book 为新对象引用且 save 失败时 toast。
- [ ] **Step 2 确认失败 → 实现 → 通过**。
- [ ] **Step 3 提交** `fix: confirm font wipe, esc handling in toolbar customizer, immutable grouping`

### Task 20: Toast 状态机三修

**Files:**
- Modify: `apps/readest-app/src/components/Toast.tsx:70-100`
- Test: 组件测试

- [ ] **Step 1 写失败测试**：①2s toast 后跟默认 toast → 后者 5s；②相同文案连续两条 → 第二条计时重置（内部用自增 id 作 effect 依赖）；③手动关闭后 callback 不再触发。
- [ ] **Step 2 确认失败 → 实现（toast 对象加递增 id，effect 依赖 id；callback 与 dismiss 共用同一定时器）→ 通过**。
- [ ] **Step 3 提交** `fix: toast timeout isolation, duplicate messages and callback lifecycle`

### Task 21: hooks 卫生（useDrag / usePullToRefresh / useLongPress / ReaderContent）

**Files:**
- Modify: `apps/readest-app/src/hooks/useDrag.ts:25-94`（start 时重置 lastX/lastY；shield/cursor unmount 清理）
- Modify: `apps/readest-app/src/hooks/usePullToRefresh.ts:202-258`（取消时置 aborted 标志，finally 与 trigger 前检查；unmount 全量清理）
- Modify: `apps/readest-app/src/hooks/useLongPress.ts:160-167`（pressDelayRef/pointerEventTimeoutRef 清理）
- Modify: `apps/readest-app/src/app/reader/components/ReaderContent.tsx:313`（setTimeout 移入 useEffect）
- Test: 各 hook 测试

- [ ] **Step 1 写失败测试**：①第二次拖拽首帧 delta 相对本次 start（不为上次残留）；②取消上拉后 `onRefresh` 未被调用；③卸载后无残留定时器触发 setState。
- [ ] **Step 2 确认失败 → 逐项实现 → 通过 → 全量**。
- [ ] **Step 3 提交** `fix: hook cleanup hygiene in drag, pull-to-refresh and long-press`

### Task 22: UI 一致性小件打包

**Files（每件一个 commit 或合并为一个，视 diff 大小）:**
- `HeaderBar.tsx:233-237`：侧栏开关按钮常驻渲染（关闭时也显示，图标态区分）
- `NotebookToggler.tsx:31-35`：打开态换 filled 图标（对齐 SidebarToggler）
- `usePagination.ts:243,248` 与各处 `setHoveredBookKey('')` 统一置空值（`null`/`''` 混用是维护隐患，统一为 `''`；`FooterBar.tsx:106,110,116`、`HeaderBar.tsx:96,220` 已是 `''`）
- `useMouseNavigation.ts:16-18`：删除失实的注释（或实现恢复搜索栏，默认只删注释）
- `importToast.ts:21-29`：部分重复改 info 级文案（保留 success 仅纯新增）
- `command-palette/CommandPalette.tsx:37-40`：依赖加结果标识序列而非仅 length
- a11y 两处：`TTSHighlightStyleEditor.tsx:128-134`、`HighlightColorsEditor.tsx:257-263` 删除按钮改 `focus-visible` 可见 + `aria-label`
- `ProofreadPopup.tsx:96-103`：插入 DOM 的替换文本与规则持久化统一 `trim()` 后使用
- （移动端相关项——拖拽把手 a11y、hover 触发守卫、重复点当前 tab 收侧栏——已按 D2 决策移除）
- Test: 对应组件测试（有则补，无则以全量回归兜底）

- [ ] **Step 1 逐件小改 + 对应测试**
- [ ] **Step 2 全量回归 + `pnpm fmt:check`**
- [ ] **Step 3 提交**（建议拆 2-3 个 commit：`fix: reader header/footbar toggler consistency`、`fix: command palette selection reset on reorder`、`fix: keyboard-visible delete buttons and hover guards`）

### Task 23（已批准，D1 决策：收敛）: Backspace 拦截收敛到 MessageEvent

**Files:**
- Modify: `apps/readest-app/src/hooks/useShortcuts.ts:22-23`
- 实现要点：`processKeyEvent` 中的 Backspace 短路仅对 MessageEvent 分支生效（或把判断移入 `unifiedHandleKeyDown` 的 MessageEvent 分支），原生 KeyboardEvent 的 Backspace 恢复进入快捷键匹配循环；快捷键设置 UI（KeyboardShortcutsHelp）无需改动。
- 注意：原生 Backspace 绑定快捷键后，在非输入焦点处按 Backspace 会触发该动作并 preventDefault；输入焦点守卫（60-67 行）保证打字删字不受影响。验证绑定流程：设置里录一个 Backspace 快捷键 → 触发动作；再验证 iframe 内 Backspace 仍被短路。
- 提交 `fix: scope backspace interception to iframe message events`

---

## 执行顺序与提交边界

1. 批次一 T1→T7 按序执行（T4/T5 可并行；T2 与 T8 有共享文件 useKeyDownActions/Dialog 的部分已归入 T2，T8 只动消费点，无冲突）。
2. 批次二 T9→T16 按序；T13/T14 同文件（page.tsx / useDragDropImport.ts），串行执行避免冲突。
3. 批次三按 Task 独立提交，随时可暂停。
4. 每任务完成即提交；批次结束跑全量 `pnpm --filter readest-local test -- --run` + `pnpm fmt:check`。

## 完成定义

- 所有任务勾选完毕（T11 已按 D2 决策取消）。
- 全量测试通过、biome 无 diff。
- TTS/iframe/书库拖拽三类高风险改动有手动冒烟记录（追加到 docs/reports/ 对应报告或本文件末尾）。
- 新增文案已进 i18n。
