import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(),
  getAllWindows: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn().mockResolvedValue(undefined),
  TauriEvent: { WINDOW_FOCUS: 'tauri://focus' },
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  exit: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-os', () => ({
  type: vi.fn(),
}));

vi.mock('@/utils/event', () => ({
  eventDispatcher: { dispatch: vi.fn() },
}));

import { getCurrentWindow, getAllWindows } from '@tauri-apps/api/window';
import { type as osType } from '@tauri-apps/plugin-os';
import {
  formatAppWindowTitle,
  tauriHandleOnCloseMainWindow,
  tauriHandleOnCloseWindow,
  tauriHandleToggleFullScreen,
  tauriSetWindowTitle,
} from '@/utils/window';

type CloseHandler = (event: { preventDefault: () => void }) => Promise<void> | void;

function makeWindow(label: string) {
  let registered: CloseHandler | undefined;
  const win = {
    label,
    destroy: vi.fn().mockResolvedValue(undefined),
    hide: vi.fn().mockResolvedValue(undefined),
    onCloseRequested: vi.fn().mockImplementation((handler: CloseHandler) => {
      registered = handler;
      return Promise.resolve(() => {});
    }),
  };
  const trigger = async () => {
    if (!registered) throw new Error('no handler registered');
    await registered({ preventDefault: vi.fn() });
  };
  return { win, trigger };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

describe('tauriHandleOnCloseWindow', () => {
  test('on macOS, leaves the main window alone — no book cleanup, no destroy', async () => {
    // Rust hide-on-close handler hides the window; the user expects the active
    // book to still be loaded when they bring the window back.
    vi.mocked(osType).mockReturnValue('macos');
    const { win, trigger } = makeWindow('main');
    vi.mocked(getCurrentWindow).mockReturnValue(
      win as unknown as ReturnType<typeof getCurrentWindow>,
    );

    const callback = vi.fn();
    await tauriHandleOnCloseWindow(callback);
    await trigger();

    expect(callback).not.toHaveBeenCalled();
    expect(win.destroy).not.toHaveBeenCalled();
  });

  test('on Windows, destroys the main window', async () => {
    vi.mocked(osType).mockReturnValue('windows');
    const { win, trigger } = makeWindow('main');
    vi.mocked(getCurrentWindow).mockReturnValue(
      win as unknown as ReturnType<typeof getCurrentWindow>,
    );

    const callback = vi.fn();
    await tauriHandleOnCloseWindow(callback);
    await trigger();

    expect(win.destroy).toHaveBeenCalled();
  });

  test('on Linux, destroys the main window', async () => {
    vi.mocked(osType).mockReturnValue('linux');
    const { win, trigger } = makeWindow('main');
    vi.mocked(getCurrentWindow).mockReturnValue(
      win as unknown as ReturnType<typeof getCurrentWindow>,
    );

    const callback = vi.fn();
    await tauriHandleOnCloseWindow(callback);
    await trigger();

    expect(win.destroy).toHaveBeenCalled();
  });

  test('on macOS, reader windows destroy after the save completes (no fixed 500ms grace)', async () => {
    vi.mocked(osType).mockReturnValue('macos');
    const { win, trigger } = makeWindow('reader-0');
    vi.mocked(getCurrentWindow).mockReturnValue(
      win as unknown as ReturnType<typeof getCurrentWindow>,
    );

    const callback = vi.fn();
    await tauriHandleOnCloseWindow(callback);
    await trigger();
    await vi.advanceTimersByTimeAsync(0); // flush the finish microtask chain

    expect(callback).toHaveBeenCalled();
    expect(win.destroy).toHaveBeenCalled();
  });

  test('on macOS, a hung save still destroys the reader window via timeout fallback', async () => {
    vi.mocked(osType).mockReturnValue('macos');
    const { win, trigger } = makeWindow('reader-0');
    vi.mocked(getCurrentWindow).mockReturnValue(
      win as unknown as ReturnType<typeof getCurrentWindow>,
    );

    let resolveSave: (() => void) | undefined;
    const callback = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    await tauriHandleOnCloseWindow(callback);
    await trigger();

    // 保存挂起 → 短时内不销毁（不再有固定 500ms 宽限提前销毁）
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolveSave).toBeDefined();
    expect(win.destroy).not.toHaveBeenCalled();
    // 超时兜底（SAVE_DESTROY_TIMEOUT_MS=5000）→ 销毁，防止窗口残留
    await vi.advanceTimersByTimeAsync(5000);
    expect(win.destroy).toHaveBeenCalled();
  });
});

