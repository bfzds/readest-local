# 交接文档：进度条整理 + 书库拖拽入分组（2026-08-29）

> 分支 `readest-local`。项目：Readest 桌面版（Tauri 便携版为主，`pnpm dev` 在 WebView2 里跑同一套 React）。
> 本批改动**均未提交**（攒着，等拖拽收尾后一起提交或按需拆分）。

## 一、已完成改动的两组工作

### A. 阅读页进度条 / 底部工具栏整理——已完成，测试通过

用户原需求是"一个能显示进度、可转跳、可关闭的进度条"，演进后定稿：

1. **移除粘性进度条（StickyProgressBar）**：删除组件 `StickyProgressBar.tsx` + 设置字段 `showStickyProgressBar`（types/constants/LayoutPanel/footerBand/FoliateViewer 全清）。
2. **删除桌面端底部 hover 工具栏**：`DesktopFooterBar.tsx` 删除；`FooterBar.tsx` 桌面（宽屏）短路只渲染 TTS/RSVP 浮层，移动/窄窗保留 `MobileFooterBar`。
3. **朗读改浮动按钮**：新增 `FloatingSpeakButton.tsx`，右下角"搜索按钮上方"；`TTSMiniPlayer` 的 `barVisible` 仅移动布局生效（桌面不再悬高）。
4. **右缘浮动按钮图标统一为 Remix（Ri）线框 + 等距排布**：Search/TOC/Speak/Library 均 `Ri*Line`，间距统一 64px（16px 空隙）。
5. 清理：`showToolbarProgressBar` 开关随工具栏删除一并撤销；`PageJumpInput` 保留（移动端 NavigationPanel 用）。

测试：`pnpm test` 全绿（5665+）、`pnpm lint` 过。形成历史任务的 #2/#3/#4。

### B. 书库拖拽入分组（需求1）——实现中，**有阻塞未完成**

- 纯函数 `reassignToGroup`（`libraryUtils.ts`）：书→组、整组→组（嵌套前缀改写）、循环守卫。**单测通过**（`reassign-to-group.test.ts`，7 例）。
- 拖拽源：`BookshelfItem` 根 div `draggable`（非选择模式），`dragstart` 写自定义 MIME（`application/x-readest-book`/`-group`），拖起时给源格子加 `.dragging-in-progress` 淡化（`globals.css`）——**"拖动动画"已验证生效**。
- 拖放目标：`Bookshelf` 用**原生捕获监听**处理 dragover/drop（见下"阻塞点"），目标分组格子 `.drag-over-group` 高亮（CSS 已有）。

## 二、当前阻塞点：书库拖拽"拖得起、放不进"

### 现象
- `pnpm dev`（Tauri WebView2）下：按住书能拖、源格子会变淡（动画 OK），拖到分组格子上**不出现描边，松开不归组**。
- Console：`dragstart` 有（早期用 React 合成事件时验证过；当前那是旧日志，现日志已删）；**`dragover`/`drop` 一次都没打印过**（旧日志被页面级监听吞掉）。

### 已验证事实
1. 源元素 `dragstart` 能触发（不是"拖不起来"）。
2. 页面级 `useDragDropImport`（`src/app/library/hooks/useDragDropImport.ts`）在 `.library-page` 上挂原生 bubble 监听，`dragover`/`drop` 一律 `preventDefault()+stopPropagation()` —— **把事件在冒泡到 React 委托点之前吞掉**，导致 React 合成 `onDragOver/onDrop`（osRoot 上）永远收不到。
3. 已尝试：React `onDragOverCapture` → 仍无效；改用**原生捕获监听**（`Bookshelf.tsx` 里 `useEffect` 挂 osRootRef，`el.addEventListener('dragover', ..., true)` 捕获阶段）→ **用户重测仍未归组**（捕获监听也疑似未收到，或 types 判空）。

### 推断（下一步需实测确认）
- 可能 1：WebView2 对"虚拟滚动容器（Virtuoso）+ OverlayScrollbars"内的 HTML5 DnD 事件派发本身不稳，捕获监听也未触发。
- 可能 2：监听触发了，但 `dataTransfer.types` 不包含自定义 MIME → 代码放行（不 preventDefault → 浏览器认为不可放置）。
- 可能 3：`groupBy !== Group` 的视图 gate 拦截（当前视图并非"按分组"）。

### 复现与定位步骤
1. `cd apps/readest-app && pnpm dev`，打开书库。
2. F12 → Console。
3. 在 Bookshelf 的原生监听（`onDragOver`/`onDrop` 开头）临时加 `console.log('native dragover', Array.from(e.dataTransfer?.types ?? []))`。
4. 拖一本书到分组格子松开，看：
   - **什么都没打印** → 原生捕获监听也没收到事件 → 走"指针自研"路（见下 A）。
   - **打印了、types 为空或非自定义** → 判定放行问题 → 检查 WebView2 dataTransfer，或改用 Pointer 自研。
   - **打印了且有自定义 MIME** → 检查 `groupBy` gate / `closest('[data-group-name]')` 命中。

### 两条候选路线
- **A. 自研拖拽（推荐，根治）**：放弃 HTML5 DnD，用 Pointer Events（pointerdown/move/up）自绘：拖影跟随鼠标、目标高亮、落点由 `document.elementFromPoint + closest` 判定。完全绕开 dragover/drop 传播问题；且能做出更明确的拖拽反馈（用户在意"拖动要有动画"）。工作量大但一次到位。
  - 注意与 `useLongPress`（长按选中）共存：拖动方向判定（位移 > 阈值即进入拖拽，优先于长按）。
  - 被拖对象状态可先放组件层 React state（或复用现有 class 方案）。
- **B. 加日志精确定位后再小修**：若定位到是"types 没带上"等小问题，可在原生监听里强制判定（例如不依赖自定义 MIME，改判断 `e.dataTransfer` 带文本/book hash 特征），改动小。

## 三、相关文件清单

| 文件 | 备注 |
|---|---|
| `src/app/library/utils/libraryUtils.ts` | `reassignToGroup`（已完成、已测） |
| `src/app/library/components/Bookshelf.tsx` | 原生捕获监听 dragover/drop（当前重点，可能未生效） |
| `src/app/library/components/BookshelfItem.tsx` | 拖拽源 `draggable` + dragstart/dragend + 源淡化 |
| `src/styles/globals.css` | `.drag-over-group` 目标高亮 / `.dragging-in-progress` 源淡化 |
| `src/app/library/hooks/useDragDropImport.ts` | 页面级文件导入监听，疑与 HTML5 DnD 传播冲突 |
| `src/__tests__/app/library/reassign-to-group.test.ts` | 纯函数单测（通过） |
| （需求A遗留）`FloatingSpeakButton.tsx`、`FooterBar.tsx`、`ProgressBar.tsx`、`TTSMiniPlayer.tsx`、i18n、相关测试 | 已完成，未提交 |

## 四、环境与约定

- 主要验证：`pnpm dev`（Tauri WebView2），开 Console 看拖拽事件。
- 校验：`cd apps/readest-app && pnpm test`（当前 5672 通过）、`pnpm lint`（仅 1 个既有无关 warning）。
- 用户偏好：桌面端优先；中文沟通；未提交状态待用户决定是否/如何提交。