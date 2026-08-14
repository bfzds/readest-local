import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Book } from '@/types/book';

const h = vi.hoisted(() => ({
  loadSettingsMock: vi.fn(),
  loadLibraryBooksMock: vi.fn(),
  setSettingsMock: vi.fn(),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    envConfig: {
      getAppService: () =>
        Promise.resolve({
          loadSettings: h.loadSettingsMock,
          loadLibraryBooks: h.loadLibraryBooksMock,
        }),
    },
  }),
}));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({ setSettings: h.setSettingsMock }),
}));

import { useLibraryStore } from '@/store/libraryStore';
import { useLibrary } from '@/hooks/useLibrary';

const makeBook = (hash: string): Book => ({
  hash,
  format: 'MD',
  title: hash,
  author: 'a',
  createdAt: 1,
  updatedAt: 1,
  primaryLanguage: 'en',
});

describe('useLibrary 订阅粒度（B4）', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    useLibraryStore.setState({
      library: [],
      libraryLoaded: false,
      isSyncing: false,
      syncProgress: 0,
      currentBookshelf: [],
      selectedBooks: new Set(),
      groups: {},
      hashIndex: new Map(),
      visibleLibrary: [],
    });
  });

  const renderCount = { n: 0 };
  const Probe = () => {
    useLibrary();
    renderCount.n++;
    return null;
  };

  it('init 加载书库', async () => {
    h.loadLibraryBooksMock.mockResolvedValue([makeBook('h')]);
    h.loadSettingsMock.mockResolvedValue({});
    render(<Probe />);
    await waitFor(() => expect(useLibraryStore.getState().library.length).toBe(1));
  });

  it('B4：阅读进度更新不触发 useLibrary 订阅组件重渲', async () => {
    h.loadLibraryBooksMock.mockResolvedValue([makeBook('h')]);
    h.loadSettingsMock.mockResolvedValue({});
    render(<Probe />);
    await waitFor(() => expect(useLibraryStore.getState().libraryLoaded).toBe(true));
    const before = renderCount.n;
    act(() => {
      useLibraryStore.getState().updateBookProgress('h', [1, 100], 'reading');
    });
    expect(renderCount.n).toBe(before);
  });

  it('对照：进度更新确实写入 store（非 store 未更新导致的假通过）', () => {
    act(() => {
      useLibraryStore.getState().setLibrary([makeBook('h')]);
      useLibraryStore.getState().updateBookProgress('h', [1, 100], 'reading');
    });
    expect(useLibraryStore.getState().visibleLibrary[0]?.progress).toEqual([1, 100]);
  });
});
