import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

// useWindowActiveChanged subscribes to the desktop window-focus path; capture
// the focus listeners so tests can drive re-scans.
const focusHandlers: ((p: { payload: boolean }) => void)[] = [];
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onFocusChanged: (cb: (p: { payload: boolean }) => void) => {
      focusHandlers.push(cb);
      return Promise.resolve(vi.fn());
    },
  }),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: {} }),
}));

import { useAutoImportFolders } from '@/app/library/hooks/useAutoImportFolders';

const DEBOUNCE_MS = 800;

// Let the async window-active subscription settle so its listener is attached.
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  focusHandlers.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useAutoImportFolders', () => {
  test('scans once on mount after the debounce window', async () => {
    const scan = vi.fn(async () => {});
    renderHook(() =>
      useAutoImportFolders({ enabled: true, folders: ['/books'], scanAndImport: scan }),
    );
    await settle();
    expect(scan).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledWith(['/books']);
  });

  test('does not scan when disabled', async () => {
    const scan = vi.fn(async () => {});
    renderHook(() =>
      useAutoImportFolders({ enabled: false, folders: ['/books'], scanAndImport: scan }),
    );
    await settle();
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(scan).not.toHaveBeenCalled();
  });

  test('does not scan when there are no folders', async () => {
    const scan = vi.fn(async () => {});
    renderHook(() => useAutoImportFolders({ enabled: true, folders: [], scanAndImport: scan }));
    await settle();
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(scan).not.toHaveBeenCalled();
  });

  test('re-scans when the window regains focus', async () => {
    const scan = vi.fn(async () => {});
    renderHook(() =>
      useAutoImportFolders({ enabled: true, folders: ['/books'], scanAndImport: scan }),
    );
    await settle();
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(scan).toHaveBeenCalledTimes(1);
    await act(async () => {
      focusHandlers.forEach((cb) => cb({ payload: true }));
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(scan).toHaveBeenCalledTimes(2);
  });

  test('coalesces triggers while a scan is in flight', async () => {
    let resolveScan: () => void = () => {};
    const scan = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveScan = r;
        }),
    );
    renderHook(() =>
      useAutoImportFolders({ enabled: true, folders: ['/books'], scanAndImport: scan }),
    );
    await settle();
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(scan).toHaveBeenCalledTimes(1); // pending
    await act(async () => {
      focusHandlers.forEach((cb) => cb({ payload: true }));
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(scan).toHaveBeenCalledTimes(1); // still in flight -> no second run
    await act(async () => {
      resolveScan();
      await Promise.resolve();
    });
    await act(async () => {
      focusHandlers.forEach((cb) => cb({ payload: true }));
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(scan).toHaveBeenCalledTimes(2);
  });
});
