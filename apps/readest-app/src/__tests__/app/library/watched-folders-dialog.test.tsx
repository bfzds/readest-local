import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import WatchedFoldersDialog, {
  type WatchedFolderRow,
} from '@/app/library/components/WatchedFoldersDialog';
import { DropdownProvider } from '@/context/DropdownContext';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string, options?: Record<string, string | number>) => {
    if (!options) return key;
    return key.replace(/{{(\w+)}}/g, (_match, name) => String(options[name] ?? ''));
  },
}));

vi.mock('@/hooks/useKeyDownActions', () => ({
  useKeyDownActions: () => ({ current: null }),
}));

vi.mock('@/components/Dialog', () => ({
  __esModule: true,
  default: ({
    isOpen,
    title,
    children,
  }: {
    isOpen: boolean;
    title?: string;
    children: React.ReactNode;
  }) =>
    isOpen ? (
      <div role='dialog' aria-label={title}>
        {children}
      </div>
    ) : null,
}));

const AUTHOR_ROW: WatchedFolderRow = {
  path: '/library/Downloads/Pixiv',
  rule: { mode: 'author', extensions: ['txt'], minSizeKB: 1 },
  status: { at: 1_700_000_000_000, imported: 2, failed: 0 },
};

const MIRROR_ROW: WatchedFolderRow = {
  path: '/library/Books',
  rule: { mode: 'mirror', extensions: ['epub', 'pdf'], minSizeKB: 20 },
};

const setup = (overrides: Partial<React.ComponentProps<typeof WatchedFoldersDialog>> = {}) => {
  const props = {
    folders: [AUTHOR_ROW, MIRROR_ROW],
    refreshingPath: null,
    onAddFolder: vi.fn(),
    onRemoveFolder: vi.fn(),
    onSetRule: vi.fn(),
    onRefresh: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(
    <DropdownProvider>
      <WatchedFoldersDialog {...props} />
    </DropdownProvider>,
  );
  return props;
};

afterEach(cleanup);

describe('WatchedFoldersDialog', () => {
  it('lists a row per folder with its own structure mode', () => {
    setup();

    const selects = screen.getAllByLabelText('Folder Structure');
    expect(selects).toHaveLength(2);
    expect(selects[0]!.textContent).toContain('By author');
    expect(selects[1]!.textContent).toContain('Groups');
  });

  it('reports a structure change for the right folder', () => {
    const props = setup();

    fireEvent.click(screen.getAllByLabelText('Folder Structure')[1]!);
    fireEvent.click(screen.getByRole('option', { name: 'By author' }));

    expect(props.onSetRule).toHaveBeenCalledWith('/library/Books', { mode: 'author' });
  });

  it('reports a removal for the right folder', () => {
    const props = setup();

    fireEvent.click(screen.getAllByLabelText('Stop watching')[0]!);

    expect(props.onRemoveFolder).toHaveBeenCalledWith('/library/Downloads/Pixiv');
  });

  it('refreshes a single row and everything', () => {
    const props = setup();

    fireEvent.click(screen.getAllByLabelText('Refresh now')[1]!);
    expect(props.onRefresh).toHaveBeenCalledWith('/library/Books');

    fireEvent.click(screen.getByText('Refresh all'));
    expect(props.onRefresh).toHaveBeenCalledWith();
  });

  it('adds a folder from the header button', () => {
    const props = setup();

    fireEvent.click(screen.getByText('Add Folder'));

    expect(props.onAddFolder).toHaveBeenCalled();
  });

  it('disables every control while a refresh is running', () => {
    setup({ refreshingPath: 'all' });

    expect((screen.getByText('Refresh all') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Add Folder') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByLabelText('Refresh now')[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByLabelText('Stop watching')[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows each folder its own last result', () => {
    setup();

    expect(screen.getByText(/Last scan: 2 new book\(s\)/)).toBeTruthy();
    expect(screen.getByText('Not scanned yet since this setting was added.')).toBeTruthy();
  });

  it('edits formats and minimum size behind the row expander', () => {
    const props = setup();

    // Collapsed by default: the full format list would dominate the row.
    expect(screen.queryByText('Minimum file size (KB)')).toBeNull();

    fireEvent.click(screen.getAllByLabelText('Formats and size')[0]!);
    expect(screen.getByDisplayValue('1')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Minimum file size (KB)'), { target: { value: '5' } });
    expect(props.onSetRule).toHaveBeenCalledWith('/library/Downloads/Pixiv', { minSizeKB: 5 });
  });

  it('refuses to untick the only remaining format', () => {
    const txtOnly: WatchedFolderRow = {
      path: '/library/Downloads/Pixiv',
      rule: { mode: 'author', extensions: ['txt'], minSizeKB: 1 },
    };
    const props = setup({ folders: [txtOnly] });

    fireEvent.click(screen.getAllByLabelText('Formats and size')[0]!);
    const txt = screen.getByRole('checkbox', { name: 'TXT' }) as HTMLInputElement;
    expect(txt.checked).toBe(true);

    fireEvent.click(txt);

    // An empty selection would silently stop importing anything at all.
    expect(props.onSetRule).not.toHaveBeenCalled();
    expect(txt.checked).toBe(true);
  });

  it('adds a format to the selection', () => {
    const props = setup({ folders: [MIRROR_ROW] });

    fireEvent.click(screen.getAllByLabelText('Formats and size')[0]!);
    fireEvent.click(screen.getByRole('checkbox', { name: 'TXT' }));

    expect(props.onSetRule).toHaveBeenCalledWith('/library/Books', {
      extensions: ['epub', 'pdf', 'txt'],
    });
  });

  /**
   * Groups span several extensions (MOBI/AZW/AZW3, CBZ/ZIP) and the scan
   * filters on extensions, so flipping only the group's first one left the rest
   * being imported while the box read empty.
   */
  it('toggles every extension of a multi-extension group', () => {
    const multi = {
      ...MIRROR_ROW,
      rule: { mode: 'mirror' as const, extensions: ['epub', 'mobi', 'azw', 'azw3'], minSizeKB: 20 },
    };
    const props = setup({ folders: [multi] });

    fireEvent.click(screen.getAllByLabelText('Formats and size')[0]!);
    fireEvent.click(screen.getByRole('checkbox', { name: 'MOBI/AZW/AZW3' }));

    expect(props.onSetRule).toHaveBeenCalledWith('/library/Books', { extensions: ['epub'] });
  });

  it('adds every extension of a multi-extension group', () => {
    const props = setup({ folders: [MIRROR_ROW] });

    fireEvent.click(screen.getAllByLabelText('Formats and size')[0]!);
    fireEvent.click(screen.getByRole('checkbox', { name: 'CBZ/ZIP' }));

    expect(props.onSetRule).toHaveBeenCalledWith('/library/Books', {
      extensions: ['epub', 'pdf', 'cbz', 'zip'],
    });
  });
});
