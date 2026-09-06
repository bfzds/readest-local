import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import React, { useRef } from 'react';

import { useKeyDownActions } from '@/hooks/useKeyDownActions';

afterEach(() => cleanup());

type Handlers = {
  onConfirm?: () => void;
  onCancel?: () => void;
  withButton?: boolean;
};

const Host: React.FC<Handlers> = ({ onConfirm, onCancel, withButton }) => {
  const elementRef = useRef<HTMLDivElement>(null);
  useKeyDownActions({ onConfirm, onCancel, elementRef });
  return (
    <div ref={elementRef} data-testid='host'>
      {withButton && <button data-testid='inside'>inside</button>}
    </div>
  );
};

describe('useKeyDownActions', () => {
  it('responds to Enter/Escape on window while mounted', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<Host onConfirm={onConfirm} onCancel={onCancel} />);

    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('removes the element-level listener on unmount', () => {
    const onConfirm = vi.fn();
    const { unmount } = render(<Host onConfirm={onConfirm} />);
    const host = document.querySelector('[data-testid=host]') as HTMLElement;
    unmount();

    // A leaked element listener would still fire on a detached element.
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    // A leaked window listener would still fire here.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('invokes the latest callback after a rerender (no stale closure)', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Host onConfirm={first} />);
    rerender(<Host onConfirm={second} />);

    fireEvent.keyDown(window, { key: 'Enter' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('skips onConfirm for Enter when a button has focus (browser delivers the click)', () => {
    const onConfirm = vi.fn();
    render(<Host onConfirm={onConfirm} withButton />);
    const button = document.querySelector('[data-testid=inside]') as HTMLButtonElement;
    button.focus();
    expect(document.activeElement).toBe(button);

    fireEvent.keyDown(button, { key: 'Enter', bubbles: true });
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
