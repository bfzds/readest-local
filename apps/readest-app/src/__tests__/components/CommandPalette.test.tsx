import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CommandPalette from '@/components/command-palette/CommandPalette';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

vi.mock('@/components/command-palette/CommandPaletteProvider', () => ({
  useCommandPalette: () => ({
    isOpen: true,
    close: vi.fn(),
    query: '',
    setQuery: vi.fn(),
    results: [],
    groupedResults: { settings: [], actions: [], navigation: [] },
    recentItems: [],
    executeCommand: vi.fn(),
  }),
}));

describe('CommandPalette', () => {
  afterEach(() => {
    cleanup();
  });

  it('does not propagate keydown events to the window', () => {
    // When the input loses focus, arrow keys must not bubble to the global
    // shortcut handler and move the page underneath. The palette traps
    // its own keyboard navigation.
    const windowHandler = vi.fn();
    window.addEventListener('keydown', windowHandler);
    try {
      render(<CommandPalette />);
      const dialog = screen.getByRole('dialog');
      fireEvent.keyDown(dialog, { key: 'ArrowDown' });
      fireEvent.keyDown(dialog, { key: 'ArrowUp' });
      fireEvent.keyDown(dialog, { key: 'Enter' });
      expect(windowHandler).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', windowHandler);
    }
  });

  it('restores focus to the search input when it loses focus', async () => {
    render(<CommandPalette />);
    const input = screen.getByRole('textbox');
    input.focus();
    expect(document.activeElement).toBe(input);
    input.blur();
    await new Promise((r) => requestAnimationFrame(r));
    // focus is pulled back into the palette so arrow keys never fall through
    // to the page (e.g. after clicking empty dialog space)
    expect(document.activeElement).toBe(input);
  });
});
