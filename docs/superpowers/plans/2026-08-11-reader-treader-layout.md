# Readest 阅读页对齐 tReader 布局实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留现有功能的前提下，把 Readest 阅读页的默认间距、字号行高、目录入口和进度展示对齐 tReader 布局。

**Architecture:** 只调整默认配置和 4 个展示组件：默认值走 `constants.ts` / `config.ts`；目录入口新增右下角悬浮按钮并移除移动端底部重复入口；TOC 内容区底部新增常驻章节切换条；底部进度区增加章节名展示。翻页/滚动内核、HeaderBar/FooterBar 结构、侧栏和现有功能均不动。

**Tech Stack:** React 19、Next.js、TypeScript、Tailwind CSS、Zustand、Vitest、Testing Library。

## Global Constraints

- 保留现有全部功能：TTS、笔记、设置、侧栏搜索、标注等一律不删。
- 保留 HeaderBar 的 `SidebarToggler`（通用侧栏开关），只移除移动端 `NavigationBar` 的 TOC 按钮。
- 不修改 `showNotebookButton / showBookmarkButton / showPrevPageButton / showNextPageButton` 等既有开关默认值。
- 不修改 `usePagination`、`foliate-js`、手势处理等翻页/滚动内核。
- 默认值只在用户未自定义时生效（用户覆盖值优先）。
- 每步提交只包含本任务文件，不提交工作区其他未关联改动。

---

## File Structure

- Modify: `apps/readest-app/src/services/constants.ts`（默认间距/字号/行高/段距）
- Modify: `apps/readest-app/src/utils/config.ts`（默认滚动最大宽度）
- Modify: `apps/readest-app/src/__tests__/services/constants.test.ts`（默认值断言 + mock 更新）
- Create: `apps/readest-app/src/app/reader/components/TOCFloatingButton.tsx`
- Test: `apps/readest-app/src/__tests__/components/TOCFloatingButton.test.tsx`
- Modify: `apps/readest-app/src/app/reader/components/BooksGrid.tsx`（挂载 TOCFloatingButton）
- Modify: `apps/readest-app/src/app/reader/components/footerbar/NavigationBar.tsx`（移除 TOC 按钮）
- Create: `apps/readest-app/src/app/reader/components/sidebar/TOCChapterNav.tsx`
- Test: `apps/readest-app/src/__tests__/components/sidebar/TOCChapterNav.test.tsx`
- Modify: `apps/readest-app/src/app/reader/components/sidebar/Content.tsx`（挂载 TOCChapterNav）
- Modify: `apps/readest-app/src/app/reader/components/ProgressBar.tsx`（底部章节名）
- Test: `apps/readest-app/src/__tests__/components/ProgressBar.test.tsx`

---

### Task 1: 默认布局与字体值对齐 tReader

**Files:**
- Modify: `apps/readest-app/src/services/constants.ts:307-310,321,335,346`
- Modify: `apps/readest-app/src/utils/config.ts:18-24`
- Modify: `apps/readest-app/src/__tests__/services/constants.test.ts:4-6,441-443,386-397,478-482`

**Interfaces:**
- Consumes: 现有 `DEFAULT_BOOK_LAYOUT`、`DEFAULT_BOOK_FONT`、`DEFAULT_BOOK_STYLE`、`getDefaultMaxInlineSize`。
- Produces: 新默认值 `marginTopPx/marginBottomPx/marginLeftPx/marginRightPx = 20`、`defaultFontSize = 18`、`lineHeight = 1.3`、`paragraphMargin = 0.5`、`maxInlineSize = 800`。

- [ ] **Step 1: 更新测试断言与 mock**

在 `apps/readest-app/src/__tests__/services/constants.test.ts` 中：

```ts
vi.mock('@/utils/config', () => ({
  getDefaultMaxBlockSize: vi.fn(() => 1600),
  getDefaultMaxInlineSize: vi.fn(() => 800),
}));
```

在 `describe('DEFAULT_BOOK_LAYOUT')` 中新增：

