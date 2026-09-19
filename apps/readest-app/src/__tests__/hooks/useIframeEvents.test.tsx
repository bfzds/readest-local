import { describe, test, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const h = vi.hoisted(() => {
  // adjustFontSize reads the live font size + the zoom range
  // ([minimumFontSize, min(defaultFontSize × 1.5, 120)]; the configured default
  // anchors the band but is never rewritten) via getState().getViewSettings.
  // Configurable per-test to simulate zoomed state.
  const getViewSettingsMock =
    vi.fn<() => { defaultFontSize: number; minimumFontSize: number; effectiveFontSize?: number }>();
  getViewSettingsMock.mockReturnValue({ defaultFontSize: 18, minimumFontSize: 12 });
  // getBookData decides the Ctrl+wheel routing: null / reflowable book → font
  // size, { isFixedLayout: true } → page zoom events. Configurable per-test.
  const getBookDataMock = vi.fn<() => { isFixedLayout: boolean } | null>();
  getBookDataMock.mockReturnValue(null);
  return { getViewSettingsMock, getBookDataMock };
});

vi.mock('@/store/readerStore', () => {
  const useReaderStore = () => ({ hoveredBookKey: null });
  useReaderStore.getState = () => ({ getViewSettings: h.getViewSettingsMock });
  return { useReaderStore };
});

vi.mock('@/store/bookDataStore', () => {
  return {
    useBookDataStore: () => ({ getBookData: h.getBookDataMock }),
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
    h.getBookDataMock.mockReturnValue(null);
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

  test('ctrl+wheel up at the default grows the font past the default', async () => {
    const handler = vi.fn();
    function Wrapper() {
      useMouseEvent('book-1', handler as unknown as Parameters<typeof useMouseEvent>[1]);
      return null;
    }
    render(<Wrapper />);
    // Semantics change (upstream-absorption plan §2.1): the wheel band's top is
    // no longer defaultFontSize but defaultFontSize × 1.5, so an upward notch
    // at the default grows the live size to 19. The configured default itself
    // must never be rewritten — only effectiveFontSize may be persisted.
    dispatchCtrlWheel('book-1', -50);
    await flushFontThrottle();
    expect(saveViewSettings).toHaveBeenCalledWith(
      expect.anything(),
      'book-1',
      'effectiveFontSize',
      19,
    );
    expect(saveViewSettings).not.toHaveBeenCalledWith(
      expect.anything(),
      'book-1',
      'defaultFontSize',
      expect.anything(),
    );
    expect(eventDispatcher.dispatch).toHaveBeenCalledWith('font-size-changed', { size: 19 });
  });

  test('ctrl+wheel up clamps at the 1.5x live ceiling above the default', async () => {
    h.getViewSettingsMock.mockReturnValue({
      defaultFontSize: 18,
      minimumFontSize: 12,
      effectiveFontSize: 26,
    });
    const handler = vi.fn();
    function Wrapper() {
      useMouseEvent('book-1', handler as unknown as Parameters<typeof useMouseEvent>[1]);
      return null;
    }
    render(<Wrapper />);
    // hi = 18 × 1.5 = 27: one more upward notch pins the live size at the band
    // top; a further one cannot exceed it.
    dispatchCtrlWheel('book-1', -50);
    await flushFontThrottle();
    expect(saveViewSettings).toHaveBeenCalledWith(
      expect.anything(),
      'book-1',
      'effectiveFontSize',
      27,
    );
    dispatchCtrlWheel('book-1', -50);
    await flushFontThrottle();
    expect(eventDispatcher.dispatch).toHaveBeenCalledWith('font-size-changed', { size: 27 });
  });

  test('ctrl+wheel up is hard-capped at MAX_FONT_SIZE (120px)', async () => {
    h.getViewSettingsMock.mockReturnValue({
      defaultFontSize: 100,
      minimumFontSize: 12,
      effectiveFontSize: 119,
    });
    const handler = vi.fn();
    function Wrapper() {
      useMouseEvent('book-1', handler as unknown as Parameters<typeof useMouseEvent>[1]);
      return null;
    }
    render(<Wrapper />);
    // 100 × 1.5 = 150 exceeds the absolute MAX_FONT_SIZE cap: the band top is
    // 120, so the step from 119 pins there.
    dispatchCtrlWheel('book-1', -50);
    await flushFontThrottle();
    expect(saveViewSettings).toHaveBeenCalledWith(
      expect.anything(),
      'book-1',
      'effectiveFontSize',
      120,
    );
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
    // Already shrunk to 15: an upward notch recovers 1px toward the 18px anchor.
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

  test('ctrl+wheel on a fixed-layout book routes to page zoom, not font size', () => {
    h.getBookDataMock.mockReturnValue({ isFixedLayout: true });
    const handler = vi.fn();
    function Wrapper() {
      useMouseEvent('book-1', handler as unknown as Parameters<typeof useMouseEvent>[1]);
      return null;
    }
    render(<Wrapper />);
    // Upstream-absorption plan §2.2: font size is meaningless for fixed-layout
    // books (PDF/comics), so the wheel reroutes to the existing zoom-in /
    // zoom-out events (applied by useBookShortcuts). Factor follows the
    // upstream behavior reference: one notch (deltaY≈100) maps to one
    // ZOOM_STEP (10%).
    dispatchCtrlWheel('book-1', 100);
    expect(eventDispatcher.dispatch).toHaveBeenCalledWith('zoom-out', { factor: 1 });
    dispatchCtrlWheel('book-1', -120);
    expect(eventDispatcher.dispatch).toHaveBeenCalledWith('zoom-in', { factor: 1.2 });
    // The font-size path must not fire at all: no overlay event, no persist.
    expect(eventDispatcher.dispatch).not.toHaveBeenCalledWith(
      'font-size-changed',
      expect.anything(),
    );
    expect(saveViewSettings).not.toHaveBeenCalled();
  });

  test('ctrl+wheel on a reflowable book keeps the font-size path (no zoom events)', () => {
    const handler = vi.fn();
    function Wrapper() {
      useMouseEvent('book-1', handler as unknown as Parameters<typeof useMouseEvent>[1]);
      return null;
    }
    render(<Wrapper />);
    // Reflowable routing is unchanged by the fixed-layout split.
    dispatchCtrlWheel('book-1', -50);
    expect(eventDispatcher.dispatch).toHaveBeenCalledWith('font-size-changed', { size: 19 });
    expect(eventDispatcher.dispatch).not.toHaveBeenCalledWith('zoom-in', expect.anything());
    expect(eventDispatcher.dispatch).not.toHaveBeenCalledWith('zoom-out', expect.anything());
  });
});
