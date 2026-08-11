# 阅读页章节目录移动至右下角实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把章节目录入口统一移动到阅读界面右下角，并在目录列表中始终显示当前章节的“上一章 / 下一章”快捷按钮。

**Architecture:** 新增一个右下角悬浮“目录”按钮，点击后打开现有左侧栏并切换到 TOC 标签；目录继续复用现有 `TOCView` 树形列表。在侧栏 TOC 内容区底部新增常驻的章节切换条，使用现有 `viewPagination(..., 'section')` 完成上一章/下一章跳转。移除顶栏 `SidebarToggler` 和移动端底栏 TOC 按钮，避免入口重复。

**Tech Stack:** React 19、Next.js、TypeScript、Tailwind CSS、Zustand stores、react-virtuoso。

## Global Constraints

- 保留上一轮需求：`showNotebookButton/showBookmarkButton/showPrevPageButton/showNextPageButton` 默认仍为 `false`，本次不改变这些开关默认值。
- “上一章 / 下一章”入口与页面级翻页开关解耦：始终在目录列表中显示，不受 `showPrevPageButton/showNextPageButton` 控制。
- 目录必须保持列表形式，继续复用 `TOCView` 的树形列表与当前章节高亮。
- 不删除侧栏的“注释 / 书签”标签页；右下角按钮只负责直达目录标签。
- 按钮定位需避开底部 FooterBar（桌面 52px、移动端约 64px+安全区）。

---

## File Structure

- Create: `apps/readest-app/src/app/reader/components/TOCFloatingButton.tsx`
  - 右下角悬浮目录按钮；负责设置 `sideBarBookKey`、`sideBarTab: 'toc'` 并打开侧栏。
- Create: `apps/readest-app/src/app/reader/components/sidebar/TOCChapterNav.tsx`
  - 目录列表底部的常驻“上一章 / 下一章”切换条。
- Modify: `apps/readest-app/src/app/reader/components/BooksGrid.tsx`
  - 在 `BookCellInner` 中渲染 `TOCFloatingButton`。
- Modify: `apps/readest-app/src/app/reader/components/HeaderBar.tsx`
  - 移除顶栏 `SidebarToggler` 入口。
- Modify: `apps/readest-app/src/app/reader/components/footerbar/NavigationBar.tsx`
  - 移除移动端底栏“目录”按钮。
- Modify: `apps/readest-app/src/app/reader/components/sidebar/Content.tsx`
  - 在 TOC 标签内容区底部渲染 `TOCChapterNav`。
- Test: `apps/readest-app/src/__tests__/components/sidebar/TOCChapterNav.test.tsx`
- Test: `apps/readest-app/src/__tests__/components/TOCFloatingButton.test.tsx`

---

### Task 1: 常驻上一章/下一章切换条

**Files:**
- Create: `apps/readest-app/src/app/reader/components/sidebar/TOCChapterNav.tsx`
- Modify: `apps/readest-app/src/app/reader/components/sidebar/Content.tsx:84-86`
- Test: `apps/readest-app/src/__tests__/components/sidebar/TOCChapterNav.test.tsx`

**Interfaces:**
- Consumes: `bookKey: string`；`progress.index`（当前章节索引）、`progress.section.total`（章节总数）、`progress.sectionLabel`（当前章节名）、`bookData.bookDoc.sections`（总数兜底）、`viewPagination(view, viewSettings, 'up' | 'down', 'section')`。
- Produces: `TOCChapterNav` 组件，接受 `{ bookKey: string }`。

- [ ] **Step 1: 编写失败测试**

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

let currentProgress = { index: 0, section: { total: 3 }, sectionLabel: 'Chapter 1' };
let view: any = { renderer: { prevSection: vi.fn(), nextSection: vi.fn() } };

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getView: () => view,
    getViewSettings: () => ({}),
  }),
}));

vi.mock('@/store/readerProgressStore', () => ({
  useBookProgress: () => currentProgress,
}));

vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getBookData: () => ({ bookDoc: { sections: [{}, {}, {}] } }),
  }),
}));

import TOCChapterNav from '@/app/reader/components/sidebar/TOCChapterNav';

afterEach(() => cleanup());

