# 搜索按钮右移与侧边栏默认开关 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把侧边栏顶部的搜索按钮改为右下角浮动按钮（位于“目录”按钮正上方且同一竖直线上），并在阅读设置里新增“侧边栏”开关（默认关闭 = 默认隐藏侧边栏）。

**Architecture:** 新建一个与 `TOCFloatingButton` 同级的 `SearchFloatingButton` 浮动按钮，保留原搜索栏逻辑；从 `SidebarHeader` 移除旧搜索按钮。新增 `ViewSettings.showSideBar` 布尔字段（默认 `false`），由 `ControlPanel` 读写，并在 `useSidebar` 初始化时决定 pinned 侧边栏是否自动显示。

**Tech Stack:** React 19 + TypeScript + Tailwind CSS + zustand + Vitest/Testing Library + i18next（`useTranslation`）。

## Global Constraints

- 当前工作区已有用户未提交改动。每个 commit 只 `git add` 本任务明确列出的文件；`ControlPanel.tsx` 已含用户改动，提交前必须先 `git diff apps/readest-app/src/components/settings/ControlPanel.tsx` 确认本次新增区域，不得顺带提交无关改动。
- 不得使用内置浏览器访问、启动、调试或验证本地项目；验证只通过 Vitest 和 `pnpm lint`。
- 新增 UI 文案必须走 `_('...')`，并同步更新 `apps/readest-app/public/locales/zh-CN/translation.json` 和 `apps/readest-app/public/locales/en/translation.json`。
- 新字段命名统一为 `showSideBar`（阅读设置中 `ViewConfig` 的布尔字段，默认 `false`）。
- 对齐规则：`SearchFloatingButton` 与 `TOCFloatingButton` 都使用 `right-4`、`w-12`，中心点自然落在同一竖直线上；TOC 为 `bottom-24 sm:bottom-16`，搜索按钮为其正上方一格：`bottom-40 sm:bottom-32`。
- 搜索按钮行为：点击后打开当前书侧边栏、设置 `sideBarTab: 'toc'`、显示搜索栏；当侧边栏已打开且属于当前书时隐藏按钮（与 `TOCFloatingButton` 一致）。
- 测试与命令都在 `apps/readest-app` 目录下执行。

---

### Task 1: 新增 `showSideBar` 设置字段与默认值

**Files:**
- Modify: `apps/readest-app/src/types/book.ts:316`（`ViewConfig` 中 `showNextPageButton` 之后）
- Modify: `apps/readest-app/src/services/constants.ts:426`（`DEFAULT_VIEW_CONFIG` 中 `showNextPageButton: false` 之后）
- Test: `apps/readest-app/src/__tests__/services/constants.test.ts:604-606`

**Interfaces:**
- Produces: `ViewConfig.showSideBar: boolean`，`DEFAULT_VIEW_CONFIG.showSideBar === false`。后续 Task 4、Task 5 直接读取该字段。

- [ ] **Step 1: 写失败测试**

在 `apps/readest-app/src/__tests__/services/constants.test.ts` 的 `describe('DEFAULT_VIEW_CONFIG', ...)` 内、现有 `showNextPageButton` 断言之后插入：

```ts
      it('hides the sidebar by default', () => {
        expect(DEFAULT_VIEW_CONFIG.showSideBar).toBe(false);
      });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/readest-app; pnpm test -- --run src/__tests__/services/constants.test.ts`

Expected: FAIL，`DEFAULT_VIEW_CONFIG.showSideBar` 为 `undefined`（类型尚未定义，esbuild 不报类型错，运行断言失败）。

- [ ] **Step 3: 添加类型字段**

在 `apps/readest-app/src/types/book.ts` 的 `ViewConfig` 中：

```ts
  showNextPageButton: boolean;
  showSideBar: boolean;
```

- [ ] **Step 4: 添加默认值**

在 `apps/readest-app/src/services/constants.ts` 的 `DEFAULT_VIEW_CONFIG` 中：