```ts
it('uses tReader-style 20px page margins by default', () => {
  expect(DEFAULT_BOOK_LAYOUT.marginTopPx).toBe(20);
  expect(DEFAULT_BOOK_LAYOUT.marginBottomPx).toBe(20);
  expect(DEFAULT_BOOK_LAYOUT.marginLeftPx).toBe(20);
  expect(DEFAULT_BOOK_LAYOUT.marginRightPx).toBe(20);
  expect(DEFAULT_BOOK_LAYOUT.compactMarginTopPx).toBe(16);
  expect(DEFAULT_BOOK_LAYOUT.compactMarginBottomPx).toBe(16);
});
```

在 `describe('DEFAULT_BOOK_FONT')` 中新增：

```ts
it('uses tReader-style 18px default font size', () => {
  expect(DEFAULT_BOOK_FONT.defaultFontSize).toBe(18);
});
```

在 `describe('DEFAULT_BOOK_STYLE')` 中新增：

```ts
it('uses tReader-style line height and paragraph margin', () => {
  expect(DEFAULT_BOOK_STYLE.lineHeight).toBe(1.3);
  expect(DEFAULT_BOOK_STYLE.paragraphMargin).toBe(0.5);
});
```

把已有 `has maxInlineSize and maxBlockSize from mocked config` 断言中的 `720` 改为 `800`。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter readest-local exec vitest run src/__tests__/services/constants.test.ts`
Expected: FAIL（新断言期望 20/18/1.3/0.5/800，实际是 44/16/1.4/0.6/720）

- [ ] **Step 3: 修改默认值**

在 `apps/readest-app/src/services/constants.ts`：

```ts
export const DEFAULT_BOOK_LAYOUT: BookLayout = {
  marginTopPx: 20,
  marginBottomPx: 20,
  marginLeftPx: 20,
  marginRightPx: 20,
  compactMarginTopPx: 16,
  compactMarginBottomPx: 16,
  compactMarginLeftPx: 16,
  compactMarginRightPx: 16,
```

```ts
export const DEFAULT_BOOK_FONT: BookFont = {
  // 其他字段不变
  defaultFontSize: 18,
```

```ts
export const DEFAULT_BOOK_STYLE: BookStyle = {
  // 其他字段不变
  paragraphMargin: 0.5,
  lineHeight: 1.3,
```

在 `apps/readest-app/src/utils/config.ts`：

```ts
export const getDefaultMaxInlineSize = () => {
  if (typeof window === 'undefined') return 800;

  const screenWidth = window.innerWidth;
  const screenHeight = window.innerHeight;
  return screenWidth < screenHeight ? Math.max(screenWidth, 800) : 800;
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter readest-local exec vitest run src/__tests__/services/constants.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/readest-app/src/services/constants.ts apps/readest-app/src/utils/config.ts apps/readest-app/src/__tests__/services/constants.test.ts
git commit -m "feat(reader): align default layout and typography with tReader"
```

---

### Task 2: 右下角目录悬浮按钮

**Files:**
- Create: `apps/readest-app/src/app/reader/components/TOCFloatingButton.tsx`
- Test: `apps/readest-app/src/__tests__/components/TOCFloatingButton.test.tsx`
- Modify: `apps/readest-app/src/app/reader/components/BooksGrid.tsx:159-160,258-259`
- Modify: `apps/readest-app/src/app/reader/components/footerbar/NavigationBar.tsx:1-5,33-42,58-62`

**Interfaces:**
- Consumes: `bookKey: string`；`useSidebarStore` 的 `sideBarBookKey/isSideBarVisible/setSideBarBookKey/setSideBarVisible`；`useBookDataStore` 的 `getConfig/setConfig`；`useReaderStore` 的 `setHoveredBookKey`。
- Produces: `TOCFloatingButton` 组件，点击后打开侧栏并切到 TOC；同书侧栏打开时返回 `null`。

- [ ] **Step 1: 编写失败测试**

创建 `apps/readest-app/src/__tests__/components/TOCFloatingButton.test.tsx`：

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

const sidebar = {
  sideBarBookKey: '',
  isSideBarVisible: false,
  setSideBarBookKey: vi.fn(),
  setSideBarVisible: vi.fn(),
};

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));
vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: () => sidebar,
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({ setHoveredBookKey: vi.fn() }),
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getConfig: () => ({ viewSettings: { sideBarTab: 'toc' } }),
    setConfig: vi.fn(),
  }),
}));

import TOCFloatingButton from '@/app/reader/components/TOCFloatingButton';

afterEach(() => cleanup());

describe('TOCFloatingButton', () => {
  it('opens the sidebar with the TOC tab', () => {
    render(<TOCFloatingButton bookKey='book-1' />);
    fireEvent.click(screen.getByLabelText('Table of Contents'));
    expect(sidebar.setSideBarBookKey).toHaveBeenCalledWith('book-1');
    expect(sidebar.setSideBarVisible).toHaveBeenCalledWith(true);
  });

  it('is hidden while the sidebar is open for the same book', () => {
    sidebar.sideBarBookKey = 'book-1';
    sidebar.isSideBarVisible = true;
    render(<TOCFloatingButton bookKey='book-1' />);
    expect(screen.queryByLabelText('Table of Contents')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter readest-local exec vitest run src/__tests__/components/TOCFloatingButton.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现组件**

创建 `apps/readest-app/src/app/reader/components/TOCFloatingButton.tsx`：

```tsx
import React, { useCallback } from 'react';
import { IoIosList } from 'react-icons/io';
import { useReaderStore } from '@/store/readerStore';
import { useSidebarStore } from '@/store/sidebarStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useTranslation } from '@/hooks/useTranslation';

const TOCFloatingButton: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const { sideBarBookKey, isSideBarVisible, setSideBarBookKey, setSideBarVisible } =
    useSidebarStore();
  const { getConfig, setConfig } = useBookDataStore();
  const { setHoveredBookKey } = useReaderStore();

  const handleOpenTOC = useCallback(() => {
    setHoveredBookKey(bookKey);
    const config = getConfig(bookKey);
    if (config?.viewSettings) {
      setConfig(bookKey, { viewSettings: { ...config.viewSettings, sideBarTab: 'toc' } });
    }
    setSideBarBookKey(bookKey);
    setSideBarVisible(true);
  }, [
    bookKey,
    getConfig,
    setConfig,
    setSideBarBookKey,
    setSideBarVisible,
    setHoveredBookKey,
  ]);

  if (sideBarBookKey === bookKey && isSideBarVisible) return null;

  return (
    <button
      type='button'
      aria-label={_('Table of Contents')}
      title={_('Table of Contents')}
      onClick={handleOpenTOC}
      className='absolute bottom-24 right-4 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-base-100/90 text-base-content shadow-lg backdrop-blur-sm transition-transform active:scale-95 sm:bottom-16'
    >
      <IoIosList size={24} />
    </button>
  );
};

export default TOCFloatingButton;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter readest-local exec vitest run src/__tests__/components/TOCFloatingButton.test.tsx`
Expected: PASS

- [ ] **Step 5: 挂载到 BooksGrid 并移除移动端重复入口**

在 `apps/readest-app/src/app/reader/components/BooksGrid.tsx` 顶部 import 区域加入：

```tsx
import TOCFloatingButton from './TOCFloatingButton';
```

在 `<PageNavigationButtons bookKey={bookKey} isDropdownOpen={isDropdownOpen} />` 之后加入：

```tsx
<TOCFloatingButton bookKey={bookKey} />
```

在 `apps/readest-app/src/app/reader/components/footerbar/NavigationBar.tsx` 中删除：

- `import { IoIosList as TOCIcon } from 'react-icons/io';`
- `import { useSidebarStore } from '@/store/sidebarStore';`
- `const { isSideBarVisible, isSideBarPinned } = useSidebarStore();`
- 渲染块：

```tsx
{isSideBarVisible && isSideBarPinned ? null : (
  <Button
    label={_('Table of Contents')}
    icon={<TOCIcon size={tocIconSize} />}
    onClick={() => onSetActionTab('toc')}
  />
)}
```

并删除现在未使用的 `tocIconSize` 变量。

- [ ] **Step 6: 类型检查**

Run: `pnpm --filter readest-local exec tsgo --noEmit`
Expected: PASS（若仓库脚本不可用，则运行 `pnpm --filter readest-local lint`）

- [ ] **Step 7: 提交**

```bash
git add apps/readest-app/src/app/reader/components/TOCFloatingButton.tsx apps/readest-app/src/__tests__/components/TOCFloatingButton.test.tsx apps/readest-app/src/app/reader/components/BooksGrid.tsx apps/readest-app/src/app/reader/components/footerbar/NavigationBar.tsx
git commit -m "feat(reader): add floating TOC button and dedupe mobile entry"
```

---

### Task 3: TOC 常驻章节切换条

**Files:**
- Create: `apps/readest-app/src/app/reader/components/sidebar/TOCChapterNav.tsx`
- Test: `apps/readest-app/src/__tests__/components/sidebar/TOCChapterNav.test.tsx`
- Modify: `apps/readest-app/src/app/reader/components/sidebar/Content.tsx:88-98`

**Interfaces:**
- Consumes: `bookKey: string`；`useReaderStore` 的 `getView/getViewSettings`；`useBookProgress(bookKey)` 的 `index/section.total/sectionLabel`；`useBookDataStore` 的 `getBookData().bookDoc.sections.length`；`viewPagination(view, viewSettings, side, mode)`。
- Produces: `TOCChapterNav` 组件；章节数 <= 0 时返回 `null`。

- [ ] **Step 1: 编写失败测试**

创建 `apps/readest-app/src/__tests__/components/sidebar/TOCChapterNav.test.tsx`：

```tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

const view = { renderer: { prevSection: vi.fn(), nextSection: vi.fn() } };
const viewSettings = {};
const viewPagination = vi.fn();

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getView: () => view,
    getViewSettings: () => viewSettings,
  }),
}));
vi.mock('@/store/readerProgressStore', () => ({
  useBookProgress: () => ({
    index: 0,
    section: { total: 3 },
    sectionLabel: 'Chapter 1',
  }),
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getBookData: () => ({ bookDoc: { sections: [{}, {}, {}] } }),
  }),
}));
vi.mock('@/app/reader/hooks/usePagination', () => ({ viewPagination }));

