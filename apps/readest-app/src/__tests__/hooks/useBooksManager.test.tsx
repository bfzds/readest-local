import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { eventDispatcher } from '@/utils/event';

// initViewState rejects with "Book not found" when a library reload drops the
// in-memory entry (readerStore). openBookInReader calls it
// fire-and-forget, so the rejection surfaced as an unhandled rejection
// (READEST-1V). The hook must catch it and surface a toast instead.
const h = vi.hoisted(() => ({
  initViewStateMock: vi.fn(() => Promise.resolve()),
  setBookKeysMock: vi.fn(),
  setSideBarBookKeyMock: vi.fn(),
  clearViewStateMock: vi.fn(),
  getViewMock: vi.fn<(key: string) => { close?: () => void } | null>(() => null),
  bookKeys: [] as string[],
  viewStates: {} as Record<string, { inited: boolean; view: object }>,
  library: [] as { hash: string }[],
  // Parsed-book data keyed by hash. Side-button switching skips history books
  // whose data is gone (a deleted book clears its entry via clearBookData), so
  // tests populate this for the books they expect to switch to.
  bookDataMap: {} as Record<string, object>,
  // Reader search-bar interlock state (see useBooksManager onBack/onForward).
  isSearchBarVisible: false,
  isSideBarPinned: false,
  setSearchBarVisibleMock: vi.fn(),
  setSideBarVisibleMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => ({ toString: () => '' }),
}));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {} }),
}));
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: Object.assign(
    () => ({
      bookKeys: h.bookKeys,
      setBookKeys: h.setBookKeysMock,
      initViewState: h.initViewStateMock,
    }),
    {
      getState: () => ({
        getView: h.getViewMock,
        clearViewState: h.clearViewStateMock,
        setPreviewMode: vi.fn(),
        viewStates: h.viewStates,
        bookKeys: h.bookKeys,
      }),
      subscribe: () => () => {},
    },
  ),
}));
vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: Object.assign(
    () => ({ sideBarBookKey: null, setSideBarBookKey: h.setSideBarBookKeyMock }),
    {
      getState: () => ({
        isSearchBarVisible: h.isSearchBarVisible,
        isSideBarPinned: h.isSideBarPinned,
        setSearchBarVisible: h.setSearchBarVisibleMock,
        setSideBarVisible: h.setSideBarVisibleMock,
      }),
    },
  ),
}));
vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: Object.assign(() => ({ library: h.library }), {
    getState: () => ({ library: h.library }),
  }),
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: Object.assign(() => ({ booksData: {} }), {
    getState: () => ({
      getBookData: (key: string) => h.bookDataMap[key.split('-')[0]!] ?? null,
      clearBookData: (key: string) => {
        delete h.bookDataMap[key.split('-')[0]!];
      },
    }),
  }),
}));
vi.mock('@/utils/nav', () => ({ navigateToReader: vi.fn() }));

import useBooksManager from '@/app/reader/hooks/useBooksManager';
import { setPendingTTSAutoplay } from '@/utils/ttsAutoplay';
import { useBookDataStore } from '@/store/bookDataStore';