```ts
  showNextPageButton: false,
  showSideBar: false,
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd apps/readest-app; pnpm test -- --run src/__tests__/services/constants.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/readest-app/src/types/book.ts apps/readest-app/src/services/constants.ts apps/readest-app/src/__tests__/services/constants.test.ts
git commit -m "feat(reader): add showSideBar view setting defaulting to off"
```

---

### Task 2: `useSidebar` 按开关决定默认可见性

**Files:**
- Modify: `apps/readest-app/src/app/reader/hooks/useSidebar.ts:17-24`
- Test: Create `apps/readest-app/src/__tests__/app/reader/hooks/useSidebar.test.tsx`

**Interfaces:**
- Consumes: `settings.globalViewSettings.showSideBar`（Task 1 产出，默认 `false`）。
- Produces: `useSidebar(initialWidth: string, isPinned: boolean)` 挂载时调用 `setSideBarVisible(isPinned && showSideBar)`。

- [ ] **Step 1: 写失败测试**

创建 `apps/readest-app/src/__tests__/app/reader/hooks/useSidebar.test.tsx`：

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

let mockGlobalShowSideBar = false;

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {} }),
}));

vi.mock('@/helpers/settings', () => ({
  saveSysSettings: vi.fn(),
}));

const sidebarActions = {
  sideBarWidth: '300px',
  isSideBarVisible: false,
  isSideBarPinned: false,
  getSideBarWidth: () => '300px',
  setSideBarWidth: vi.fn(),
  setSideBarPin: vi.fn(),
  setSideBarVisible: vi.fn(),
  toggleSideBar: vi.fn(),
  toggleSideBarPin: vi.fn(),
};

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: {
      globalViewSettings: { showSideBar: mockGlobalShowSideBar },
      globalReadSettings: {},
    },
  }),
}));

vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: () => sidebarActions,
}));

import useSidebar from '@/app/reader/hooks/useSidebar';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useSidebar default visibility', () => {
  it('keeps the sidebar hidden when the toggle is off even when pinned', () => {
    mockGlobalShowSideBar = false;
    renderHook(() => useSidebar('300px', true));
    expect(sidebarActions.setSideBarVisible).toHaveBeenCalledWith(false);
  });

  it('shows the pinned sidebar when the toggle is on', () => {
    mockGlobalShowSideBar = true;
    renderHook(() => useSidebar('300px', true));
    expect(sidebarActions.setSideBarVisible).toHaveBeenCalledWith(true);
  });

  it('keeps a non-pinned sidebar hidden when the toggle is on', () => {
    mockGlobalShowSideBar = true;
    renderHook(() => useSidebar('300px', false));
    expect(sidebarActions.setSideBarVisible).toHaveBeenCalledWith(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/readest-app; pnpm test -- --run src/__tests__/app/reader/hooks/useSidebar.test.tsx`

Expected: FAIL，因为当前实现无条件调用 `setSideBarVisible(isPinned)`，第一个用例实际收到 `true`。

- [ ] **Step 3: 修改初始化逻辑**

将 `apps/readest-app/src/app/reader/hooks/useSidebar.ts` 的 effect 改为：

```ts
  useEffect(() => {
    setSideBarWidth(initialWidth);
    setSideBarPin(isPinned);
    setSideBarVisible(isPinned && (settings.globalViewSettings.showSideBar ?? false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/readest-app; pnpm test -- --run src/__tests__/app/reader/hooks/useSidebar.test.tsx`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/readest-app/src/app/reader/hooks/useSidebar.ts apps/readest-app/src/__tests__/app/reader/hooks/useSidebar.test.tsx
git commit -m "feat(reader): hide pinned sidebar by default"
```

---

### Task 3: 新增右下角浮动搜索按钮

**Files:**
- Create: `apps/readest-app/src/app/reader/components/SearchFloatingButton.tsx`
- Modify: `apps/readest-app/src/app/reader/components/BooksGrid.tsx:20`（import）、`apps/readest-app/src/app/reader/components/BooksGrid.tsx:265`（渲染）
- Test: Create `apps/readest-app/src/__tests__/components/SearchFloatingButton.test.tsx`

**Interfaces:**
- Consumes: `useSidebarStore` 的 `sideBarBookKey`、`isSideBarVisible`、`setSideBarBookKey`、`setSideBarVisible`、`setSearchBarVisible`；`useBookDataStore` 的 `getConfig`、`setConfig`。
- Produces: `<SearchFloatingButton bookKey: string>`，点击后打开侧边栏并显示搜索栏；侧边栏已打开且属于当前书时返回 `null`。

- [ ] **Step 1: 写失败测试**

创建 `apps/readest-app/src/__tests__/components/SearchFloatingButton.test.tsx`：

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

const sidebar = {
  sideBarBookKey: '',
  isSideBarVisible: false,
  setSideBarBookKey: vi.fn(),
  setSideBarVisible: vi.fn(),
  setSearchBarVisible: vi.fn(),
};

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));
vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: () => sidebar,
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getConfig: () => ({ viewSettings: { sideBarTab: 'annotations' } }),
    setConfig: vi.fn(),
  }),
}));

