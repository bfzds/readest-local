import { useEffect, useState } from 'react';
import { loadShortcuts, ShortcutConfig } from '../helpers/shortcuts';
import { matchesShortcut, ShortcutEventLike } from '../utils/shortcutKeys';

export type KeyActionHandlers = {
  [K in keyof ShortcutConfig]?: (event?: KeyboardEvent | MessageEvent) => void;
};

const useShortcuts = (actions: KeyActionHandlers, dependencies: React.DependencyList = []) => {
  const [shortcuts, setShortcuts] = useState<ShortcutConfig>(loadShortcuts);

  useEffect(() => {
    const handleShortcutUpdate = () => {
      setShortcuts(loadShortcuts());
    };

    window.addEventListener('shortcutUpdate', handleShortcutUpdate);
    return () => window.removeEventListener('shortcutUpdate', handleShortcutUpdate);
  }, []);

  const processKeyEvent = (eventLike: ShortcutEventLike, event: KeyboardEvent | MessageEvent) => {
    for (const [actionName, actionHandler] of Object.entries(actions)) {
      const shortcutKey = actionName as keyof ShortcutConfig;
      const handler = actionHandler as
        | ((event?: KeyboardEvent | MessageEvent) => void | boolean)
        | undefined;
      const shortcutEntry = shortcuts[shortcutKey as keyof ShortcutConfig];
      // console.log('Checking action:', shortcutKey);
      if (handler && shortcutEntry?.keys && matchesShortcut(eventLike, shortcutEntry.keys)) {
        if (handler(event)) {
          return true;
        }
      }
    }
    return false;
  };

  const unifiedHandleKeyDown = (event: KeyboardEvent | MessageEvent) => {
    // Check if the focus is on an input, textarea, or contenteditable element
    const activeElement = document.activeElement as HTMLElement;
    const isInteractiveElement =
      activeElement.tagName === 'INPUT' ||
      activeElement.tagName === 'TEXTAREA' ||
      activeElement.isContentEditable;

    const isNoteEditor =
      activeElement.tagName === 'TEXTAREA' && activeElement.classList.contains('note-editor');

    if (isInteractiveElement && !isNoteEditor) {
      return; // Skip handling if the user is typing in an input, textarea, or contenteditable
    }

    if (event instanceof KeyboardEvent) {
      const { key, ctrlKey, altKey, metaKey, shiftKey } = event;

      if (isNoteEditor && !((key === 'Enter' && ctrlKey) || key == 'Escape')) {
        return;
      }

      if (ctrlKey && key.toLowerCase() === 'f') {
        event.preventDefault();
      }

      const handled = processKeyEvent({ key, ctrlKey, altKey, metaKey, shiftKey }, event);
      // console.log('Key event handled:', key, handled);
      if (handled) event.preventDefault();
    } else if (
      event instanceof MessageEvent &&
      event.data &&
      event.data.type === 'iframe-keydown'
    ) {
      const { key, ctrlKey, altKey, metaKey, shiftKey } = event.data;
      // Forwarded iframe keys keep the original "Back button" guard: a
      // Backspace arriving over postMessage is the remote Back key, never a
      // typed character — it must not match shortcuts. A NATIVE Backspace
      // keydown (no such default behavior in desktop webviews, and input
      // fields are excluded above) participates in shortcut matching normally.
      if (key.toLowerCase() === 'backspace') return;
      processKeyEvent({ key, ctrlKey, altKey, metaKey, shiftKey }, event);
    }
  };

  useEffect(() => {
    window.addEventListener('keydown', unifiedHandleKeyDown);
    window.addEventListener('message', unifiedHandleKeyDown);

    return () => {
      window.removeEventListener('keydown', unifiedHandleKeyDown);
      window.removeEventListener('message', unifiedHandleKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shortcuts, ...dependencies]);
};

export default useShortcuts;
