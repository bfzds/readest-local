import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react';

const defaultViewSettings = () => ({
  vertical: false,
  scrolled: false,
  marginBottomPx: 20,
  showRemainingTime: false,
  showRemainingPages: false,
  showProgressInfo: true,
  showCurrentTime: false,
  showCurrentBatteryStatus: false,
  rtl: false,
});

const readerStoreState = {
  getView: (): unknown => null,
  getViewSettings: defaultViewSettings,
};

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: { hasSafeAreaInset: false } }),
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: (selector?: (state: typeof readerStoreState) => unknown) =>
    selector ? selector(readerStoreState) : readerStoreState,
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: (selector?: (state: { getBookData: () => unknown }) => unknown) => {
    const state = { getBookData: () => ({}) };
    return selector ? selector(state) : state;
  },
}));
vi.mock('@/store/readerProgressStore', () => ({
  useBookProgress: () => ({
    sectionLabel: '第一章',
    section: { current: 0, total: 10 },
    pageinfo: { current: 0, total: 100 },
    fraction: 0,
    pageItem: null,
  }),
}));
vi.mock('@/app/reader/hooks/useCurrentTime', () => ({
  useCurrentTime: () => '',
}));
vi.mock('@/app/reader/hooks/useCurrentBattery', () => ({
  useCurrentBatteryStatus: () => null,
}));
vi.mock('@/hooks/useMedianPageDurationSecs', () => ({
  useMedianPageDurationSecs: () => undefined,
}));

import ProgressBar from '@/app/reader/components/ProgressBar';

afterEach(() => cleanup());

describe('ProgressBar section label', () => {
  afterEach(() => {
    readerStoreState.getViewSettings = defaultViewSettings;
  });

  it('truncates the label in paginated mode', () => {
    render(
      <ProgressBar
        bookKey='book-1'
        horizontalGap={5}
        contentInsets={{ left: 20, right: 20, top: 20, bottom: 20 }}
        gridInsets={{ left: 0, right: 0, top: 0, bottom: 0 }}
      />,
    );
    const label = screen.getByTestId('progress-section-label');
    expect(label.className).toContain('truncate');
    expect(label.className).not.toContain('progress-pill');
  });

  it('keeps the label readable and scrollable in scrolled mode', () => {
    readerStoreState.getViewSettings = () => ({
      ...defaultViewSettings(),
      scrolled: true,
    });
    render(
      <ProgressBar
        bookKey='book-1'
        horizontalGap={5}
        contentInsets={{ left: 20, right: 20, top: 20, bottom: 20 }}
        gridInsets={{ left: 0, right: 0, top: 0, bottom: 0 }}
      />,
    );
    const label = screen.getByTestId('progress-section-label');
    const pill = label.querySelector('span');
    expect(pill).not.toBeNull();
    expect(pill!.className).toContain('progress-pill');
    expect(pill!.className).toContain('overflow-x-auto');
    expect(label.className).not.toContain('truncate');
    expect(label.className).toContain('max-w-');
  });
});

describe('ProgressBar', () => {
  it('shows the current section label at the bottom', () => {
    render(
      <ProgressBar
        bookKey='book-1'
        horizontalGap={5}
        contentInsets={{ left: 20, right: 20, top: 20, bottom: 20 }}
        gridInsets={{ left: 0, right: 0, top: 0, bottom: 0 }}
      />,
    );
    expect(screen.getByText('第一章')).toBeDefined();
  });
});