import SearchFloatingButton from '@/app/reader/components/SearchFloatingButton';

afterEach(() => cleanup());

describe('SearchFloatingButton', () => {
  it('opens the sidebar with the search bar', () => {
    render(<SearchFloatingButton bookKey='book-1' />);
    fireEvent.click(screen.getByLabelText('Search'));
    expect(sidebar.setSideBarBookKey).toHaveBeenCalledWith('book-1');
    expect(sidebar.setSideBarVisible).toHaveBeenCalledWith(true);
    expect(sidebar.setSearchBarVisible).toHaveBeenCalledWith(true);
  });

  it('is hidden while the sidebar is open for the same book', () => {
    sidebar.sideBarBookKey = 'book-1';
    sidebar.isSideBarVisible = true;
    render(<SearchFloatingButton bookKey='book-1' />);
    expect(screen.queryByLabelText('Search')).toBeNull();
  });

  it('sits above the TOC button on the same vertical line', () => {
    sidebar.sideBarBookKey = '';
    sidebar.isSideBarVisible = false;
    const { container } = render(<SearchFloatingButton bookKey='book-1' />);
    const button = container.querySelector('button');
    expect(button?.className).toContain('bottom-40');
    expect(button?.className).toContain('right-4');
    expect(button?.className).toContain('w-12');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/readest-app; pnpm test -- --run src/__tests__/components/SearchFloatingButton.test.tsx`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 创建组件**

创建 `apps/readest-app/src/app/reader/components/SearchFloatingButton.tsx`：

```tsx
import React, { useCallback } from 'react';
import { FiSearch } from 'react-icons/fi';
import { useSidebarStore } from '@/store/sidebarStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useTranslation } from '@/hooks/useTranslation';

const SearchFloatingButton: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const { sideBarBookKey, isSideBarVisible, setSideBarBookKey, setSideBarVisible, setSearchBarVisible } =
    useSidebarStore();
  const { getConfig, setConfig } = useBookDataStore();

  const handleOpenSearch = useCallback(() => {
    const config = getConfig(bookKey);
    if (config?.viewSettings) {
      setConfig(bookKey, { viewSettings: { ...config.viewSettings, sideBarTab: 'toc' } });
    }
    setSideBarBookKey(bookKey);
    setSideBarVisible(true);
    setSearchBarVisible(true);
  }, [bookKey, getConfig, setConfig, setSideBarBookKey, setSideBarVisible, setSearchBarVisible]);

  if (sideBarBookKey === bookKey && isSideBarVisible) return null;

  return (
    <button
      type='button'
      aria-label={_('Search')}
      title={_('Search')}
      onClick={handleOpenSearch}
      className='absolute bottom-40 right-4 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-base-100/90 text-base-content shadow-lg backdrop-blur-sm transition-transform active:scale-95 sm:bottom-32'
    >
      <FiSearch size={20} />
    </button>
  );
};

export default SearchFloatingButton;
```

- [ ] **Step 4: 接入 `BooksGrid`**

在 `apps/readest-app/src/app/reader/components/BooksGrid.tsx` 中：

```tsx
import TOCFloatingButton from './TOCFloatingButton';
import SearchFloatingButton from './SearchFloatingButton';
```

在 `<TOCFloatingButton bookKey={bookKey} />` 上方加：

```tsx
      <SearchFloatingButton bookKey={bookKey} />
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd apps/readest-app; pnpm test -- --run src/__tests__/components/SearchFloatingButton.test.tsx`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/readest-app/src/app/reader/components/SearchFloatingButton.tsx apps/readest-app/src/app/reader/components/BooksGrid.tsx apps/readest-app/src/__tests__/components/SearchFloatingButton.test.tsx
git commit -m "feat(reader): add floating search button above TOC button"
```

---

### Task 4: 从侧边栏头部移除旧搜索按钮

**Files:**
- Modify: `apps/readest-app/src/app/reader/components/sidebar/Header.tsx:5,12-18,55-66`
- Modify: `apps/readest-app/src/app/reader/components/sidebar/SideBar.tsx:124-130,252-261`

**Interfaces:**
- Consumes: 删除 `SidebarHeader` 的 `isSearchBarVisible` 与 `onToggleSearchBar` props。
- Produces: `SidebarHeader` 只保留 `bookKey`、`isPinned`、`onClose`、`onTogglePin`；`SideBar` 中 `handleShowSearchBar`（快捷键）和 `handleHideSearchBar`（搜索栏关闭）保持不变。

- [ ] **Step 1: 修改 `Header.tsx`**

删除：

```tsx
import { FiSearch } from 'react-icons/fi';
```

删除 props 声明与解构中的两项：

```tsx
  isSearchBarVisible: boolean;
  onToggleSearchBar: () => void;
```

删除整个搜索按钮块：

```tsx
        <button
          title={isSearchBarVisible ? _('Hide Search Bar') : _('Show Search Bar')}
          onClick={onToggleSearchBar}
          className={clsx(
            'btn btn-ghost left-0 h-8 min-h-8 w-8 p-0',
            isSearchBarVisible ? 'bg-base-300' : '',
          )}
        >
          <FiSearch size={iconSize18} className='text-base-content' />
        </button>
```

同时删除不再使用的 `const iconSize18 = useResponsiveSize(18);`。

- [ ] **Step 2: 修改 `SideBar.tsx`**

删除 `handleToggleSearchBar` 函数：

```tsx
  const handleToggleSearchBar = () => {
    if (isSearchBarVisible) {
      handleHideSearchBar();
    } else {
      setSearchBarVisible(true);
    }
  };
```

将 `<SidebarHeader>` 调用改为：

```tsx
          <SidebarHeader
            bookKey={sideBarBookKey!}
            isPinned={isSideBarPinned}
            onClose={() => setSideBarVisible(false)}
            onTogglePin={handleSideBarTogglePin}
          />
```

`isSearchBarVisible` 仍从 store 读取，继续用于 `.search-bar` 类名和 `<SearchBar isVisible>`。

- [ ] **Step 3: 类型检查确认无残留引用**

Run: `cd apps/readest-app; pnpm lint`

Expected: 无 `isSearchBarVisible` / `onToggleSearchBar` / `iconSize18` 相关编译错误；若 lint 因用户既有改动报其他错，只修复本任务引入的错误。

- [ ] **Step 4: 提交**

```bash
git add apps/readest-app/src/app/reader/components/sidebar/Header.tsx apps/readest-app/src/app/reader/components/sidebar/SideBar.tsx
git commit -m "refactor(reader): remove sidebar header search button"
```

---

### Task 5: ControlPanel 新增“侧边栏”开关

**Files:**
- Modify: `apps/readest-app/src/components/settings/ControlPanel.tsx:80-81,388-418`（新增 state、保存 effect、Reading Interface 分组开关）
- Test: Create `apps/readest-app/src/__tests__/components/settings/ControlPanelSidebarToggle.test.tsx`
- Modify: `apps/readest-app/public/locales/zh-CN/translation.json`
- Modify: `apps/readest-app/public/locales/en/translation.json`

**Interfaces:**
- Consumes: `ViewSettings.showSideBar`（Task 1 产出）与 `saveViewSettings(envConfig, bookKey, 'showSideBar', boolean, false, false)`。
- Produces: 阅读设置 > Reading Interface 分组中的 `Sidebar` 开关，默认 `false`（关闭 = 默认隐藏侧边栏）。

- [ ] **Step 1: 写失败测试**

创建 `apps/readest-app/src/__tests__/components/settings/ControlPanelSidebarToggle.test.tsx`：

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService: { isMobileApp: false } }),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

const stubView = {
  renderer: {
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    hasAttribute: () => false,
    setStyles: vi.fn(),
  },
};

vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getView: () => stubView,
    getViews: () => [],
    getViewSettings: () => ({
      scrolled: false,
      noContinuousScroll: false,
      showSideBar: false,
    }),
    recreateViewer: vi.fn(),
  }),
}));

vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getBookData: () => ({ isFixedLayout: false, book: { format: 'EPUB' } }),
  }),
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({ settings: { globalViewSettings: {} } }),
}));

vi.mock('@/hooks/useResetSettings', () => ({
  useResetViewSettings: () => vi.fn(),
}));

vi.mock('@/hooks/useEinkMode', () => ({
  useEinkMode: () => ({ applyEinkMode: vi.fn() }),
}));

const saveViewSettings = vi.fn();
vi.mock('@/helpers/settings', () => ({
  saveViewSettings: (...args: unknown[]) => saveViewSettings(...args),
  saveSysSettings: vi.fn(),
}));

vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => false,
}));

vi.mock('@/utils/share', () => ({
  canShareText: () => true,
}));

vi.mock('@/utils/telemetry', () => ({
  optInTelemetry: vi.fn(),
  optOutTelemetry: vi.fn(),
}));

vi.mock('@/components/settings/PageTurnerSettings', () => ({
  default: () => null,
}));

vi.mock('@/utils/style', () => ({ getStyles: () => '' }));
vi.mock('@/utils/config', () => ({ getMaxInlineSize: () => 720 }));

const applyPageTurnAttributes = vi.fn();
vi.mock('@/app/reader/hooks/useCapturedTurn', () => ({
  applyPageTurnAttributes: (...args: unknown[]) => applyPageTurnAttributes(...args),
}));

