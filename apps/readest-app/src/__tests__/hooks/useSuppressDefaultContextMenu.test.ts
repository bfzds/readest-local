import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useSuppressDefaultContextMenu } from '@/hooks/useSuppressDefaultContextMenu';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('useSuppressDefaultContextMenu', () => {
  it('prevents the browser menu on right-click outside editable fields', () => {
    renderHook(() => useSuppressDefaultContextMenu());
    document.body.innerHTML = '<div data-testid="blank">blank</div>';

    const el = document.querySelector<HTMLElement>('[data-testid="blank"]')!;
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    el.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(true);
  });

  it('keeps the native menu on input fields', () => {
    renderHook(() => useSuppressDefaultContextMenu());
    document.body.innerHTML = '<input data-testid="input" />';

    const el = document.querySelector<HTMLElement>('[data-testid="input"]')!;
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    el.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(false);
  });

  it('keeps the native menu on textareas', () => {
    renderHook(() => useSuppressDefaultContextMenu());
    document.body.innerHTML = '<textarea data-testid="ta"></textarea>';

    const el = document.querySelector<HTMLElement>('[data-testid="ta"]')!;
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    el.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(false);
  });

  it('keeps the native menu on contenteditable elements', () => {
    renderHook(() => useSuppressDefaultContextMenu());
    document.body.innerHTML = '<div data-testid="ce" contenteditable="true">edit</div>';

    const el = document.querySelector<HTMLElement>('[data-testid="ce"]')!;
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    el.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(false);
  });

  it('removes the listener on unmount', () => {
    const { unmount } = renderHook(() => useSuppressDefaultContextMenu());
    unmount();
    document.body.innerHTML = '<div data-testid="blank">blank</div>';

    const el = document.querySelector<HTMLElement>('[data-testid="blank"]')!;
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    el.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(false);
  });
});