import TOCChapterNav from '@/app/reader/components/sidebar/TOCChapterNav';

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
});

describe('TOCChapterNav', () => {
  it('disables Previous Chapter on the first chapter', () => {
    render(<TOCChapterNav bookKey='book-1' />);
    expect(screen.getByText('Previous Chapter').closest('button')).toBeDisabled();
    expect(screen.getByText('Next Chapter').closest('button')).not.toBeDisabled();
    expect(screen.getByText('Chapter 1')).toBeDefined();
  });

  it('calls viewPagination with up/section for Previous Chapter', () => {
    render(<TOCChapterNav bookKey='book-1' />);
    fireEvent.click(screen.getByText('Previous Chapter'));
    expect(viewPagination).toHaveBeenCalledWith(view, viewSettings, 'up', 'section');
  });

  it('calls viewPagination with down/section for Next Chapter', () => {
    render(<TOCChapterNav bookKey='book-1' />);
    fireEvent.click(screen.getByText('Next Chapter'));
    expect(viewPagination).toHaveBeenCalledWith(view, viewSettings, 'down', 'section');
  });
});
```

注意：`useBookProgress` 的 mock 需要在模块导入前赋值；若 Vitest 报模块被提升问题，把 `useBookProgress` 改为导出变量并在 mock 工厂中返回，同时测试中更新该变量再 `rerender`。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter readest-local exec vitest run src/__tests__/components/sidebar/TOCChapterNav.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现组件**

创建 `apps/readest-app/src/app/reader/components/sidebar/TOCChapterNav.tsx`：

```tsx
import clsx from 'clsx';
import React, { useCallback } from 'react';
import { useReaderStore } from '@/store/readerStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useTranslation } from '@/hooks/useTranslation';
import { viewPagination } from '../../hooks/usePagination';

