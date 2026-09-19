import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ImportFromFolderDialog from '@/app/library/components/ImportFromFolderDialog';
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

const setup = (overrides: Partial<React.ComponentProps<typeof ImportFromFolderDialog>> = {}) => {
  const props = {
    initialDirectory: '/Users/me/Books',
    onPickDirectory: vi.fn(),
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
  const utils = render(
    <DropdownProvider>
      <ImportFromFolderDialog {...props} />
    </DropdownProvider>,
  );
  return { ...utils, props };
};

const confirm = () => fireEvent.click(screen.getByText('OK'));

afterEach(cleanup);

/**
 * Watching a folder is independent of "read books in place": a watched folder
 * that is not read in place has its books copied into the library, and the UI
 * has to say so rather than hiding the option.
 */
describe('Import-from-Folder dialog: auto-import decoupled from read-in-place', () => {
  it('offers the watch checkbox with read-in-place off, and reports it', () => {
    const { props } = setup({ initialReadInPlace: false });

    const checkbox = screen.getByRole('checkbox', { name: /Watch this folder for new books/ });
    expect((checkbox as HTMLInputElement).disabled).toBe(false);

    fireEvent.click(checkbox);
    confirm();

    expect(props.onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ readInPlace: false, autoImport: true }),
    );
  });

  it('warns that books are copied when reading in place is off', () => {
    setup({ initialReadInPlace: false });

    expect(
      screen.getByText(
        'Books are copied into the library, because "Read books in place" is off. Deleting a book from the library does not delete it from the folder.',
      ),
    ).toBeTruthy();
  });

  it('drops the copy warning once reading in place is on', () => {
    setup({ initialReadInPlace: true });

    expect(
      screen.queryByText(
        'Books are copied into the library, because "Read books in place" is off. Deleting a book from the library does not delete it from the folder.',
      ),
    ).toBeNull();
  });

  it('keeps the watch checkbox ticked on a locked external root', () => {
    const { props } = setup({
      isRegisteredExternalRoot: () => true,
      initialAutoImport: true,
    });

    confirm();

    // Read-in-place is forced on for a registered root; the watch choice rides
    // along untouched.
    expect(props.onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ readInPlace: true, autoImport: true }),
    );
  });
});

describe('Import-from-Folder dialog: folder structure modes', () => {
  it('defaults to mirroring and reports the mode it was opened with', () => {
    const { props } = setup({ initialFolderMode: 'mirror' });

    confirm();

    expect(props.onConfirm).toHaveBeenCalledWith(expect.objectContaining({ folderMode: 'mirror' }));
  });

  it('reports the author mode', () => {
    const { props } = setup({ initialFolderMode: 'author' });

    expect(screen.getByText('Group by author')).toBeTruthy();
    confirm();

    expect(props.onConfirm).toHaveBeenCalledWith(expect.objectContaining({ folderMode: 'author' }));
  });

  it('switches to a flat import', () => {
    const { props } = setup({ initialFolderMode: 'colorless' as never });

    fireEvent.click(screen.getByText('Import all into library'));
    confirm();

    expect(props.onConfirm).toHaveBeenCalledWith(expect.objectContaining({ folderMode: 'flat' }));
  });
});

describe('Import-from-Folder dialog: the form describes the picked folder', () => {
  /**
   * The box used to keep whatever value the dialog opened with — seeded from the
   * *last imported* folder. Picking a watched folder whose box read "off" then
   * confirmed with `autoImport: false`, which stopped watching that folder and
   * deleted its rule, silently.
   */
  it('ticks the watch box when the picked folder is watched', async () => {
    const { props } = setup({
      initialAutoImport: false,
      resolveWatchedFolder: (dir) =>
        dir === '/lib/watched' ? { mode: 'author', extensions: ['txt'], minSizeKB: 1 } : undefined,
      onPickDirectory: vi.fn().mockResolvedValue('/lib/watched'),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder' }));
    await screen.findByText('/lib/watched');

    const checkbox = screen.getByRole('checkbox', { name: /Watch this folder for new books/ });
    expect((checkbox as HTMLInputElement).checked).toBe(true);

    confirm();
    expect(props.onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ directory: '/lib/watched', autoImport: true }),
    );
  });

  it('takes the picked folder structure, formats and size from its own rule', async () => {
    const { props } = setup({
      initialFolderMode: 'mirror',
      resolveWatchedFolder: (dir) =>
        dir === '/lib/watched' ? { mode: 'author', extensions: ['txt'], minSizeKB: 3 } : undefined,
      onPickDirectory: vi.fn().mockResolvedValue('/lib/watched'),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder' }));
    await screen.findByText('/lib/watched');

    expect(screen.getByDisplayValue('3')).toBeTruthy();
    confirm();

    // Confirming must not overwrite the watched folder's rule with the values
    // the dialog happened to open with.
    expect(props.onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        folderMode: 'author',
        extensions: ['txt'],
        minSizeKB: 3,
      }),
    );
  });

  it('unticks the box when the picked folder is not watched', async () => {
    const { props } = setup({
      initialAutoImport: true,
      resolveWatchedFolder: () => undefined,
      onPickDirectory: vi.fn().mockResolvedValue('/lib/plain'),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder' }));
    await screen.findByText('/lib/plain');

    const checkbox = screen.getByRole('checkbox', { name: /Watch this folder for new books/ });
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    confirm();
    expect(props.onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ directory: '/lib/plain', autoImport: false }),
    );
  });

  it('keeps an explicit toggle made after picking', async () => {
    const { props } = setup({
      resolveWatchedFolder: (dir) =>
        dir === '/lib/watched' ? { mode: 'author', extensions: ['txt'], minSizeKB: 1 } : undefined,
      onPickDirectory: vi.fn().mockResolvedValue('/lib/watched'),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder' }));
    await screen.findByText('/lib/watched');
    fireEvent.click(screen.getByRole('checkbox', { name: /Watch this folder for new books/ }));

    confirm();
    expect(props.onConfirm).toHaveBeenCalledWith(expect.objectContaining({ autoImport: false }));
  });
});

describe('Import-from-Folder dialog: watched folders entry', () => {
  it('always offers the manager, even with nothing watched yet', () => {
    const { props } = setup({ watchedFolderCount: 0, onManageWatchedFolders: vi.fn() });

    expect(screen.getByText('None')).toBeTruthy();
    fireEvent.click(screen.getByText('Watched Folders'));

    expect(props.onManageWatchedFolders).toHaveBeenCalled();
  });

  it('reports how many folders are watched', () => {
    setup({ watchedFolderCount: 3, onManageWatchedFolders: vi.fn() });

    expect(screen.getByText('3 folder(s)')).toBeTruthy();
  });
});
