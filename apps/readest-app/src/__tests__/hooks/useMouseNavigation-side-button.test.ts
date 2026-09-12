import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { handleSideButtonBackInterlock } from '@/hooks/useMouseNavigation';
import { useSidebarStore } from '@/store/sidebarStore';
import {
  handleMouseDown,
  handleMouseup,
  isTrustedSideButtonSource,
} from '@/app/reader/utils/iframeEventHandlers';

describe('side-button back search-bar interlock', () => {
  beforeEach(() => {
    useSidebarStore.setState({ isSearchBarVisible: false, isSideBarPinned: false });
  });

  afterEach(() => {
    useSidebarStore.setState({ isSearchBarVisible: false, isSideBarPinned: false });
  });

  it('collapses the search bar instead of switching books when it is open', () => {
    useSidebarStore.setState({ isSearchBarVisible: true });

    expect(handleSideButtonBackInterlock()).toBe(true);
    expect(useSidebarStore.getState().isSearchBarVisible).toBe(false);
    expect(useSidebarStore.getState().isSideBarVisible).toBe(false);
  });

  it('returns false when the search bar is closed (book switching proceeds)', () => {
    expect(handleSideButtonBackInterlock()).toBe(false);
  });

  it('keeps the sidebar open when it is pinned', () => {
    useSidebarStore.setState({
      isSearchBarVisible: true,
      isSideBarPinned: true,
      isSideBarVisible: true,
    });

    expect(handleSideButtonBackInterlock()).toBe(true);
    expect(useSidebarStore.getState().isSearchBarVisible).toBe(false);
    expect(useSidebarStore.getState().isSideBarVisible).toBe(true);
  });
});

// The side-button gesture must map to exactly ONE app-level action: the
// mousedown forward drives navigation, so the mouseup must not be forwarded
// (it used to reach usePagination, which ran view.history.back/forward on
// top of the book switch).
describe('iframe mouseup side-button suppression', () => {
  const mouseupEvent = (button: number) =>
    ({
      button,
      preventDefault: vi.fn(),
      screenX: 0,
      screenY: 0,
      clientX: 0,
      clientY: 0,
      offsetX: 0,
      offsetY: 0,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    }) as unknown as MouseEvent;

  beforeEach(() => {
    vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not forward the mouseup for side buttons', () => {
    handleMouseup('book-1', mouseupEvent(3));
    handleMouseup('book-1', mouseupEvent(4));
    expect(window.postMessage).not.toHaveBeenCalled();
  });

  it('still forwards ordinary button mouseups', () => {
    handleMouseup('book-1', mouseupEvent(0));
    expect(window.postMessage).toHaveBeenCalledTimes(1);
    expect((window.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0].type).toBe(
      'iframe-mouseup',
    );
  });
});

// The iframe-forwarded mousedown path must apply the same guard rails as the
// window-level listener (useMouseNavigation): a side-button press during a
// primary-button drag (e.g. mid text-selection) or inside an editable element
// must not switch books behind the user's back.
describe('iframe mousedown side-button forwarding guards', () => {
  const mousedownEvent = (button: number, opts: { buttons?: number; target?: unknown } = {}) =>
    ({
      button,
      buttons: opts.buttons ?? 0,
      target: opts.target ?? null,
      preventDefault: vi.fn(),
    }) as unknown as MouseEvent;

  beforeEach(() => {
    vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards a plain side-button press inside the book content', () => {
    handleMouseDown('book-1', mousedownEvent(3));
    handleMouseDown('book-1', mousedownEvent(4));
    expect(window.postMessage).toHaveBeenCalledTimes(2);
    const calls = (window.postMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![0]).toMatchObject({ type: 'iframe-side-button', button: 3 });
    expect(calls[1]![0]).toMatchObject({ type: 'iframe-side-button', button: 4 });
  });

  it('ignores a side-button press while the primary button is held (selection in progress)', () => {
    handleMouseDown('book-1', mousedownEvent(3, { buttons: 1 }));
    handleMouseDown('book-1', mousedownEvent(4, { buttons: 1 }));
    expect(window.postMessage).not.toHaveBeenCalled();
  });

  it('ignores a side-button press inside an editable element', () => {
    const editable = { closest: () => ({}) };
    handleMouseDown('book-1', mousedownEvent(3, { target: editable }));
    expect(window.postMessage).not.toHaveBeenCalled();
  });
});

// Side-button presses reach the app as an 'iframe-side-button' postMessage.
// The producer (handleMouseDown) is a parent-realm function bound to the
// iframe's document, so its window.postMessage is an intra-window post whose
// source is the MAIN window — not the iframe. The provenance gate must accept
// that (plus a genuine book iframe), while rejecting everything else.
describe('isTrustedSideButtonSource', () => {
  it('accepts the main window (the actual producer provenance)', () => {
    expect(isTrustedSideButtonSource(window)).toBe(true);
  });

  it('accepts a source window that belongs to a document iframe', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    try {
      expect(isTrustedSideButtonSource(iframe.contentWindow)).toBe(true);
    } finally {
      iframe.remove();
    }
  });

  it('rejects null and other sources', () => {
    expect(isTrustedSideButtonSource(null)).toBe(false);
    expect(isTrustedSideButtonSource({} as Window)).toBe(false);
  });
});
