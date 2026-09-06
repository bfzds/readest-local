import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { handleSideButtonBackInterlock } from '@/hooks/useMouseNavigation';
import { useSidebarStore } from '@/store/sidebarStore';
import { handleMouseup } from '@/app/reader/utils/iframeEventHandlers';

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
    useSidebarStore.setState({ isSearchBarVisible: true, isSideBarPinned: true });

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
    expect((window.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0].type).toBe(
      'iframe-mouseup',
    );
  });
});
