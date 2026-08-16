import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CommandPalette from '@/components/command-palette/CommandPalette';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

const { mockClose } = vi.hoisted(() => ({ mockClose: vi.fn() }));

vi.mock('@/components/command-palette/CommandPaletteProvider', () => ({
  useCommandPalette: () => ({
    isOpen: true,
    close: mockClose,
    setQuery: vi.fn(),
    query: '',
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
    // fireEvent.blur simulates clicking elsewhere while the window keeps
    // focus (native blur() flips jsdom's document.hasFocus() to false, which
    // would wrongly skip the refocus guard)
    fireEvent.blur(input);
    await new Promise((r) => requestAnimationFrame(r));
    // focus is pulled back into the palette so arrow keys never fall through
    // to the page (e.g. after clicking empty dialog space)
    expect(document.activeElement).toBe(input);
  });

  it('closes the palette with Ctrl+W instead of the window', () => {
    mockClose.mockClear();
    render(<CommandPalette />);
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'w', ctrlKey: true });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});