describe('tauriHandleOnCloseMainWindow', () => {
  type ReaderWindow = ReturnType<typeof makeReaderWindow>;

  function makeReaderWindow(label: string, visible: boolean) {
    return {
      label,
      isVisible: vi.fn().mockResolvedValue(visible),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
  }

  function makeMainWindow() {
    let registered: CloseHandler | undefined;
    const win = {
      label: 'main',
      hide: vi.fn().mockResolvedValue(undefined),
      onCloseRequested: vi.fn().mockImplementation((handler: CloseHandler) => {
        registered = handler;
        return Promise.resolve(() => {});
      }),
    };
    const preventDefault = vi.fn();
    const trigger = async () => {
      if (!registered) throw new Error('no handler registered');
      await registered({ preventDefault });
    };
    return { win, trigger, preventDefault };
  }

  const mockReaders = (readers: ReaderWindow[]) =>
    vi
      .mocked(getAllWindows)
      .mockResolvedValue(readers as unknown as Awaited<ReturnType<typeof getAllWindows>>);

  beforeEach(() => {
    vi.mocked(getAllWindows).mockResolvedValue([]);
  });

  test('on Windows with a visible reader, hides the library instead of closing it', async () => {
    vi.mocked(osType).mockReturnValue('windows');
    const { win, trigger, preventDefault } = makeMainWindow();
    vi.mocked(getCurrentWindow).mockReturnValue(
      win as unknown as ReturnType<typeof getCurrentWindow>,
    );
    mockReaders([makeReaderWindow('reader', true)]);

    await tauriHandleOnCloseMainWindow();
    await trigger();

    expect(preventDefault).toHaveBeenCalled();
    expect(win.hide).toHaveBeenCalled();
  });

  test('on Windows with no reader open, lets the library close and destroys a leftover hidden reader', async () => {
    vi.mocked(osType).mockReturnValue('windows');
    const { win, trigger, preventDefault } = makeMainWindow();
    vi.mocked(getCurrentWindow).mockReturnValue(
      win as unknown as ReturnType<typeof getCurrentWindow>,
    );
    const hiddenReader = makeReaderWindow('reader', false);
    mockReaders([hiddenReader]);

    await tauriHandleOnCloseMainWindow();
    await trigger();

    expect(preventDefault).not.toHaveBeenCalled();
    expect(win.hide).not.toHaveBeenCalled();
    expect(hiddenReader.destroy).toHaveBeenCalled();
  });

  test('on macOS, does not intercept (Rust close-to-hide owns the main window)', async () => {
    vi.mocked(osType).mockReturnValue('macos');
    const { win, trigger, preventDefault } = makeMainWindow();
    vi.mocked(getCurrentWindow).mockReturnValue(
      win as unknown as ReturnType<typeof getCurrentWindow>,
    );
    const hiddenReader = makeReaderWindow('reader', true);
    mockReaders([hiddenReader]);

    await tauriHandleOnCloseMainWindow();
    await trigger();

    expect(preventDefault).not.toHaveBeenCalled();
    expect(win.hide).not.toHaveBeenCalled();
    expect(hiddenReader.destroy).not.toHaveBeenCalled();
  });
});

function makeFullscreenWindow({
  isFullscreen,
  isMaximized,
}: {
  isFullscreen: boolean;
  isMaximized: boolean;
}) {
  return {
    isFullscreen: vi.fn().mockResolvedValue(isFullscreen),
    isMaximized: vi.fn().mockResolvedValue(isMaximized),
    setFullscreen: vi.fn().mockResolvedValue(undefined),
    unmaximize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    innerSize: vi.fn().mockResolvedValue({ width: 800, height: 600 }),
    setSize: vi.fn().mockResolvedValue(undefined),
  };
}

describe('tauriHandleToggleFullScreen', () => {
  test('enters fullscreen when the window is maximized (Phosh / Windows-maximized case)', async () => {
    // On Phosh the window is always maximized, and on Windows users often run
    // maximized. The fullscreen button must still enter fullscreen instead of
    // just unmaximizing the window (issue #4034).
    vi.mocked(osType).mockReturnValue('linux');
    const win = makeFullscreenWindow({ isFullscreen: false, isMaximized: true });
    vi.mocked(getCurrentWindow).mockReturnValue(
      win as unknown as ReturnType<typeof getCurrentWindow>,
    );

    await tauriHandleToggleFullScreen();

    expect(win.setFullscreen).toHaveBeenCalledWith(true);
  });

  test('exits fullscreen when already fullscreen', async () => {
    vi.mocked(osType).mockReturnValue('windows');
    const win = makeFullscreenWindow({ isFullscreen: true, isMaximized: false });
    vi.mocked(getCurrentWindow).mockReturnValue(
      win as unknown as ReturnType<typeof getCurrentWindow>,
    );

    await tauriHandleToggleFullScreen();

    expect(win.setFullscreen).toHaveBeenCalledWith(false);
  });

  test('enters fullscreen when neither maximized nor fullscreen', async () => {
    vi.mocked(osType).mockReturnValue('macos');
    const win = makeFullscreenWindow({ isFullscreen: false, isMaximized: false });
    vi.mocked(getCurrentWindow).mockReturnValue(
      win as unknown as ReturnType<typeof getCurrentWindow>,
    );

    await tauriHandleToggleFullScreen();

    expect(win.setFullscreen).toHaveBeenCalledWith(true);
  });
});

describe('formatAppWindowTitle', () => {
  test('names the open book so windows are distinguishable in Alt+Tab', () => {
    expect(formatAppWindowTitle('The Hobbit')).toBe('Readest - The Hobbit');
  });

  test('falls back to the app name when no book is open', () => {
    expect(formatAppWindowTitle()).toBe('Readest');
    expect(formatAppWindowTitle('')).toBe('Readest');
  });

  test('ignores a blank book title', () => {
    expect(formatAppWindowTitle('   ')).toBe('Readest');
  });

  test('trims the book title', () => {
    expect(formatAppWindowTitle('  The Hobbit \n')).toBe('Readest - The Hobbit');
  });
});

describe('tauriSetWindowTitle', () => {
  function makeTitledWindow() {
    const win = { setTitle: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(getCurrentWindow).mockReturnValue(
      win as unknown as ReturnType<typeof getCurrentWindow>,
    );
    return win;
  }

  test('titles the calling window after the open book', async () => {
    const win = makeTitledWindow();

    await tauriSetWindowTitle('The Hobbit');

    expect(win.setTitle).toHaveBeenCalledWith('Readest - The Hobbit');
  });

  test('resets to the app name when no book is open', async () => {
    const win = makeTitledWindow();

    await tauriSetWindowTitle();

    expect(win.setTitle).toHaveBeenCalledWith('Readest');
  });
});
