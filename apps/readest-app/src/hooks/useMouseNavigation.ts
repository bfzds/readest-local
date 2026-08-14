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
 * "back" dismisses it (instead of switching books); the next "forward" then
 * restores it. This makes the side buttons feel like a dialog dismiss/restore
 * pair without stealing the book-switch gesture — book switching only kicks
 * in when the search bar isn't in this interaction.
 *
 * Guard rails:
 * - Presses inside editable fields are ignored (typing/selection shouldn't
 *   navigate).
 * - A press while the primary button is still held (mid drag/reorder) is
 *   ignored to avoid mis-triggering navigation during drag interactions.
 */
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
      const { isSearchBarVisible, setSearchBarVisible, isSideBarPinned, setSideBarVisible } =
        useSidebarStore.getState();
      if (e.button === 3) {
        // Search bar open → dismiss it (not switch books) and close the
        // sidebar unless pinned, so the reader comes back rather than the TOC.
        if (isSearchBarVisible) {
          setSearchBarVisible(false);
          if (!isSideBarPinned) setSideBarVisible(false);
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