const TOCChapterNav: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const getView = useReaderStore((s) => s.getView);
  const getViewSettings = useReaderStore((s) => s.getViewSettings);
  const getBookData = useBookDataStore((s) => s.getBookData);
  const progress = useBookProgress(bookKey);
  const bookData = getBookData(bookKey);

  const sectionCount = progress?.section?.total ?? bookData?.bookDoc?.sections?.length ?? 0;
  const currentIndex = progress?.index ?? -1;
  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex >= 0 && currentIndex < sectionCount - 1;

  const handlePrev = useCallback(() => {
    viewPagination(getView(bookKey), getViewSettings(bookKey), 'up', 'section');
  }, [bookKey, getView, getViewSettings]);

  const handleNext = useCallback(() => {
    viewPagination(getView(bookKey), getViewSettings(bookKey), 'down', 'section');
  }, [bookKey, getView, getViewSettings]);

  if (sectionCount <= 0) return null;

  return (
    <div className='border-base-300/50 flex items-center gap-x-2 border-t px-2 py-2'>
      <button
        type='button'
        disabled={!canGoPrev}
        onClick={handlePrev}
        className={clsx(
          'btn btn-ghost h-8 min-h-8 shrink-0 px-2 text-sm',
          !canGoPrev && 'cursor-default opacity-50',
        )}
      >
        {_('Previous Chapter')}
      </button>
      <div
        className='min-w-0 flex-1 truncate px-1 text-center text-xs'
        title={progress?.sectionLabel}
      >
        {progress?.sectionLabel || ''}
      </div>
      <button
        type='button'
        disabled={!canGoNext}
        onClick={handleNext}
        className={clsx(
          'btn btn-ghost h-8 min-h-8 shrink-0 px-2 text-sm',
          !canGoNext && 'cursor-default opacity-50',
        )}
      >
        {_('Next Chapter')}
      </button>
    </div>
  );
};

