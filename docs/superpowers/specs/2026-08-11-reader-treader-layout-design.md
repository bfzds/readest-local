# Readest 阅读页对齐 tReader 布局设计

日期：2026-08-11
范围：`apps/readest-app` 阅读页（React 19 / Next.js / Tailwind / Zustand）

## 目标

在不移除现有功能（TTS、笔记、设置、侧栏搜索、标注等）的前提下，把阅读页的视觉结构、间距体系、字体层级、目录入口和进度展示方式对齐 [tiansh/reader](https://github.com/tiansh/reader)（tReader）的阅读体验：

- 正文区域更贴近“文字铺满、四周留白”的 tReader 观感。
- 默认字号、行高、段距采用 tReader 的常用值。
- 目录入口统一到右下角悬浮按钮，TOC 列表内常驻“上一章/下一章”。
- 底部进度区以“章节名 + 百分比”为核心信息。

## 非目标

- 不改动翻页/滚动的内核（`foliate-js`、`usePagination`、手势处理）。
- 不重构 HeaderBar / FooterBar 为 tReader 式合并工具栏。
- 不新增布局开关或第二套 UI。
- 不动书库页、设置页、Notebook、TTS、标注等模块。

## 设计决策

### 1. 间距体系（默认值）

修改 `apps/readest-app/src/services/constants.ts` 中的 `DEFAULT_BOOK_LAYOUT`：

| 字段 | 当前 | 改为 | 说明 |
| --- | --- | --- | --- |
| `marginTopPx` | 44 | 20 | 对应 tReader 顶部留白（15~20px） |
| `marginBottomPx` | 44 | 20 | 对应 tReader 底部留白 |
| `marginLeftPx` | 16 | 20 | 宽屏左右留白更接近 tReader 的 3vw |
| `marginRightPx` | 16 | 20 | 同上 |
| `compactMargin*Px` | 16 | 保持不变 | 紧凑模式已符合 tReader 窄屏观感 |

HeaderBar 的悬停触发区由 `marginTopPx` 驱动（`getHeaderTriggerHeight`），自动变薄；移动端点击翻页唤出工具栏的逻辑不受影响。

### 2. 字体层级（默认值）

修改 `DEFAULT_BOOK_FONT` 与 `DEFAULT_BOOK_STYLE`：

| 字段 | 当前 | 改为 | 说明 |
| --- | --- | --- | --- |
| `defaultFontSize` | 16 | 18 | tReader 默认 18px |
| `lineHeight` | 1.4 | 1.3 | tReader 默认 1.3 |
| `paragraphMargin` | 0.6 | 0.5 | tReader 默认段距 0.5em |

`DEFAULT_CJK_VIEW_SETTINGS.lineHeight`（1.6）保持不变，保留中文长文的舒适行距。移动端现有 `fontScale = 1.25` 行为不变。

### 3. 滚动模式最大宽度

修改 `apps/readest-app/src/utils/config.ts` 的 `getDefaultMaxInlineSize` 返回 720 -> 800，与 tReader 滚动模式居中最大宽度一致。

### 4. 目录入口

- 新增 `apps/readest-app/src/app/reader/components/TOCFloatingButton.tsx`：右下角悬浮“目录”按钮。点击时设置 `sideBarBookKey`、`sideBarTab: 'toc'` 并打开侧栏。侧栏已打开且指向当前书时隐藏按钮。
- 定位避开 FooterBar：桌面 `bottom: 64px`、移动端 `bottom: 96px`（FooterBar 52px / 64px + 安全区）。
- 在 `BooksGrid` 的 `BookCellInner` 中渲染。
- 移除 `apps/readest-app/src/app/reader/components/footerbar/NavigationBar.tsx` 的 TOC 按钮，避免移动端两个目录入口重复；保留 HeaderBar 的 `SidebarToggler` 作为通用侧栏开关（仍可访问注释/书签标签页）。

### 5. TOC 常驻章节切换

新增 `apps/readest-app/src/app/reader/components/sidebar/TOCChapterNav.tsx`，渲染在 `SidebarContent` 的 TOC 内容区底部（`OverlayScrollbarsComponent` 之后、`TabNavigation` 之前）：

- 左侧“上一章”、右侧“下一章”，中间显示当前章节名。
- 使用现有 `viewPagination(view, viewSettings, 'up' | 'down', 'section')`。
- 当前为第一章时禁用“上一章”，最后一章时禁用“下一章”。
- 不跟随 `showPrevPageButton / showNextPageButton` 开关。

### 6. 进度展示

修改 `apps/readest-app/src/app/reader/components/ProgressBar.tsx`：

- 在底部进度区左侧显示当前章节名（`progress.sectionLabel`），右侧保留百分比/页数等现有进度文本。
- 章节名过长时截断；垂直阅读模式下不显示该行（保持现有侧栏进度样式）。
- 顶部 `SectionInfo`、`StickyProgressBar`（默认关闭）保持不变。

## 文件改动清单

新增：

- `src/app/reader/components/TOCFloatingButton.tsx`
- `src/app/reader/components/sidebar/TOCChapterNav.tsx`
- `src/__tests__/components/TOCFloatingButton.test.tsx`
- `src/__tests__/components/sidebar/TOCChapterNav.test.tsx`

修改：

- `src/services/constants.ts`（默认间距/字号/行高/段距）
- `src/utils/config.ts`（默认最大行宽 800）
- `src/app/reader/components/BooksGrid.tsx`（挂载 TOCFloatingButton）
- `src/app/reader/components/sidebar/Content.tsx`（挂载 TOCChapterNav）
- `src/app/reader/components/footerbar/NavigationBar.tsx`（移除 TOC 按钮）
- `src/app/reader/components/ProgressBar.tsx`（章节名 + 百分比）
- `src/__tests__/services/constants.test.ts`（更新默认值断言）

## 验证

- 新增组件测试：TOC 按钮打开侧栏并切到 TOC；章节导航在第一章禁用“上一章”、点击“下一章”调用渲染器。
- 更新 `constants.test.ts` 的默认值断言。
- 运行 `pnpm --filter readest-local test` 与 `pnpm --filter readest-local lint`。
- 手动（用户侧）检查：打开一本书，确认右下角目录按钮、TOC 内章节切换、默认边距/字号/行高、底部章节名+百分比。

## 风险

- 默认值变化会让已有用户设置表现不同，但用户覆盖值优先，影响仅限未自定义的用户。
- 移除移动端 TOC 按钮后，移动端目录入口只剩右下角悬浮按钮；若用户不习惯，可在后续设置中加回。
- 右下角按钮可能与底部 TTS/RSVP 控件重叠，定位预留 96px 安全距离，实现时用现有 `gridInsets` 兜底。