describe('useBooksManager open-failure handling', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.getViewMock.mockReset();
    h.bookKeys = [];
    h.viewStates = {};
    h.bookDataMap = {};
    h.isSearchBarVisible = false;
    h.isSideBarPinned = false;
    setPendingTTSAutoplay(null);
  });

  it('toasts instead of leaking an unhandled rejection when the book is missing (READEST-1V)', async () => {
    h.initViewStateMock.mockReturnValueOnce(Promise.reject(new Error('Book not found')));
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');

    renderHook(() => useBooksManager());

    await act(async () => {
      eventDispatcher.dispatch('open-book-in-reader', { bookHash: 'missing-hash' });
      // Flush the rejected initViewState microtask chain.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dispatchSpy).toHaveBeenCalledWith('toast', expect.objectContaining({ type: 'error' }));
    dispatchSpy.mockRestore();
  });

  // Cold-restore autoplay: the app relaunches straight into the reader with the
  // target book ALREADY mounted, and the `readest://book/{hash}?autoplay=tts`
  // deep link lands after the mount-time consumption effect has run. The
  // open-book-in-reader dispatch then hits the "existing" branch, which only
  // focuses the book — bookKeys never changes, so without consuming there the
  // pending autoplay is dropped and read-aloud never starts.
  it('starts TTS for an autoplay deep link when the book is already open', async () => {
    h.bookKeys = ['hash1-abc'];
    h.viewStates = { 'hash1-abc': { inited: true, view: {} } };
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');

    renderHook(() => useBooksManager());

    await act(async () => {
      // Deep link arrives after mount (library hydration finished late).
      setPendingTTSAutoplay('hash1');
      eventDispatcher.dispatch('open-book-in-reader', { bookHash: 'hash1' });
      await Promise.resolve();
    });

    expect(dispatchSpy).toHaveBeenCalledWith('tts-speak', { bookKey: 'hash1-abc' });
    dispatchSpy.mockRestore();
  });

  it('mouse nav back steps through the session read history', async () => {
    h.bookKeys = ['book2-abc'];
    h.bookDataMap = { book2: { hash: 'book2' }, book3: { hash: 'book3' } };
    renderHook(() => useBooksManager());
    // Open book3 — read history becomes [book2, book3], current = book3.
    await act(async () => {
      eventDispatcher.dispatch('open-book-in-reader', { bookHash: 'book3' });
      await Promise.resolve();
    });
    // Back → previous history entry (book2), already open → focus it.
    h.setSideBarBookKeyMock.mockClear();
    await act(async () => {
      eventDispatcher.dispatch('library-nav-back');
      await Promise.resolve();
    });
    expect(h.setSideBarBookKeyMock).toHaveBeenCalled();
  });

  it('mouse nav forward advances through the session read history', async () => {
    h.bookKeys = ['book2-abc'];
    h.bookDataMap = { book2: { hash: 'book2' }, book3: { hash: 'book3' } };
    renderHook(() => useBooksManager());
    // History [book2, book3]; step back to book2, then forward returns to book3.
    await act(async () => {
      eventDispatcher.dispatch('open-book-in-reader', { bookHash: 'book3' });
      await Promise.resolve();
      eventDispatcher.dispatch('library-nav-back');
      await Promise.resolve();
    });
    h.initViewStateMock.mockClear();
    await act(async () => {
      eventDispatcher.dispatch('library-nav-forward');
      await Promise.resolve();
    });
    expect(h.initViewStateMock).toHaveBeenCalledWith(
      expect.anything(),
      'book3',
      expect.any(String),
      true,
    );
  });

  it('换书时释放旧 viewState（B2）', async () => {
    h.bookKeys = ['hash1-abc'];
    h.viewStates = { 'hash1-abc': { inited: true, view: {} } };
    const closeMock = vi.fn();
    h.getViewMock.mockReturnValue({ close: closeMock });

    renderHook(() => useBooksManager());

    await act(async () => {
      eventDispatcher.dispatch('open-book-in-reader', { bookHash: 'hash2' });
      await Promise.resolve();
    });

    expect(h.clearViewStateMock).toHaveBeenCalledWith('hash1-abc');
    expect(closeMock).toHaveBeenCalled();
  });

  it('每次换书都清理当前旧 key（B2）', async () => {
    h.bookKeys = ['book-a'];
    renderHook(() => useBooksManager());
    for (const hash of ['book-b', 'book-c']) {
      await act(async () => {
        eventDispatcher.dispatch('open-book-in-reader', { bookHash: hash });
        await Promise.resolve();
      });
    }
    expect(h.clearViewStateMock).toHaveBeenCalledWith('book-a');
    expect(h.clearViewStateMock).toHaveBeenCalledTimes(2);
  });

  // 侧键切书的历史可能残留已删除的书（Plan A 复用 reader 窗口，关闭书籍只隐藏
  // 窗口、组件不卸载）。删除书会清除其 bookData，切书时必须跳过这种书，否则会
  // 尝试重新加载一本 "Book not found" 的书。
  it('侧键切书跳过已删除（bookData 已被清）的书，不触发 Book not found', async () => {
    h.bookKeys = ['book2-abc'];
    h.bookDataMap = { book2: { hash: 'book2' }, book3: { hash: 'book3' } };
    renderHook(() => useBooksManager());
    // 打开 book3 → 会话历史 [book2, book3]，当前 = book3
    await act(async () => {
      eventDispatcher.dispatch('open-book-in-reader', { bookHash: 'book3' });
      await Promise.resolve();
    });
    // book2 已从 reader 卸载（bookKeys 只剩 book3）
    h.bookKeys = ['book3-xyz'];
    // 在书库删除 book2：清除其 bookData
    useBookDataStore.getState().clearBookData('book2');
    h.initViewStateMock.mockClear();
    h.setSideBarBookKeyMock.mockClear();
    // 侧键后退：book2 已删应被跳过 → 无操作，不报错
    await act(async () => {
      eventDispatcher.dispatch('library-nav-back');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.initViewStateMock).not.toHaveBeenCalled();
    expect(h.setSideBarBookKeyMock).not.toHaveBeenCalled();
  });

  // 只要历史书仍有效（未被删除），侧键切书依旧可用——本会话内连续读过多本书时
  // 后退切回之前那本仍应成功。
  it('有效的历史书仍可被侧键切回（跳过逻辑不误伤）', async () => {
    h.bookKeys = ['book2-abc'];
    h.bookDataMap = { book2: { hash: 'book2' }, book3: { hash: 'book3' } };
    renderHook(() => useBooksManager());
    await act(async () => {
      eventDispatcher.dispatch('open-book-in-reader', { bookHash: 'book3' });
      await Promise.resolve();
    });
    h.bookKeys = ['book3-xyz'];
    h.setSideBarBookKeyMock.mockClear();
    await act(async () => {
      eventDispatcher.dispatch('library-nav-back');
      await Promise.resolve();
      await Promise.resolve();
    });
    // book2 数据仍存在 → 走 existing 分支 focus 它
    expect(h.setSideBarBookKeyMock).toHaveBeenCalled();
  });

  // 侧键切回较早的书（navIndex 回移）后再打开新书时，历史不能被截断成
  // "切回点之前的书 + 新书"（只剩两本可切）。打开新书应把历史当成一个保留
  // 全部已读书的列表（去重后 append 到末尾），而不是浏览器式的前进栈截断。
  it('侧键切回较早的书后打开新书，历史不被截断（切书范围保留）', async () => {
    h.bookKeys = ['book1-abc'];
    h.bookDataMap = { book1: {}, book2: {}, book3: {}, book4: {} };
    renderHook(() => useBooksManager());
    // 打开 book2、book3 → 历史 [book1, book2, book3]
    await act(async () => {
      eventDispatcher.dispatch('open-book-in-reader', { bookHash: 'book2' });
      await Promise.resolve();
    });
    await act(async () => {
      eventDispatcher.dispatch('open-book-in-reader', { bookHash: 'book3' });
      await Promise.resolve();
    });
    // 侧键后退切回 book2（navIndex 从 2 移到 1）
    await act(async () => {
      eventDispatcher.dispatch('library-nav-back');
      await Promise.resolve();
    });
    // 打开新书 book4 → 历史应保留全部已读书而非截断
    await act(async () => {
      eventDispatcher.dispatch('open-book-in-reader', { bookHash: 'book4' });
      await Promise.resolve();
    });
    h.initViewStateMock.mockClear();
    // 从 book4 后退应切到 book3（被截断的话只会切到切回点 book1）
    await act(async () => {
      eventDispatcher.dispatch('library-nav-back');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(h.initViewStateMock).toHaveBeenCalledWith(
      expect.anything(),
      'book3',
      expect.any(String),
      true,
    );
  });

  it('back side-nav hides the search bar instead of switching books while it is visible', async () => {
    h.bookKeys = ['book2-abc'];
    h.bookDataMap = { book2: { hash: 'book2' }, book3: { hash: 'book3' } };
    h.isSearchBarVisible = true;
    renderHook(() => useBooksManager());
    await act(async () => {
      eventDispatcher.dispatch('open-book-in-reader', { bookHash: 'book3' });
      await Promise.resolve();
    });
    h.setSideBarBookKeyMock.mockClear();
    await act(async () => {
      eventDispatcher.dispatch('library-nav-back');
      await Promise.resolve();
    });
    expect(h.setSearchBarVisibleMock).toHaveBeenCalledWith(false);
    expect(h.setSideBarVisibleMock).toHaveBeenCalledWith(false);
    expect(h.setSideBarBookKeyMock).not.toHaveBeenCalled();
  });
});
