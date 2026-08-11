import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

import LibraryFloatingButton from '@/app/reader/components/LibraryFloatingButton';

afterEach(() => cleanup());

describe('LibraryFloatingButton', () => {
  it('returns to the library on click', () => {
    const onGoToLibrary = vi.fn();
    render(<LibraryFloatingButton onGoToLibrary={onGoToLibrary} />);
    fireEvent.click(screen.getByLabelText('Back to library'));
    expect(onGoToLibrary).toHaveBeenCalledTimes(1);
  });

  it('sits above the search button on the same vertical line', () => {
    const { container } = render(<LibraryFloatingButton onGoToLibrary={vi.fn()} />);
    const button = container.querySelector('button');
    expect(button?.className).toContain('bottom-56');
    expect(button?.className).toContain('right-4');
    expect(button?.className).toContain('w-12');
  });
});
