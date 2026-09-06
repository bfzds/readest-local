import { useEffect } from 'react';
import { eventDispatcher } from '@/utils/event';
import { useSidebarStore } from '@/store/sidebarStore';

/**
 * Mouse side-button navigation mapped to the app's own back/forward
 * navigation (not `history`, which the library's replace-based routing does
 * not populate). Windows and macOS mice both report the back/forward buttons
 * as `button` 3 and 4 on `mousedown`.
 *
 * We forward a window-level app event and let the active page decide what
 * "back" and "forward" mean — the library goes up/down one group level,
 * keeping behaviour consistent with the on-screen and keyboard navigation.
 *
 * Reader search-bar interlock: while the reader's search bar is visible,
 * "back" collapses it (and the sidebar with it) instead of switching books.
 * "Forward" has no restore role — it always maps to app-level forward.
 *
 * Guard rails:
 * - Presses inside editable fields are ignored (typing/selection shouldn't
 *   navigate).
 * - A press while the primary button is still held (mid drag/reorder) is
 *   ignored to avoid mis-triggering navigation during drag interactions.
 */
/**
 * Shared side-button "back" interlock: while the reader search bar is visible,
 * back collapses it (and the sidebar with it) instead of switching books.
 * Used by both the window-level mousedown path and the iframe-forwarded press.
 * Returns true when the back press was consumed by the search-bar dismissal.
 */
export const handleSideButtonBackInterlock = (): boolean => {
  const { isSearchBarVisible, setSearchBarVisible, isSideBarPinned, setSideBarVisible } =
    useSidebarStore.getState();
  if (isSearchBarVisible) {
    setSearchBarVisible(false);
    if (!isSideBarPinned) setSideBarVisible(false);
    return true;
  }
  return false;
};

export const useMouseNavigation = () => {
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      // 3 = back, 4 = forward (XButton1/XButton2).
      if (e.button !== 3 && e.button !== 4) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable]')) return;
      // `buttons & 1` is set when the left button is still held (drag in
      // progress); a side-button press during a drag is almost always
      // accidental.
      if (e.buttons & 1) return;
      // Stop the host's default side-button history navigation so the gesture
      // maps to exactly one app-level action.
      e.preventDefault();
      if (e.button === 3) {
        // Search bar open → dismiss it (not switch books) and close the
        // sidebar unless pinned, so the reader comes back rather than the TOC.
        if (handleSideButtonBackInterlock()) {
          return;
        }
        eventDispatcher.dispatch('library-nav-back');
      } else {
        eventDispatcher.dispatch('library-nav-forward');
      }
    };
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, []);
};