describe('ProgressBar scrub gesture', () => {
  const goToFraction = vi.fn();
  const viewState = { view: null as null | { goToFraction: typeof goToFraction } };

  const pointerEvent = (type: string, x: number, y = 0) =>
    // jsdom has no PointerEvent constructor; a MouseEvent with the pointer
    // event's type string is enough for the handler contract (button, clientX).
    new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });

  // Dispatch inside act() so state updates from the handlers (the bubble)
  // commit synchronously before assertions.
  const fire = (target: EventTarget, event: Event) => {
    act(() => {
      target.dispatchEvent(event);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    goToFraction.mockClear();
    readerStoreState.getView = () =>
      viewState.view
        ? (viewState.view as unknown as NonNullable<ReturnType<typeof readerStoreState.getView>>)
        : null;
  });

  afterEach(() => {
    vi.useRealTimers();
    readerStoreState.getView = () => null;
  });

  const renderStrip = () => {
    render(
      <ProgressBar
        bookKey='book-1'
        horizontalGap={5}
        contentInsets={{ left: 20, right: 20, top: 20, bottom: 20 }}
        gridInsets={{ left: 0, right: 0, top: 0, bottom: 0 }}
      />,
    );
    const strip = screen.getByTestId('progress-strip');
    strip.getBoundingClientRect = () =>
      ({
        left: 0,
        width: 1000,
        top: 700,
        height: 20,
        right: 1000,
        bottom: 720,
        x: 0,
        y: 700,
        toJSON: () => ({}),
      }) as DOMRect;
    return strip;
  };

  it('does not scrub when the pointer moves less than the threshold', () => {
    viewState.view = { goToFraction };
    const strip = renderStrip();
    fire(strip, pointerEvent('pointerdown', 500));
    fire(window, pointerEvent('pointermove', 504));
    fire(window, pointerEvent('pointerup', 504));
    expect(goToFraction).not.toHaveBeenCalled();
  });

  it('scrubs to the pointer fraction and jumps there on release', () => {
    viewState.view = { goToFraction };
    const strip = renderStrip();
    fire(strip, pointerEvent('pointerdown', 500));
    fire(window, pointerEvent('pointermove', 750));
    expect(screen.getByRole('status')).toBeDefined();
    fire(window, pointerEvent('pointerup', 750));
    expect(goToFraction).toHaveBeenLastCalledWith(0.75);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('cancels back to the original position on Escape mid-drag', () => {
    viewState.view = { goToFraction };
    const strip = renderStrip();
    fire(strip, pointerEvent('pointerdown', 500));
    fire(window, pointerEvent('pointermove', 900));
    fire(window, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // leading scrub call + the restore call
    expect(goToFraction).toHaveBeenCalledTimes(2);
    expect(goToFraction).toHaveBeenLastCalledWith(0.01);
    expect(screen.queryByRole('status')).toBeNull();
    fire(window, pointerEvent('pointerup', 900));
    expect(goToFraction).toHaveBeenCalledTimes(2);
  });

  it('does not scrub a vertical layout', () => {
    readerStoreState.getViewSettings = () => ({ ...defaultViewSettings(), vertical: true });
    viewState.view = { goToFraction };
    const strip = renderStrip();
    fire(strip, pointerEvent('pointerdown', 500));
    fire(window, pointerEvent('pointermove', 900));
    fire(window, pointerEvent('pointerup', 900));
    expect(goToFraction).not.toHaveBeenCalled();
  });

  it('does not scrub without a mounted view', () => {
    viewState.view = null;
    const strip = renderStrip();
    fire(strip, pointerEvent('pointerdown', 500));
    fire(window, pointerEvent('pointermove', 900));
    fire(window, pointerEvent('pointerup', 900));
    expect(goToFraction).not.toHaveBeenCalled();
  });

  it('a scrub release does not toggle the #5293 dismissed state', () => {
    // scrolled + showFooter makes the strip tappable (footerReservesBand)
    readerStoreState.getViewSettings = () => ({
      ...defaultViewSettings(),
      scrolled: true,
      showFooter: true,
    });
    viewState.view = { goToFraction };
    const strip = renderStrip();
    fire(strip, pointerEvent('pointerdown', 500));
    fire(window, pointerEvent('pointermove', 750));
    fire(window, pointerEvent('pointerup', 750));
    // a down+up pair that both land on the strip fires a click in real browsers
    strip.click();
    expect(strip.className).not.toContain('opacity-0');
  });

  it('a plain click still toggles the dismissed state after a scrub', () => {
    readerStoreState.getViewSettings = () => ({
      ...defaultViewSettings(),
      scrolled: true,
      showFooter: true,
    });
    viewState.view = { goToFraction };
    const strip = renderStrip();
    fire(strip, pointerEvent('pointerdown', 500));
    fire(window, pointerEvent('pointermove', 750));
    fire(window, pointerEvent('pointerup', 750));
    // the next genuine press re-arms the click
    fire(strip, pointerEvent('pointerdown', 500));
    fire(window, pointerEvent('pointerup', 500));
    act(() => strip.click());
    expect(strip.className).toContain('opacity-0');
  });

  it('renders the hairline track at the current progress position', () => {
    render(
      <ProgressBar
        bookKey='book-1'
        horizontalGap={5}
        contentInsets={{ left: 20, right: 20, top: 20, bottom: 20 }}
        gridInsets={{ left: 0, right: 0, top: 0, bottom: 0 }}
      />,
    );
    const track = screen.getByTestId('progress-track');
    // pageinfo { current: 0, total: 100 } → 1% fill, collapsed height
    const fill = track.firstElementChild!.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe('1%');
    expect(fill.className).toContain('bg-base-content/35');
    const handle = track.firstElementChild!.children[1] as HTMLElement;
    expect(handle.className).toContain('opacity-0');
  });

  it('expands the track on hover but keeps the handle for active scrubs', () => {
    render(
      <ProgressBar
        bookKey='book-1'
        horizontalGap={5}
        contentInsets={{ left: 20, right: 20, top: 20, bottom: 20 }}
        gridInsets={{ left: 0, right: 0, top: 0, bottom: 0 }}
      />,
    );
    const strip = screen.getByTestId('progress-strip');
    const track = screen.getByTestId('progress-track');
    fireEvent.mouseEnter(strip);
    const bar = track.firstElementChild as HTMLElement;
    expect(bar.className).toContain('h-[3px]');
    // hovering alone must not paint an opaque dot over the footer text
    const handle = bar.children[1] as HTMLElement;
    expect(handle.className).toContain('opacity-0');
    fireEvent.mouseLeave(strip);
    expect((track.firstElementChild as HTMLElement).className).toContain('h-px');
  });

  it('shows the handle while a scrub is in flight', () => {
    viewState.view = { goToFraction };
    const strip = renderStrip();
    const track = screen.getByTestId('progress-track');
    const handle = track.firstElementChild!.children[1] as HTMLElement;
    expect(handle.className).toContain('opacity-0');
    fire(strip, pointerEvent('pointerdown', 500));
    fire(window, pointerEvent('pointermove', 750));
    expect(handle.className).toContain('opacity-100');
    fire(window, pointerEvent('pointerup', 750));
    expect(handle.className).toContain('opacity-0');
  });
});
