import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';

import NumberInput from '@/components/settings/NumberInput';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

afterEach(() => cleanup());

describe('NumberInput emptied field blur', () => {
  it('restores the previous value instead of clamping to min', () => {
    const onChange = vi.fn();
    render(<NumberInput label='Size' value={18} min={8} max={200} onChange={onChange} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;

    // Clear the field entirely, then blur.
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    // The old behavior clamped NaN→0 into min (8) and fired onChange.
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('18');
  });

  it('still commits a real number on blur', () => {
    const onChange = vi.fn();
    render(<NumberInput label='Size' value={18} min={8} max={200} onChange={onChange} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '24' } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith(24);
    expect(input.value).toBe('24');
  });
});
