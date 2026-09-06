import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';

import Alert from '@/components/Alert';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

afterEach(() => cleanup());

const setup = () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(<Alert title='T' message='M' onCancel={onCancel} onConfirm={onConfirm} />);
  const confirm = screen.getByText('Confirm').closest('button')!;
  return { onConfirm, onCancel, confirm };
};

describe('Alert confirm reentrancy', () => {
  it('runs onConfirm once even when the confirm button is clicked repeatedly', () => {
    const { onConfirm, confirm } = setup();

    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('does not double-fire when Enter is pressed while the confirm button has focus', () => {
    const { onConfirm, confirm } = setup();
    confirm.focus();

    // jsdom does not synthesize the default click from Enter; the regression
    // this pins down is the keydown handler itself contributing a second call.
    // The keydown bubbles through the element listener to the window listener;
    // neither may call onConfirm when the target is the focused button.
    fireEvent.keyDown(confirm, { key: 'Enter', bubbles: true });
    expect(onConfirm).toHaveBeenCalledTimes(0);
  });

  it('still confirms via Enter when focus is not on a button', () => {
    const { onConfirm, confirm } = setup();
    confirm.blur();

    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
