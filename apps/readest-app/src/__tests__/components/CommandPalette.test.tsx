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

  it('Tab/Shift+Tab 在输入、清除与结果间循环真实 DOM 焦点（Task7）', () => {
    const makeItem = (id: string, labelKey: string, category: CommandCategory): CommandItem => ({
      id,
      labelKey,
      localizedLabel: labelKey,
      keywords: [],
      category,
      action: () => {},
    });
    const makeResult = (item: CommandItem): CommandSearchResult => ({
      item,
      score: 0,
      positions: new Set<number>(),
      highlightIndices: new Set<number>(),
    });
    const a1 = makeItem('a1', 'A1', 'settings');
    const b1 = makeItem('b1', 'B1', 'actions');
    mockUseCommandPalette.mockImplementation(() => ({
      isOpen: true,
      close: mockClose,
      setQuery: vi.fn(),
      query: 'x',
      results: [makeResult(a1), makeResult(b1)],
      groupedResults: {
        settings: [makeResult(a1)],
        actions: [makeResult(b1)],
        navigation: [],
      },
      recentItems: [],
      executeCommand: vi.fn(),
    }));

    render(<CommandPalette />);
    const dialog = screen.getByRole('dialog');
    const input = screen.getByRole('textbox');
    const optionOf = (text: string): HTMLElement =>
      screen.getByText(text).closest<HTMLElement>('[role="option"]')!;

    // 顺序：input → clear → A1 → B1 → input（循环）。jsdom 无真实浏览器 blur/
    // rAF 时序，这里同步断言 handler 移动；blur 抢焦竞态由下方独立用例以
    // "焦点仍在 dialog 内不抢回"验证，并在真机键盘矩阵覆盖。
    input.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByLabelText('Clear search'));
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(optionOf('A1'));
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(optionOf('B1'));
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(input);

    // Shift+Tab 从 input 回到最后一个结果
    input.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(optionOf('B1'));
  });

  it('blur 时焦点仍在 dialog 内不把焦点抢回 input（Task2）', async () => {
    const makeItem = (id: string, labelKey: string, category: CommandCategory): CommandItem => ({
      id,
      labelKey,
      localizedLabel: labelKey,
      keywords: [],
      category,
      action: () => {},
    });
    const makeResult = (item: CommandItem): CommandSearchResult => ({
      item,
      score: 0,
      positions: new Set<number>(),
      highlightIndices: new Set<number>(),
    });
    const a1 = makeItem('a1', 'A1', 'settings');
    mockUseCommandPalette.mockImplementation(() => ({
      isOpen: true,
      close: mockClose,
      setQuery: vi.fn(),
      query: 'x',
      results: [makeResult(a1)],
      groupedResults: { settings: [makeResult(a1)], actions: [], navigation: [] },
      recentItems: [],
      executeCommand: vi.fn(),
    }));

    render(<CommandPalette />);
    const input = screen.getByRole('textbox');
    const option = screen.getByText('A1').closest<HTMLElement>('[role="option"]')!;
    // Tab 已把焦点放到结果按钮上；此时 input 触发 blur（jsdom 同步）——
    // 修复前无条件 rAF 会把焦点抢回 input。
    option.focus();
    fireEvent.blur(input);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(document.activeElement).toBe(option);
  });
});