import ControlPanel from '@/components/settings/ControlPanel';

const sidebarSwitch = () =>
  screen.getByText('Sidebar').closest('label')?.querySelector('input') ??
  (screen.getByText('Sidebar').closest('div')?.querySelector('input') as HTMLInputElement);

afterEach(() => {
  cleanup();
  saveViewSettings.mockClear();
  applyPageTurnAttributes.mockClear();
});

describe('Settings > Behavior > Sidebar', () => {
  it('renders the Sidebar switch off by default', () => {
    render(<ControlPanel bookKey='test' onRegisterReset={() => {}} />);
    expect(sidebarSwitch()?.checked).toBe(false);
  });

  it('saves showSideBar when toggled on', () => {
    render(<ControlPanel bookKey='test' onRegisterReset={() => {}} />);
    fireEvent.click(sidebarSwitch() as HTMLInputElement);
    expect(saveViewSettings).toHaveBeenCalledWith(expect.anything(), 'test', 'showSideBar', true, false, false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/readest-app; pnpm test -- --run src/__tests__/components/settings/ControlPanelSidebarToggle.test.tsx`

Expected: FAIL，`screen.getByText('Sidebar')` 找不到元素。

- [ ] **Step 3: 添加 state 与保存逻辑**

在 `ControlPanel.tsx` 的 state 区（`showNextPageButton` 之后）加：

```ts
  const [showSideBar, setShowSideBar] = useState(viewSettings.showSideBar);
```

在保存 effect 区（`showNextPageButton` 的 effect 之后）加：

```ts
  useEffect(() => {
    saveViewSettings(envConfig, bookKey, 'showSideBar', showSideBar, false, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSideBar]);
```

- [ ] **Step 4: 添加开关 UI**

在 `ControlPanel.tsx` 的 `Reading Interface` 分组中、`Next Page` 开关之后加：

```tsx
        <SettingsSwitchRow
          label={_('Sidebar')}
          description={_('Show the Sidebar by default')}
          checked={showSideBar}
          onChange={() => setShowSideBar(!showSideBar)}
          data-setting-id='settings.control.showSideBar'
        />
```

- [ ] **Step 5: 添加翻译**

`apps/readest-app/public/locales/zh-CN/translation.json` 新增：

```json
  "Sidebar": "侧边栏",
  "Show the Sidebar by default": "默认显示侧边栏"
```

`apps/readest-app/public/locales/en/translation.json` 新增：

```json
  "Sidebar": "Sidebar",
  "Show the Sidebar by default": "Show the Sidebar by default"
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd apps/readest-app; pnpm test -- --run src/__tests__/components/settings/ControlPanelSidebarToggle.test.tsx`

Expected: PASS。

- [ ] **Step 7: 提交前检查用户改动并提交**

先运行：

```bash
git diff apps/readest-app/src/components/settings/ControlPanel.tsx
```

确认 diff 中只有本任务新增的 state、effect 和开关行属于本次提交；若包含用户的其他改动，先只暂存本任务相关文件，再与用户确认是否把 `ControlPanel.tsx` 一起提交，不得擅自混入。

```bash
git add apps/readest-app/src/components/settings/ControlPanel.tsx apps/readest-app/src/__tests__/components/settings/ControlPanelSidebarToggle.test.tsx apps/readest-app/public/locales/zh-CN/translation.json apps/readest-app/public/locales/en/translation.json
git commit -m "feat(settings): add sidebar default visibility toggle"
```

---

### Task 6: 全量验证

**Files:**
- 无新增；运行既有与本任务相关的测试与检查。

- [ ] **Step 1: 运行相关测试**

Run:

```bash
cd apps/readest-app
pnpm test -- --run src/__tests__/services/constants.test.ts src/__tests__/app/reader/hooks/useSidebar.test.tsx src/__tests__/components/SearchFloatingButton.test.tsx src/__tests__/components/settings/ControlPanelSidebarToggle.test.tsx src/__tests__/components/TOCFloatingButton.test.tsx
```

Expected: 全部 PASS；若 vitest 只接受单文件路径，则逐个文件运行。

- [ ] **Step 2: 运行 lint**

Run: `cd apps/readest-app; pnpm lint`

Expected: 无本任务引入的 TypeScript 或 Biome 错误；用户既有改动导致的报错单独记录，不擅自修复。

- [ ] **Step 3: 更新交接文档**

把本任务结论写入 `docs/reader-ui-buttons-inventory.md`（或新建 `docs/reader-sidebar-search-toggle-changes.md`），记录：搜索按钮已右移、开关默认值、涉及文件清单。

- [ ] **Step 4: 提交验证产物（如无用户改动冲突）**

```bash
git add docs/reader-sidebar-search-toggle-changes.md
git commit -m "docs: record sidebar search button and toggle changes"
```

---

## Self-Review

- Spec coverage：搜索按钮位置迁移 = Task 3 + Task 4；垂直居中对齐 = Task 3 的位置 class 与测试；ControlPanel 开关默认关闭隐藏侧边栏 = Task 1 + Task 2 + Task 5。
- Placeholder scan：所有代码步骤均给出完整实现与测试，无 TBD/TODO。
- Type consistency：字段名统一为 `showSideBar`；`SidebarHeader` 新 props 与 `SideBar.tsx` 调用一致；`SearchFloatingButton` 使用 store 既有方法名 `setSideBarBookKey` / `setSideBarVisible` / `setSearchBarVisible`。
