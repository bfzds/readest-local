import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import KeyboardShortcutsPanel from '@/components/settings/KeyboardShortcutsPanel';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string, options?: Record<string, string>) =>
    options ? key.replace(/\{\{(\w+)\}\}/g, (_, name) => options[name] ?? '') : key,
}));

const renderPanel = () => {
  const onRegisterReset = vi.fn();
  render(<KeyboardShortcutsPanel bookKey='test-book' onRegisterReset={onRegisterReset} />);
  return { onRegisterReset };
};

const rowFor = (label: string, id: string) => {
  const row = screen.getByText(label).closest(`[data-setting-id="settings.keyboard.${id}"]`);
  if (!row) throw new Error(`row not found for ${id}`);
  return row as HTMLElement;
};

const startRecording = (row: HTMLElement) => {
  fireEvent.click(within(row).getByText('Edit'));
  return within(row).getByPlaceholderText('Press new shortcut') as HTMLInputElement;
};

describe('KeyboardShortcutsPanel', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders shortcut sections with their actions', () => {
    renderPanel();
    expect(screen.getByText('Toggle Sidebar')).toBeTruthy();
    expect(screen.getByText('Toggle Notebook')).toBeTruthy();
    expect(screen.getByText('Next Page')).toBeTruthy();
  });

  it('marks keycaps that conflict with another action', () => {
    renderPanel();
    // onShowSearchBar and onSearchSelection both bind ctrl+f
    const conflicted = Array.from(document.querySelectorAll('kbd[title]')).filter((k) =>
      (k.getAttribute('title') ?? '').includes('Shared with'),
    );
    expect(conflicted.length).toBeGreaterThan(0);
  });

  it('does not mark unique keycaps as conflicts', () => {
    renderPanel();
    // onToggleSideBar's 's' is unique — its keycap must not carry a conflict title
    const row = rowFor('Toggle Sidebar', 'onToggleSideBar');
    const keycaps = Array.from(row.querySelectorAll('kbd'));
    expect(keycaps.length).toBeGreaterThan(0);
    for (const keycap of keycaps) {
      expect(keycap.getAttribute('title') ?? '').not.toContain('Shared with');
    }
  });

  it('records a new shortcut, persists it, and dispatches shortcutUpdate', () => {
    const handler = vi.fn();
    window.addEventListener('shortcutUpdate', handler);
    renderPanel();

    const row = rowFor('Toggle Sidebar', 'onToggleSideBar');
    const input = startRecording(row);
    fireEvent.keyDown(input, { key: 'x', ctrlKey: true });

    const stored = JSON.parse(localStorage.getItem('customShortcuts') ?? '{}');
    expect(stored.onToggleSideBar).toEqual(['ctrl+x']);
    expect(handler).toHaveBeenCalled();
    window.removeEventListener('shortcutUpdate', handler);
  });

  it('shows a conflict and does not save when the key is taken', () => {
    renderPanel();
    const row = rowFor('Toggle Sidebar', 'onToggleSideBar');
    const input = startRecording(row);

    // ctrl+f is bound to Search in Book / Search Selection
    fireEvent.keyDown(input, { key: 'f', ctrlKey: true });

    expect(within(row).getByText(/Used by/)).toBeTruthy();
    expect(localStorage.getItem('customShortcuts')).toBeNull();
    // stays in recording mode so the user can pick another key
    expect(within(row).getByPlaceholderText('Press new shortcut')).toBeTruthy();
  });

  it('clears a shortcut with Backspace', () => {
    renderPanel();
    const row = rowFor('Toggle Sidebar', 'onToggleSideBar');
    const input = startRecording(row);

    fireEvent.keyDown(input, { key: 'Backspace' });

    const stored = JSON.parse(localStorage.getItem('customShortcuts') ?? '{}');
    expect(stored.onToggleSideBar).toEqual([]);
    expect(within(row).getByText('No shortcut')).toBeTruthy();
  });

  it('unbinds a shortcut with Escape and shows it as unbound', () => {
    renderPanel();
    const row = rowFor('Toggle Sidebar', 'onToggleSideBar');
    const input = startRecording(row);

    fireEvent.keyDown(input, { key: 'Escape' });

    const stored = JSON.parse(localStorage.getItem('customShortcuts') ?? '{}');
    expect(stored.onToggleSideBar).toEqual([]);
    expect(within(row).getByText('No shortcut')).toBeTruthy();
  });

  it('shows Restore Default after editing and restores the original keys', () => {
    renderPanel();
    const row = rowFor('Toggle Sidebar', 'onToggleSideBar');
    const input = startRecording(row);
    fireEvent.keyDown(input, { key: 'x', ctrlKey: true });

    const restore = within(row).getByText('Restore Default');
    fireEvent.click(restore);

    const stored = JSON.parse(localStorage.getItem('customShortcuts') ?? '{}');
    expect(stored.onToggleSideBar).toEqual(['s']);
  });

  it('registers a reset handler that drops all overrides', () => {
    const { onRegisterReset } = renderPanel();
    const resetFn = onRegisterReset.mock.calls[0]?.[0];
    expect(resetFn).toBeTypeOf('function');

    localStorage.setItem('customShortcuts', JSON.stringify({ onToggleSideBar: ['ctrl+x'] }));
    resetFn();
    expect(localStorage.getItem('customShortcuts')).toBeNull();
  });
});
