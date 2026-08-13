import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => {
  // adjustFontSize reads the live font size + the zoom range
  // (defaultFontSize as the cap, minimumFontSize as the floor) via
  // getState().getViewSettings. Configurable per-test to simulate zoomed state.
  const getViewSettingsMock =
    vi.fn<() => { defaultFontSize: number; minimumFontSize: number; effectiveFontSize?: number }>();
  getViewSettingsMock.mockReturnValue({ defaultFontSize: 18, minimumFontSize: 12 });
  return { getViewSettingsMock };
});

vi.mock('@/store/readerStore', () => {
  const useReaderStore = () => ({ hoveredBookKey: null });
  useReaderStore.getState = () => ({ getViewSettings: h.getViewSettingsMock });
  return { useReaderStore };
});

vi.mock('@/store/bookDataStore', () => {
  return {
    useBookDataStore: () => ({ getBookData: () => null }),
  };
});

vi.mock('@/utils/event', () => ({
  eventDispatcher: { dispatch: vi.fn() },
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: { getAppService: vi.fn() } }),
}));

vi.mock('@/helpers/settings', () => ({
  saveViewSettings: vi.fn(),
}));

import { useMouseEvent } from '@/app/reader/hooks/useIframeEvents';
import { saveViewSettings } from '@/helpers/settings';
import { eventDispatcher } from '@/utils/event';

function dispatchWheelMessage(bookKey: string, deltaY = 100) {
  // useMouseEvent listens on `message`, not `window.postMessage` directly,
  // so we dispatch a MessageEvent manually for synchronous delivery.
  const event = new MessageEvent('message', {
    data: { bookKey, type: 'iframe-wheel', deltaY, deltaX: 0, deltaMode: 0, ctrlKey: false },
  });
  window.dispatchEvent(event);
}

function dispatchCtrlWheel(bookKey: string, deltaY: number) {
  const event = new MessageEvent('message', {
    data: { bookKey, type: 'iframe-wheel', deltaY, deltaX: 0, deltaMode: 0, ctrlKey: true },
  });
  window.dispatchEvent(event);
}

// saveFontSizeThrottled (120ms) is a module-level singleton; let any pending
// trailing call fire so the next test's first call is immediate again.
async function flushFontThrottle() {
  await new Promise((resolve) => setTimeout(resolve, 130));
}

describe('useMouseEvent wheel handling', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    h.getViewSettingsMock.mockReturnValue({ defaultFontSize: 18, minimumFontSize: 12 });
  });

  test('wheel flip dispatches to the latest handlePageFlip after re-render', () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();

    function Wrapper({ handler }: { handler: (msg: MessageEvent) => void }) {
      // useMouseEvent has the 2nd parameter typed as a union including
      // React.MouseEvent — we cast through unknown to satisfy the typecheck
      // for this focused unit test.
      useMouseEvent('book-1', handler as unknown as Parameters<typeof useMouseEvent>[1]);
      return null;
    }

    const { rerender } = render(<Wrapper handler={fn1} />);
    // Re-render with a new handler reference. The wheel flip path should
    // pick up the latest one rather than holding onto fn1 forever.
    rerender(<Wrapper handler={fn2} />);

    dispatchWheelMessage('book-1');

    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  test('a single deliberate wheel notch flips exactly one page', () => {
    const handler = vi.fn();

    function Wrapper() {
      useMouseEvent('book-1', handler as unknown as Parameters<typeof useMouseEvent>[1]);
      return null;
    }

    render(<Wrapper />);
    dispatchWheelMessage('book-1', 120);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('tiny low-magnitude wheel events below the threshold do not flip', () => {
    const handler = vi.fn();

    function Wrapper() {
      useMouseEvent('book-1', handler as unknown as Parameters<typeof useMouseEvent>[1]);
      return null;
    }

    render(<Wrapper />);
    // A Magic Mouse light brush emits a flurry of tiny deltas; on their own
    // they must not turn a page.
    dispatchWheelMessage('book-1', 3);
    dispatchWheelMessage('book-1', 4);

    expect(handler).not.toHaveBeenCalled();
  });

  test('ctrl+wheel up at the default (the cap) does not grow the font', async () => {
    const handler = vi.fn();
    function Wrapper() {
      useMouseEvent('book-1', handler as unknown as Parameters<typeof useMouseEvent>[1]);
      return null;
    }
    render(<Wrapper />);
    // defaultFontSize=18 is the zoom cap, so an upward notch is a no-op — but
    // the overlay still surfaces the (unchanged) size.
    dispatchCtrlWheel('book-1', -50);
    expect(saveViewSettings).not.toHaveBeenCalled();
    expect(eventDispatcher.dispatch).toHaveBeenCalledWith('font-size-changed', { size: 18 });
  });

  test('ctrl+wheel down shrinks toward the minimum font size', async () => {
    const handler = vi.fn();
    function Wrapper() {
      useMouseEvent('book-1', handler as unknown as Parameters<typeof useMouseEvent>[1]);
      return null;
    }
    render(<Wrapper />);
    // A single downward notch (deltaY >= 50) shrinks the live size from 18 to 17.
    dispatchCtrlWheel('book-1', 50);
    await flushFontThrottle();
    expect(saveViewSettings).toHaveBeenCalledWith(
      expect.anything(),
      'book-1',
      'effectiveFontSize',
      17,
    );
    expect(eventDispatcher.dispatch).toHaveBeenCalledWith('font-size-changed', { size: 17 });
  });

  test('ctrl+wheel up restores toward the default after shrinking', async () => {
    h.getViewSettingsMock.mockReturnValue({
      defaultFontSize: 18,
      minimumFontSize: 12,
      effectiveFontSize: 15,
    });
    const handler = vi.fn();
    function Wrapper() {
      useMouseEvent('book-1', handler as unknown as Parameters<typeof useMouseEvent>[1]);
      return null;
    }
    render(<Wrapper />);
    // Already shrunk to 15: an upward notch recovers 1px toward the 18px cap.
    dispatchCtrlWheel('book-1', -50);
    await flushFontThrottle();
    expect(saveViewSettings).toHaveBeenCalledWith(
      expect.anything(),
      'book-1',
      'effectiveFontSize',
      16,
    );
  });

  test('ctrl+wheel down at the minimum (the floor) does not shrink further', async () => {
    h.getViewSettingsMock.mockReturnValue({
      defaultFontSize: 18,
      minimumFontSize: 12,
      effectiveFontSize: 12,
    });
    const handler = vi.fn();
    function Wrapper() {
      useMouseEvent('book-1', handler as unknown as Parameters<typeof useMouseEvent>[1]);
      return null;
    }
    render(<Wrapper />);
    // Already at the 12px floor: a downward notch is a no-op.
    dispatchCtrlWheel('book-1', 50);
    expect(saveViewSettings).not.toHaveBeenCalled();
  });
});