export default TOCChapterNav;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter readest-local exec vitest run src/__tests__/components/sidebar/TOCChapterNav.test.tsx`
Expected: PASS

- [ ] **Step 5: 挂载到侧栏 TOC 内容区**

在 `apps/readest-app/src/app/reader/components/sidebar/Content.tsx` import 区域加入：

```tsx
import TOCChapterNav from './TOCChapterNav';
```

在 `</OverlayScrollbarsComponent>` 之后、`<TabNavigation ...>` 所在容器之前加入：

```tsx
{activeTab === 'toc' && bookDoc.toc && <TOCChapterNav bookKey={sideBarBookKey} />}
```

- [ ] **Step 6: 提交**

```bash
git add apps/readest-app/src/app/reader/components/sidebar/TOCChapterNav.tsx apps/readest-app/src/__tests__/components/sidebar/TOCChapterNav.test.tsx apps/readest-app/src/app/reader/components/sidebar/Content.tsx
git commit -m "feat(reader): add always-visible chapter nav to TOC"
```

---

### Task 4: 底部进度区显示章节名

**Files:**
- Modify: `apps/readest-app/src/app/reader/components/ProgressBar.tsx:96,160-200`
- Test: `apps/readest-app/src/__tests__/components/ProgressBar.test.tsx`

**Interfaces:**
- Consumes: `progress.sectionLabel`（`useBookProgress`）、`viewSettings.vertical/showStickyProgressBar`。
- Produces: 非垂直、非 sticky 模式下底部左侧显示章节名，右侧保留原进度文本。

- [ ] **Step 1: 编写失败测试**

创建 `apps/readest-app/src/__tests__/components/ProgressBar.test.tsx`：

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: { hasSafeAreaInset: false } }),
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getView: () => null,
    getViewSettings: () => ({
      vertical: false,
      scrolled: false,
      showStickyProgressBar: false,
      marginBottomPx: 20,
      showRemainingTime: false,
      showRemainingPages: false,
      showProgressInfo: true,
      showCurrentTime: false,
      showCurrentBatteryStatus: false,
      rtl: false,
    }),
  }),
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({ getBookData: () => ({}) }),
}));
vi.mock('@/store/readerProgressStore', () => ({
  useBookProgress: () => ({
    sectionLabel: '第一章',
    section: { current: 0, total: 10 },
    pageinfo: { current: 0, total: 100 },
    fraction: 0,
    pageItem: null,
  }),
}));
vi.mock('@/app/reader/hooks/useCurrentTime', () => ({
  useCurrentTime: () => '',
}));
vi.mock('@/app/reader/hooks/useCurrentBattery', () => ({
  useCurrentBatteryStatus: () => null,
}));
vi.mock('@/hooks/useMedianPageDurationSecs', () => ({
  useMedianPageDurationSecs: () => undefined,
}));

import ProgressBar from '@/app/reader/components/ProgressBar';

afterEach(() => cleanup());

describe('ProgressBar', () => {
  it('shows the current section label at the bottom', () => {
    render(<ProgressBar bookKey='book-1' horizontalGap={5} contentInsets={{ left: 20, right: 20, top: 20, bottom: 20 }} gridInsets={{ left: 0, right: 0, top: 0, bottom: 0 }} />);
    expect(screen.getByText('第一章')).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter readest-local exec vitest run src/__tests__/components/ProgressBar.test.tsx`
