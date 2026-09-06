import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react';

import { Book } from '@/types/book';
import BookDetailModal from '@/components/metadata/BookDetailModal';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

const appSvc = {
  getBookFileSize: vi.fn(async () => 1024),
  fetchBookDetails: vi.fn(async () => null),
};

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: { getAppService: async () => appSvc }, appService: appSvc }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
}));

vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({ safeAreaInsets: { top: 0, bottom: 0, left: 0, right: 0 } }),
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: {
      metadataSeriesCollapsed: true,
      metadataOthersCollapsed: true,
      metadataDescriptionCollapsed: true,
    },
  }),
}));

vi.mock('@/hooks/useFileSelector', () => ({
  useFileSelector: () => ({ selectFiles: vi.fn() }),
}));

vi.mock('@/hooks/useResponsiveSize', () => ({
  useResponsiveSize: (n: number) => n,
  useDefaultIconSize: () => 20,
}));

vi.mock('@/helpers/settings', () => ({ saveSysSettings: vi.fn() }));

vi.mock('@/libs/metadata', () => ({ searchMetadata: vi.fn(async () => []) }));

// Render the cover with the same src-resolution as the real <BookCover> so we
// can assert which cover the view actually shows.
vi.mock('@/components/BookCover', () => ({
  __esModule: true,
  default: ({ book }: { book: Book }) => (
    // biome-ignore lint/a11y/useAltText: test mock
    <img data-testid='cover' src={book.metadata?.coverImageUrl || book.coverImageUrl || ''} />
  ),
}));

vi.mock('next/image', () => ({
  __esModule: true,
  // biome-ignore lint/a11y/useAltText: test mock
  default: (props: Record<string, unknown>) => <img {...props} />,
}));

// Chrome we don't exercise — keep imports cheap and side-effect free. The mock
// forwards Escape to onClose so close-attempt flows stay testable.
vi.mock('@/components/Dialog', () => ({
  __esModule: true,
  default: ({
    children,
    isOpen,
    onClose,
  }: {
    children: React.ReactNode;
    isOpen: boolean;
    onClose: () => void;
  }) =>
    isOpen ? (
      // biome-ignore lint/a11y/noStaticElementInteractions: test mock
      <div
        data-testid='dialog-mock'
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        {children}
      </div>
    ) : null,
}));
vi.mock('@/components/metadata/SourceSelector', () => ({ __esModule: true, default: () => null }));
vi.mock('@/components/Spinner', () => ({ __esModule: true, default: () => null }));

afterEach(() => cleanup());

const makeBook = (): Book =>
  ({
    hash: 'abc123',
    title: 'Old Title',
    author: 'Old Author',
    format: 'EPUB',
    coverImageUrl: 'old-cover',
    primaryLanguage: 'en',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {
      title: 'Old Title',
      author: 'Old Author',
      language: 'en',
      coverImageUrl: 'old-cover',
    },
  }) as Book;

describe('BookDetailModal cover refresh after save', () => {
  it('updates the Book Details view cover when the cover is edited and saved', async () => {
    const book = makeBook();
    const onUpdate = vi.fn();
    render(
      <BookDetailModal book={book} isOpen onClose={vi.fn()} handleBookMetadataUpdate={onUpdate} />,
    );

    // The view initially shows the original cover.
    await waitFor(() => expect(screen.getByTestId('cover').getAttribute('src')).toBe('old-cover'));

    // Edit → remove the cover → save.
    fireEvent.click(screen.getByTitle('Edit Metadata'));
    fireEvent.click(await screen.findByTitle('Remove cover image'));
    fireEvent.click(screen.getByText('Save'));

    expect(onUpdate).toHaveBeenCalledTimes(1);

    // The details view must reflect the saved cover change without needing the
    // modal to be reopened (the bug: it kept showing the stale `book` prop).
    await waitFor(() => {
      expect(screen.getByTestId('cover').getAttribute('src')).not.toBe('old-cover');
    });
    expect(screen.getByTestId('cover').getAttribute('src')).toBe('_blank');
  });
});

describe('BookDetailModal unsaved-edit guard', () => {
  const openEditMode = async () => {
    const book = makeBook();
    const onClose = vi.fn();
    // The edit entry point only renders when a metadata-update handler exists.
    render(
      <BookDetailModal book={book} isOpen onClose={onClose} handleBookMetadataUpdate={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByTestId('cover')).toBeDefined());
    fireEvent.click(screen.getByTitle('Edit Metadata'));
    return { onClose };
  };

  it('closes immediately on Esc when not editing or unchanged', async () => {
    const { onClose } = await openEditMode();

    fireEvent.keyDown(screen.getByTestId('dialog-mock'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Discard unsaved changes?')).toBeNull();
  });

  it('offers a confirm on Esc while editing with unsaved changes', async () => {
    const { onClose } = await openEditMode();

    // Make the draft dirty, then press Esc.
    fireEvent.click(await screen.findByTitle('Remove cover image'));
    fireEvent.keyDown(screen.getByTestId('dialog-mock'), { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Discard unsaved changes?')).toBeDefined();

    // Discard closes the modal for real.
    fireEvent.click(screen.getByText('Discard').closest('button')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps editing when the confirm is cancelled', async () => {
    const { onClose } = await openEditMode();

    fireEvent.click(await screen.findByTitle('Remove cover image'));
    fireEvent.keyDown(screen.getByTestId('dialog-mock'), { key: 'Escape' });
    // 'Cancel' also exists on the edit form; the confirm alert's button is the last one.
    const cancelButtons = screen.getAllByText('Cancel');
    fireEvent.click(cancelButtons[cancelButtons.length - 1]!.closest('button')!);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText('Discard unsaved changes?')).toBeNull();
  });
});
