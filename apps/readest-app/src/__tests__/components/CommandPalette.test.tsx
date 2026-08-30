import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import CommandPalette from '@/components/command-palette/CommandPalette';
import type { CommandCategory, CommandItem, CommandSearchResult } from '@/services/commandRegistry';

interface PaletteState {
  isOpen: boolean;
  close: ReturnType<typeof vi.fn>;
  setQuery: ReturnType<typeof vi.fn>;
  query: string;
  results: CommandSearchResult[];
  groupedResults: Record<CommandCategory, CommandSearchResult[]>;
  recentItems: CommandSearchResult[];
  executeCommand: ReturnType<typeof vi.fn>;
}

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

const { mockClose, mockUseCommandPalette, paletteFactory } = vi.hoisted(() => {
  const paletteFactory = (): PaletteState => ({
    isOpen: true,
    close: mockClose,
    setQuery: vi.fn(),
    query: '',
    results: [],
    groupedResults: { settings: [], actions: [], navigation: [] },
    recentItems: [],
    executeCommand: vi.fn(),
  });
  return { mockClose: vi.fn(), mockUseCommandPalette: vi.fn(paletteFactory), paletteFactory };
});

vi.mock('@/components/command-palette/CommandPaletteProvider', () => ({
  useCommandPalette: mockUseCommandPalette,
}));

describe('CommandPalette', () => {
  // jsdom 不实现 scrollIntoView；命令面板选中项滚动依赖它。
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  beforeAll(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });
  afterAll(() => {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  });
  afterEach(() => {
    mockUseCommandPalette.mockClear();
    mockUseCommandPalette.mockImplementation(paletteFactory as never);
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

  it('跨类交错命中时按真实扁平下标高亮并执行（C-9）', () => {
    // rotated results: 扁平顺序 [a1, b1, a2] 与分类连续布局 (settings=[a1,a2]，actions=[b1])
    // 不一致 —— 旧实现 settings 第二项会落到下标 1（b1）。
    const executeCommand = vi.fn();
    const makeItem = (id: string, labelKey: string, category: CommandCategory): CommandItem => ({
      id,
      labelKey,
      localizedLabel: labelKey,
      keywords: [],
      category,
      action: () => {},
    });
    const a1 = makeItem('a1', 'A1', 'settings');
    const a2 = makeItem('a2', 'A2', 'settings');
    const b1 = makeItem('b1', 'B1', 'actions');
    const makeResult = (item: CommandItem): CommandSearchResult => ({
      item,
      score: 0,
      positions: new Set<number>(),
      highlightIndices: new Set<number>(),
    });
    mockUseCommandPalette.mockImplementation(() => ({
      isOpen: true,
      close: mockClose,
      setQuery: vi.fn(),
      query: 'x',
      results: [makeResult(a1), makeResult(b1), makeResult(a2)],
      groupedResults: {
        settings: [makeResult(a1), makeResult(a2)],
        actions: [makeResult(b1)],
        navigation: [],
      },
      recentItems: [],
      executeCommand,
    }));

    render(<CommandPalette />);
    const dialog = screen.getByRole('dialog');
    const optionOf = (text: string): HTMLElement =>
      screen.getByText(text).closest<HTMLElement>('[role="option"]')!;
    // 箭头导航到扁平下标 2：新旧实现 selectedIndex 相同，但展示层高亮必须落在
    // a2（真实下标 2）。旧实现用"分类起始索引+类内偏移"会高亮成 b1（下标 1）。
    fireEvent.keyDown(dialog, { key: 'ArrowDown' });
    fireEvent.keyDown(dialog, { key: 'ArrowDown' });
    const a2Option = optionOf('A2');
    expect(a2Option.getAttribute('data-selected')).toBe('true');
    expect(optionOf('B1').getAttribute('data-selected')).not.toBe('true');

    // Enter 执行扁平下标 2 的命令 = a2，非交错后的 b1
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(executeCommand).toHaveBeenCalledWith(a2);
  });
});
