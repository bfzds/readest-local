import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getBookData: () => ({ isFixedLayout: false }),
  }),
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getView: () => ({
      getCFI: () => 'cfi',
      renderer: { containerPosition: 0, scrollLocked: false },
    }),
    getViewSettings: () => ({}),
    getProgress: () => ({ page: 1 }),
  }),
}));
vi.mock('@/app/reader/hooks/useAutoPageTurn', () => ({
  useAutoPageTurn: () => ({
    cornerAtPoint: () => null,
    noteCorner: () => {},
    noteAutoTurnPoint: () => {},
    cancel: () => {},
    onAfterTurn: () => () => {},
  }),
}));
vi.mock('@/app/reader/hooks/useInstantAnnotation', () => ({
  useInstantAnnotation: () => ({
    isInstantAnnotationEnabled: () => false,
    handleInstantAnnotationPointerDown: () => false,
    handleInstantAnnotationEngage: () => {},
    handleInstantAnnotationPointerMove: () => {},
    handleInstantAnnotationPointerCancel: () => {},
    handleInstantAnnotationPointerUp: async () => false,
    reapplyInstantAnnotation: () => {},
  }),
}));

import { useTextSelector } from '@/app/reader/hooks/useTextSelector';

describe('useTextSelector dismiss on selection clear', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  test('pointerup with a cleared selection dismisses the popup immediately', async () => {
    const setSelection = vi.fn();
    const setEditingAnnotation = vi.fn();
    const setExternalDragPoint = vi.fn();
    const getAnnotationText = vi.fn(async () => 'hello');
    const dismissPopup = vi.fn();

    const { result } = renderHook(() =>
      useTextSelector(
        'book-1',
        { top: 0, right: 0, bottom: 0, left: 0 },
        setSelection,
        setEditingAnnotation,
        setExternalDragPoint,
        getAnnotationText,
        dismissPopup,
      ),
    );

    const doc = document;
    const p = document.createElement('p');
    p.textContent = 'hello world';
    document.body.appendChild(p);
    const sel = doc.getSelection()!;
    const range = document.createRange();
    range.setStart(p.firstChild!, 0);
    range.setEnd(p.firstChild!, 5);
    sel.removeAllRanges();
    sel.addRange(range);

    // A drag-selection commits and arms the popup (isTextSelected = true).
    await act(async () => {
      result.current.handleSelectionchange(doc, 0);
    });

    // Clicking blank clears the selection; the desktop pointerup path must
    // dismiss right away (mirroring handleTouchEnd), not wait for a later tap.
    sel.removeAllRanges();
    await act(async () => {
      result.current.handlePointerUp(doc, 0);
    });

    expect(dismissPopup).toHaveBeenCalled();
  });
});
