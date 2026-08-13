import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import FontSizeOverlay from '@/app/reader/components/FontSizeOverlay';

vi.mock('@/utils/event', () => ({
  eventDispatcher: {
    on: vi.fn(),
    off: vi.fn(),
    dispatch: vi.fn(),
  },
}));

import { eventDispatcher } from '@/utils/event';

const emitFontSizeChanged = (size: number) => {
  const listener = vi.mocked(eventDispatcher.on).mock.calls[0]![1];
  act(() => {
    (listener as (e: CustomEvent) => void)(
      new CustomEvent('font-size-changed', { detail: { size } }),
    );
  });
};

describe('FontSizeOverlay', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('subscribes to font-size-changed on mount and unsubscribes on unmount', () => {
    const { unmount } = render(<FontSizeOverlay />);
    expect(eventDispatcher.on).toHaveBeenCalledWith('font-size-changed', expect.any(Function));
    const listener = vi.mocked(eventDispatcher.on).mock.calls[0]![1];
    unmount();
    expect(eventDispatcher.off).toHaveBeenCalledWith('font-size-changed', listener);
  });

  it('shows the current font size when a change arrives', () => {
    vi.useFakeTimers();
    const { container } = render(<FontSizeOverlay />);
    emitFontSizeChanged(17);
    const root = container.querySelector('[aria-hidden]')!;
    expect(root.textContent).toContain('17');
    expect(root.className).toContain('opacity-100');
  });

  it('hides shortly after the last change stops', () => {
    vi.useFakeTimers();
    const { container } = render(<FontSizeOverlay />);
    emitFontSizeChanged(17);
    const root = container.querySelector('[aria-hidden]')!;
    expect(root.className).toContain('opacity-100');
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(root.className).toContain('opacity-0');
  });

  it('stays visible through a burst of changes and only hides after the last one', () => {
    vi.useFakeTimers();
    const { container } = render(<FontSizeOverlay />);
    emitFontSizeChanged(17);
    emitFontSizeChanged(16);
    emitFontSizeChanged(15);
    const root = container.querySelector('[aria-hidden]')!;
    expect(root.textContent).toContain('15');
    // 700ms after the last change is still within the 800ms hide delay.
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(root.className).toContain('opacity-100');
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(root.className).toContain('opacity-0');
  });
});
