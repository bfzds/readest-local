'use client';

import { useEffect } from 'react';

/**
 * Suppress the host browser's default context menu (WebView2 on Windows shows
 * Back / Refresh / Save as / Print / Send tab / Inspect) on non-editable
 * surfaces, so right-clicking empty areas of the library or reader doesn't
 * surface browser chrome. Editable fields (inputs, textareas, selects,
 * contenteditable) keep their native copy/paste menu.
 */
export const useSuppressDefaultContextMenu = () => {
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
    };
    window.addEventListener('contextmenu', handleContextMenu);
    return () => window.removeEventListener('contextmenu', handleContextMenu);
  }, []);
};
