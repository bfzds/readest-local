import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react';
import { BookSearchMatch } from '@/types/book';
import { useSidebarStore } from '@/store/sidebarStore';

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService: { hasRoundedWindow: false } }),
}));
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: { globalReadSettings: {}, globalViewSettings: {} },
  }),
}));
vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({
    updateAppTheme: vi.fn(),
    safeAreaInsets: {},
    systemUIVisible: false,
    statusBarHeight: 0,
  }),
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getView: () => ({ clearSearch: vi.fn() }),
    getViewSettings: () => ({}),
    setHoveredBookKey: vi.fn(),
  }),
}));
vi.mock('@/store/bookDataStore', () => {
  const state = {
    getBookData: () => ({ book: {}, bookDoc: { metadata: { language: 'en' }, toc: [] } }),
    getConfig: () => ({ viewSettings: { sideBarTab: 'toc' } }),
    setConfig: vi.fn(),
  };
  return {
    useBookDataStore: (selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state,
  };
});
vi.mock('@/helpers/settings', () => ({ saveSysSettings: vi.fn() }));
vi.mock('@/utils/focus', () => ({ blurActiveElement: vi.fn() }));
vi.mock('@/utils/book', () => ({ getBookDirFromLanguage: () => 'ltr' }));
vi.mock('@/utils/insets', () => ({ getPanelTopInset: () => 0 }));
vi.mock('@/hooks/useSwipeToDismiss', () => ({
  useSwipeToDismiss: () => ({
    panelRef: { current: null },
    overlayRef: { current: null },
    panelHeight: { current: 0 },
    handleVerticalDragStart: vi.fn(),
  }),
}));
vi.mock('@/hooks/usePanelResize', () => ({
  usePanelResize: () => ({ handleResizeStart: vi.fn(), handleResizeKeyDown: vi.fn() }),
}));
vi.mock('@/hooks/useShortcuts', () => ({ default: () => {} }));

// useSidebar pulled fresh from the real store so the SideBar responds to the
// state changes this test drives (mirrors the real hook's live subscription).
vi.mock('@/app/reader/hooks/useSidebar', async () => {
  const { useSidebarStore } = await import('@/store/sidebarStore');
  return {
    default: () => ({
      sideBarWidth: '300px',
      isSideBarPinned: false,
      isSideBarVisible: useSidebarStore((s) => s.isSideBarVisible),
      getSideBarWidth: () => '300px',
      handleSideBarResize: vi.fn(),
      handleSideBarTogglePin: vi.fn(),
      setSideBarVisible: vi.fn(),
      toggleSideBar: vi.fn(),
    }),
  };
});

// Stub the heavy children so this test focuses on the SideBar's decision of
// which panel (TOC vs search results) it renders.
vi.mock('@/app/reader/components/sidebar/Header', () => ({ default: () => null }));
vi.mock('@/app/reader/components/sidebar/Content', () => ({
  default: () => <div data-testid='sidebar-content' />,
}));
vi.mock('@/app/reader/components/sidebar/BookCard', () => ({ default: () => null }));
vi.mock('@/app/reader/components/sidebar/SearchBar', () => ({
  default: () => <div data-testid='search-bar' />,
}));
vi.mock('@/app/reader/components/sidebar/SearchResults', () => ({
  default: () => <div data-testid='search-results' />,
}));

import TOCFloatingButton from '@/app/reader/components/TOCFloatingButton';
import SideBar from '@/app/reader/components/sidebar/SideBar';

beforeEach(() => {
  useSidebarStore.setState({
    sideBarBookKey: null,
    sideBarWidth: '300px',
    isSideBarVisible: false,
    isSideBarPinned: false,
    isSearchBarVisible: false,
    searchBarFocusToken: 0,
    searchNavStates: {},
    booknotesNavStates: {},
    searchStatuses: {},
  });
});

afterEach(() => cleanup());

describe('TOC after in-book search (regression)', () => {
  it('shows the TOC panel instead of stale search results when re-opening the TOC', () => {
    const results: BookSearchMatch[] = [
      { cfi: 'cfi1', excerpt: { pre: '', match: 'foo', post: '' } },
    ];

    const sb = () => useSidebarStore.getState();
    sb().setSideBarBookKey('book-1');
    sb().setSideBarVisible(true);

    render(
      <>
        <TOCFloatingButton bookKey='book-1' />
        <SideBar />
      </>,
    );

    // 1. Sidebar currently shows the TOC panel.
    expect(screen.getByTestId('sidebar-content')).toBeTruthy();

    // 2. The user searches for some text; the search panel takes over.
    act(() => {
      sb().setSearchBarVisible(true);
      sb().setSearchResults('book-1', results);
    });
    expect(screen.getByTestId('search-results')).toBeTruthy();
    expect(screen.queryByTestId('sidebar-content')).toBeNull();

    // 3. The user closes the sidebar (leaving the search state untouched) and
    //    re-opens the TOC through the floating TOC button.
    act(() => {
      sb().setSideBarVisible(false);
    });
    fireEvent.click(screen.getByLabelText('Table of Contents'));

    // 4. Expect the TOC panel, not the stale search panel, to be shown.
    expect(screen.getByTestId('sidebar-content')).toBeTruthy();
  });
});