describe('TOCChapterNav', () => {
  it('disables Previous Chapter on the first chapter', () => {
    render(<TOCChapterNav bookKey='book-1' />);
    expect(screen.getByText('Previous Chapter').closest('button')).toBeDisabled();
    expect(screen.getByText('Next Chapter').closest('button')).not.toBeDisabled();
  });

  it('calls nextSection when Next Chapter is clicked', () => {
    currentProgress = { index: 0, section: { total: 3 }, sectionLabel: 'Chapter 1' };
    render(<TOCChapterNav bookKey='book-1' />);
    fireEvent.click(screen.getByText('Next Chapter'));
    expect(view.renderer.nextSection).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C apps/readest-app exec vitest run src/__tests__/components/sidebar/TOCChapterNav.test.tsx`
Expected: FAIL（组件不存在）。

- [ ] **Step 3: 实现 `TOCChapterNav`**

```tsx
import React, { useCallback } from 'react';
import { useReaderStore } from '@/store/readerStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useTranslation } from '@/hooks/useTranslation';
import { viewPagination } from '../../hooks/usePagination';
import Button from '@/components/Button';

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
      <Button label={_('Previous Chapter')} disabled={!canGoPrev} onClick={handlePrev} />
      <div className='min-w-0 flex-1 truncate px-1 text-center text-xs' title={progress?.sectionLabel}>
        {progress?.sectionLabel || ''}
      </div>
      <Button label={_('Next Chapter')} disabled={!canGoNext} onClick={handleNext} />
    </div>
  );
};

export default TOCChapterNav;
```

- [ ] **Step 4: 接入 `SidebarContent`**

在 `apps/readest-app/src/app/reader/components/sidebar/Content.tsx` 中：

```tsx
import TOCChapterNav from './TOCChapterNav';
// ...
{activeTab === 'toc' && bookDoc.toc && (
  <>
    <TOCView toc={bookDoc.toc} bookKey={sideBarBookKey} />
  </>
)}
```

在 `OverlayScrollbarsComponent` 结束标签之后、`TabNavigation` 之前加入：

```tsx
{activeTab === 'toc' && <TOCChapterNav bookKey={sideBarBookKey} />}
```

`OverlayScrollbarsComponent` 已有 `min-h-0 flex-1`，新增切换条会自动压缩列表高度并保持常驻。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm -C apps/readest-app exec vitest run src/__tests__/components/sidebar/TOCChapterNav.test.tsx`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/readest-app/src/app/reader/components/sidebar/TOCChapterNav.tsx apps/readest-app/src/app/reader/components/sidebar/Content.tsx apps/readest-app/src/__tests__/components/sidebar/TOCChapterNav.test.tsx
git commit -m "feat(reader): add always-visible chapter nav to TOC"
```

---

### Task 2: 右下角悬浮目录按钮

**Files:**
- Create: `apps/readest-app/src/app/reader/components/TOCFloatingButton.tsx`
- Modify: `apps/readest-app/src/app/reader/components/BooksGrid.tsx:262-276`
- Test: `apps/readest-app/src/__tests__/components/TOCFloatingButton.test.tsx`

**Interfaces:**
- Consumes: `bookKey: string`；`useSidebarStore` 的 `sideBarBookKey/isSideBarVisible/setSideBarBookKey/setSideBarVisible`；`useBookDataStore` 的 `getConfig/setConfig`。
- Produces: `TOCFloatingButton`，接受 `{ bookKey: string }`。

- [ ] **Step 1: 编写失败测试**

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

  it('is hidden while the book sidebar is open', () => {
    sidebar.sideBarBookKey = 'book-1';
    sidebar.isSideBarVisible = true;
    render(<TOCFloatingButton bookKey='book-1' />);
    expect(screen.queryByLabelText('Table of Contents')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm -C apps/readest-app exec vitest run src/__tests__/components/TOCFloatingButton.test.tsx`
Expected: FAIL（组件不存在）。

- [ ] **Step 3: 实现 `TOCFloatingButton`**

```tsx
import React from 'react';
import { IoIosList } from 'react-icons/io';
import { useSidebarStore } from '@/store/sidebarStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useTranslation } from '@/hooks/useTranslation';

const TOCFloatingButton: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const { sideBarBookKey, isSideBarVisible, setSideBarBookKey, setSideBarVisible } =
    useSidebarStore();
  const getConfig = useBookDataStore((s) => s.getConfig);
  const setConfig = useBookDataStore((s) => s.setConfig);

  if (sideBarBookKey === bookKey && isSideBarVisible) return null;

  const handleOpenTOC = () => {
    setSideBarBookKey(bookKey);
    const config = getConfig(bookKey);
    if (config?.viewSettings) {
      setConfig(bookKey, {
        viewSettings: { ...config.viewSettings, sideBarTab: 'toc' },
      });
    }
    setSideBarVisible(true);
  };

  return (
    <button
      type='button'
      title={_('Table of Contents')}
      aria-label={_('Table of Contents')}
      onClick={handleOpenTOC}
      className='bg-base-100/90 eink:border-base-content absolute bottom-16 right-3 z-20 flex h-11 w-11 items-center justify-center rounded-full shadow-lg backdrop-blur-sm max-[640px]:bottom-24 eink:border'
    >
      <IoIosList size={22} />
    </button>
  );
};

export default TOCFloatingButton;
```

- [ ] **Step 4: 接入 `BooksGrid`**

在 `apps/readest-app/src/app/reader/components/BooksGrid.tsx` 中：

```tsx
import TOCFloatingButton from './TOCFloatingButton';
// ...
<FooterBar
  bookKey={bookKey}
  bookFormat={book.format}
  section={section}
  pageinfo={pageinfo}
  isHoveredAnim={false}
  gridInsets={gridInsets}
/>
<TOCFloatingButton bookKey={bookKey} />
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm -C apps/readest-app exec vitest run src/__tests__/components/TOCFloatingButton.test.tsx`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/readest-app/src/app/reader/components/TOCFloatingButton.tsx apps/readest-app/src/app/reader/components/BooksGrid.tsx apps/readest-app/src/__tests__/components/TOCFloatingButton.test.tsx
git commit -m "feat(reader): add floating TOC button at bottom-right"
```

---

### Task 3: 移除旧目录入口

**Files:**
- Modify: `apps/readest-app/src/app/reader/components/HeaderBar.tsx:26,226-230`
- Modify: `apps/readest-app/src/app/reader/components/footerbar/NavigationBar.tsx:3,35,55-61`

- [ ] **Step 1: 移除顶栏侧栏开关**

在 `HeaderBar.tsx`：
- 删除 `import SidebarToggler from './SidebarToggler';`
- 删除：

```tsx
{!isSideBarVisible && (
  <div className='hidden sm:flex'>
    <SidebarToggler bookKey={bookKey} />
  </div>
)}
```

保留 `isSideBarVisible` 的其余用途（顶部内边距、窗口圆角等）。

- [ ] **Step 2: 移除移动端底栏目录按钮**

在 `NavigationBar.tsx`：
- 删除 `import { IoIosList as TOCIcon } from 'react-icons/io';`
- 删除 `import { useSidebarStore } from '@/store/sidebarStore';`
- 删除 `const { isSideBarVisible, isSideBarPinned } = useSidebarStore();`
- 删除 `const tocIconSize = useResponsiveSize(23);`
- 删除：

```tsx
{isSideBarVisible && isSideBarPinned ? null : (
  <Button
    label={_('Table of Contents')}
    icon={<TOCIcon size={tocIconSize} />}
    onClick={() => onSetActionTab('toc')}
  />
)}
```

- [ ] **Step 3: 运行 lint**

Run: `pnpm -C apps/readest-app lint`
Expected: PASS（无未使用变量/导入）。

- [ ] **Step 4: 提交**

```bash
git add apps/readest-app/src/app/reader/components/HeaderBar.tsx apps/readest-app/src/app/reader/components/footerbar/NavigationBar.tsx
git commit -m "refactor(reader): move TOC entry to bottom-right floating button"
```

---

### Task 4: 全量验证

- [ ] **Step 1: 运行相关单测**

Run: `pnpm -C apps/readest-app exec vitest run src/__tests__/components/sidebar/TOCChapterNav.test.tsx src/__tests__/components/TOCFloatingButton.test.tsx src/__tests__/services/constants.test.ts`
Expected: 全部 PASS。

- [ ] **Step 2: 运行 lint**

Run: `pnpm -C apps/readest-app lint`
Expected: PASS。

- [ ] **Step 3: 更新实现记录文档**

在 `docs/reader-ui-toggle-settings.md` 末尾追加本次改动摘要（右下角目录按钮、常驻章节切换条、旧入口移除）。

---

## Self-Review

1. 右下角按钮覆盖桌面与移动端：新组件在 `BookCellInner` 中渲染，响应式 `bottom` 避开底部栏，满足“移动至界面右下角”。
2. 上一章/下一章入口恢复：`TOCChapterNav` 常驻目录列表底部，独立于上一轮的 `showPrevPageButton/showNextPageButton` 开关。
3. 目录以列表展示：继续复用 `TOCView` 树形列表与当前章节高亮。
4. 首章/末章边界：`canGoPrev/canGoNext` 基于 `progress.index` 与章节总数计算并禁用。
