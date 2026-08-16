import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useBookShortcuts from '@/app/reader/hooks/useBookShortcuts';
import { eventDispatcher } from '@/utils/event';

const shortcutState = {
  actions: null as Record<
    string,
    ((event?: KeyboardEvent | MessageEvent) => void) | undefined
  > | null,
};

const sidebarMocks = vi.hoisted(() => ({
  isSearchBarVisible: false,
  requestSearchBarFocus: vi.fn(),
}));

const envMocks = vi.hoisted(() => ({
  isTauriAppPlatform: false,
}));

const mockView = {
  book: { dir: 'ltr' },
  prev: vi.fn(),
  next: vi.fn(),
  pan: vi.fn(),
  renderer: {
    scrolled: false,
    setAttribute: vi.fn(),
  },
  history: {
    back: vi.fn(),
    forward: vi.fn(),
  },
};

const currentViewSettings = {
  defaultFontSize: 16,
  lineHeight: 1.5,
  readingRulerEnabled: true,
  writingMode: 'horizontal-tb',
  vertical: false,
  rtl: false,
  paragraphMode: { enabled: false },
};

vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getView: () => mockView,
    getViewState: () => ({ ttsEnabled: false }),
    getViewSettings: () => currentViewSettings,
    setViewSettings: vi.fn(),
  }),
}));

vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: Object.assign(
    () => ({
      toggleSideBar: vi.fn(),
      setSideBarBookKey: vi.fn(),
    }),
    {
      getState: () => ({
        isSearchBarVisible: sidebarMocks.isSearchBarVisible,
        requestSearchBarFocus: sidebarMocks.requestSearchBarFocus,
      }),
    },
  ),
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    setSettingsDialogOpen: vi.fn(),
  }),
}));

vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getBookData: vi.fn(),
  }),
}));

vi.mock('@/store/notebookStore', () => ({
  useNotebookStore: () => ({
    toggleNotebook: vi.fn(),
  }),
}));

vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({
    safeAreaInsets: null,
  }),
}));

vi.mock('@/components/command-palette', () => ({
  useCommandPalette: () => ({
    open: vi.fn(),
  }),
}));

vi.mock('@/hooks/useShortcuts', () => ({
  default: (actions: typeof shortcutState.actions) => {
    shortcutState.actions = actions;
  },
}));

vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => envMocks.isTauriAppPlatform,
}));

vi.mock('@/utils/window', () => ({
  tauriHandleClose: vi.fn(),
  tauriHandleToggleFullScreen: vi.fn(),
  tauriQuitApp: vi.fn(),
}));

vi.mock('@/utils/style', () => ({
  getStyles: vi.fn(),
}));

vi.mock('@/services/constants', () => ({
  MAX_ZOOM_LEVEL: 200,
  MIN_ZOOM_LEVEL: 50,
  ZOOM_STEP: 10,
}));

const Harness = () => {
  useBookShortcuts({ sideBarBookKey: 'book-1', bookKeys: ['book-1'] });
  return null;
};

describe('useBookShortcuts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sidebarMocks.isSearchBarVisible = false;
    envMocks.isTauriAppPlatform = false;
    shortcutState.actions = null;
    currentViewSettings.readingRulerEnabled = true;
    currentViewSettings.writingMode = 'horizontal-tb';
    currentViewSettings.vertical = false;
    currentViewSettings.rtl = false;
    currentViewSettings.paragraphMode.enabled = false;
    mockView.book.dir = 'ltr';
  });

  afterEach(() => {
    cleanup();
  });

  it('routes page-turn shortcuts to reading ruler movement when enabled', () => {
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatchSync').mockReturnValue(true);

    render(<Harness />);
    shortcutState.actions?.['onGoNext']?.();

    expect(dispatchSpy).toHaveBeenCalledWith('reading-ruler-move', {
      bookKey: 'book-1',
      direction: 'forward',
    });
    expect(mockView.next).not.toHaveBeenCalled();
  });

  it('uses reading order when directional shortcuts are handled in rtl books', () => {
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatchSync').mockReturnValue(true);
    mockView.book.dir = 'rtl';

    render(<Harness />);
    shortcutState.actions?.['onGoRight']?.();

    expect(dispatchSpy).toHaveBeenCalledWith('reading-ruler-move', {
      bookKey: 'book-1',
      direction: 'backward',
    });
  });

  it('falls back to normal page navigation when the ruler is disabled', () => {
    currentViewSettings.readingRulerEnabled = false;

    render(<Harness />);
    shortcutState.actions?.['onGoNext']?.();

    expect(mockView.next).toHaveBeenCalledWith(72);
  });

  it('falls back to normal page navigation when the ruler cannot move further', () => {
    vi.spyOn(eventDispatcher, 'dispatchSync').mockReturnValue(false);

    render(<Harness />);
    shortcutState.actions?.['onGoNext']?.();

    expect(mockView.next).toHaveBeenCalledWith(72);
  });

  it('dispatches rsvp-start for the current book when the RSVP shortcut fires', () => {
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');

    render(<Harness />);
    shortcutState.actions?.['onStartRSVP']?.();

    expect(dispatchSpy).toHaveBeenCalledWith('rsvp-start', { bookKey: 'book-1' });
  });

  it('closes the search bar instead of the window when Ctrl+W fires while the search bar is visible', async () => {
    const { tauriHandleClose } = await import('@/utils/window');
    sidebarMocks.isSearchBarVisible = true;
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');

    render(<Harness />);
    await shortcutState.actions?.['onCloseWindow']?.();

    expect(dispatchSpy).toHaveBeenCalledWith('close-search-bar', {});
    expect(tauriHandleClose).not.toHaveBeenCalled();
  });

  it('closes the window when Ctrl+W fires while the search bar is hidden', async () => {
    const { tauriHandleClose } = await import('@/utils/window');
    envMocks.isTauriAppPlatform = true;
    sidebarMocks.isSearchBarVisible = false;
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');

    render(<Harness />);
    await shortcutState.actions?.['onCloseWindow']?.();

    expect(dispatchSpy).not.toHaveBeenCalledWith('close-search-bar', {});
    expect(tauriHandleClose).toHaveBeenCalled();
  });

  it('capture handler lets unfocused Ctrl+F fall through (focus/search handled downstream)', () => {
    sidebarMocks.isSearchBarVisible = true;
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');
    render(<Harness />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    expect(sidebarMocks.requestSearchBarFocus).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalledWith('close-search-bar', {});
  });

  it('capture handler closes the search bar on Ctrl+F when the input is focused', () => {
    sidebarMocks.isSearchBarVisible = true;
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');
    render(<Harness />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }));
    expect(dispatchSpy).toHaveBeenCalledWith('close-search-bar', {});
    document.body.removeChild(input);
  });

  it('capture handler closes the search bar on Ctrl+W when it is visible', () => {
    sidebarMocks.isSearchBarVisible = true;
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');
    render(<Harness />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }));
    expect(dispatchSpy).toHaveBeenCalledWith('close-search-bar', {});
  });

  it('capture handler does not intercept Ctrl+W when the search bar is hidden', () => {
    sidebarMocks.isSearchBarVisible = false;
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');
    render(<Harness />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }));
    expect(dispatchSpy).not.toHaveBeenCalledWith('close-search-bar', {});
  });
});
