import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useMouseNavigation } from '@/hooks/useMouseNavigation';

vi.mock('@/utils/event', () => ({
  eventDispatcher: { dispatch: vi.fn() },
}));

import { eventDispatcher } from '@/utils/event';

describe('useMouseNavigation', () => {
  beforeEach(() => {
    vi.mocked(eventDispatcher.dispatch).mockClear();
  });
  afterEach(() => {
    cleanup();
  });

  const fireMouseDown = (button: number, target: HTMLElement = document.body, buttons = 0) => {
    target.dispatchEvent(
      new MouseEvent('mousedown', { button, buttons, bubbles: true, cancelable: true }),
    );
  };

  test('back side button (button 3) dispatches library-nav-back', () => {
    renderHook(() => useMouseNavigation());
    fireMouseDown(3);
    expect(eventDispatcher.dispatch).toHaveBeenCalledWith('library-nav-back');
    expect(eventDispatcher.dispatch).not.toHaveBeenCalledWith('library-nav-forward');
  });

  test('forward side button (button 4) dispatches library-nav-forward', () => {
    renderHook(() => useMouseNavigation());
    fireMouseDown(4);
    expect(eventDispatcher.dispatch).toHaveBeenCalledWith('library-nav-forward');
    expect(eventDispatcher.dispatch).not.toHaveBeenCalledWith('library-nav-back');
  });

  test('primary (button 0) and middle (button 1) do not navigate', () => {
    renderHook(() => useMouseNavigation());
    fireMouseDown(0);
    fireMouseDown(1);
    expect(eventDispatcher.dispatch).not.toHaveBeenCalled();
  });

  test('does not navigate when the press lands inside an editable field', () => {
    renderHook(() => useMouseNavigation());
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireMouseDown(3, input);
    input.remove();
    expect(eventDispatcher.dispatch).not.toHaveBeenCalled();
  });

  test('does not navigate while the primary button is held (mid drag)', () => {
    renderHook(() => useMouseNavigation());
    fireMouseDown(3, document.body, 1); // buttons = left button held
    expect(eventDispatcher.dispatch).not.toHaveBeenCalled();
  });
});