Expected: FAIL（页面中不存在“第一章”）

- [ ] **Step 3: 实现章节名展示**

在 `apps/readest-app/src/app/reader/components/ProgressBar.tsx` 中把解构改为：

```tsx
const { section, pageinfo, sectionLabel } = progress || {};
```

在 `<StickyProgressBar ... />` 渲染块之后、`{hasRemainingInfo && (...)}` 之前加入：

```tsx
{!isVertical && !stickyBarActive && sectionLabel && (
  <div
    className='section-label min-w-0 flex-1 truncate text-start'
    title={sectionLabel}
  >
    {sectionLabel}
  </div>
)}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter readest-local exec vitest run src/__tests__/components/ProgressBar.test.tsx`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/readest-app/src/app/reader/components/ProgressBar.tsx apps/readest-app/src/__tests__/components/ProgressBar.test.tsx
git commit -m "feat(reader): show current chapter in bottom progress area"
```

---

### Task 5: 全量验证

**Files:** 无新增改动（仅修复验证中暴露的问题）。

- [ ] **Step 1: 运行全部前端单元测试**

Run: `pnpm --filter readest-local test`
Expected: PASS

- [ ] **Step 2: 运行类型检查与 lint**

Run: `pnpm --filter readest-local lint`
Expected: PASS

- [ ] **Step 3: 如有失败则修复对应任务文件并重跑**

按失败堆栈定位到 Task 1-4 对应文件修复，随后重跑 Step 1-2。

- [ ] **Step 4: 更新文档并提交**

在 `docs/reader-ui-buttons-inventory.md` 或新增变更摘要中记录本次默认值与入口变化（若已有对应章节则追加），然后：

```bash
git add docs
git commit -m "docs: record tReader layout alignment changes"
```

---

## Self-Review

- Spec 覆盖：间距（Task 1）、字体层级（Task 1）、滚动最大宽（Task 1）、目录入口（Task 2）、TOC 常驻章节切换（Task 3）、进度展示（Task 4）、验证（Task 5）。
- 占位符检查：无 TBD/TODO；每个代码步骤都给出完整实现或测试代码。
- 类型一致性：`viewPagination(view, viewSettings, side, mode)` 签名与 `usePagination.ts:126` 一致；`useSidebarStore` 字段与 `sidebarStore.ts` 一致；`Button` 未在章节导航中使用，改用原生 button 避免 icon 必填约束。
