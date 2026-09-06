import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';

import ColorInput from '@/components/settings/theme/ColorInput';

afterEach(() => cleanup());

describe('ColorInput toggle', () => {
  it('closes when the swatch is clicked while the picker is open', () => {
    render(<ColorInput label='Highlight' value='#ff0000' onChange={vi.fn()} />);

    const swatch = screen.getByTitle('Highlight');
    fireEvent.click(swatch);
    expect(document.querySelector('.react-colorful')).not.toBeNull();

    // The second click toggles the picker closed. The regression: the
    // outside-mousedown handler closed it first, and the click then reopened
    // it — the picker could never be dismissed via the swatch.
    fireEvent.click(swatch);
    expect(document.querySelector('.react-colorful')).toBeNull();
  });

  it('closes on a genuine outside click and fires onCommit', () => {
    const onCommit = vi.fn();
    render(
      <div>
        <div data-testid='outside' />
        <ColorInput label='Highlight' value='#ff0000' onChange={vi.fn()} onCommit={onCommit} />
      </div>,
    );

    const swatch = screen.getByTitle('Highlight');
    fireEvent.click(swatch);
    expect(document.querySelector('.react-colorful')).not.toBeNull();

    fireEvent(document, new MouseEvent('mousedown', { bubbles: true }));
    expect(document.querySelector('.react-colorful')).toBeNull();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
