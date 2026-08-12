import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

import { Book } from '@/types/book';
import BookDetailView from '@/components/metadata/BookDetailView';
import { DropdownProvider } from '@/context/DropdownContext';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: {
      metadataSeriesCollapsed: true,
      // The "File Path" entry lives under the Metadata section; tests below
      // depend on it being expanded by default so the row is in the DOM.
      metadataOthersCollapsed: false,
      metadataDescriptionCollapsed: true,
    },
  }),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService: null }),
}));

vi.mock('@/helpers/settings', () => ({
  saveSysSettings: vi.fn(),
}));

vi.mock('@/components/BookCover', () => ({
  __esModule: true,
  default: () => null,
}));

vi.mock('@/hooks/useResponsiveSize', () => ({
  useResponsiveSize: (n: number) => n,
  useDefaultIconSize: () => 20,
}));

vi.mock('next/image', () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    // biome-ignore lint/a11y/useAltText: test mock
    return <img {...props} />;
  },
}));

afterEach(() => cleanup());

const makeBook = (overrides?: Partial<Book>): Book =>
  ({
    hash: 'abc123',
    title: 'Test Book',
    author: 'Test Author',
    format: 'EPUB',
    coverImageUrl: 'https://example.com/cover.jpg',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    downloadedAt: Date.now(),
    uploadedAt: Date.now(),
    ...overrides,
  }) as Book;

const renderView = (extra?: Partial<React.ComponentProps<typeof BookDetailView>>) =>
  render(
    <DropdownProvider>
      <BookDetailView book={makeBook()} metadata={null} fileSize={1024} {...extra} />
    </DropdownProvider>,
  );

describe('BookDetailView More menu', () => {
  const openMore = (container: HTMLElement) => {
    const toggle = container.querySelector('button[aria-label="More Actions"]');
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle!);
  };

  it('opens the More Actions menu', () => {
    const { container } = renderView();
    expect(container.querySelector('button[aria-label="More Actions"]')).toBeTruthy();
    openMore(container);
  });

  it('keeps Export in the More menu and calls onExport when the file exists', () => {
    const onExport = vi.fn();
    const { container, getByText } = renderView({ onExport, fileSize: 1024 });
    openMore(container);
    const exportButton = getByText('Export Book').closest('button');
    expect(exportButton).toBeTruthy();
    expect(exportButton!.disabled).toBe(false);
    fireEvent.click(exportButton!);
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it('disables Export when the book has no local file', () => {
    const onExport = vi.fn();
    const { container, getByText } = renderView({ onExport, fileSize: null });
    openMore(container);
    const exportButton = getByText('Export Book').closest('button');
    expect(exportButton!.disabled).toBe(true);
    fireEvent.click(exportButton!);
    expect(onExport).not.toHaveBeenCalled();
  });
});

describe('BookDetailView file path row', () => {
  // book.filePath is only set for in-place imports (and OS-handed paths like
  // Android "Open with Readest"). Hash-copy imports leave it undefined, so
  // surfacing it lets users tell the two storage modes apart at a glance.
  it('shows the actual file path when book.filePath is set', () => {
    const filePath = '/Users/me/Library/Books/sample.epub';
    const { getByText } = renderView({ book: makeBook({ filePath }) });

    expect(getByText('File Path')).toBeTruthy();
    const value = getByText(filePath);
    expect(value).toBeTruthy();
    // Long paths must remain hoverable for the full string.
    expect(value.getAttribute('title')).toBe(filePath);
  });

  it('omits the file path row for hash-copy books (no filePath)', () => {
    const { queryByText } = renderView({ book: makeBook() });
    expect(queryByText('File Path')).toBeNull();
  });
});

describe('BookDetailView page count', () => {
  // The page count is only known once the book has been laid out by the
  // reader, so it rides on book.progress ([current, total]) instead of being
  // computed at import time (#5516).
  it('shows the total page count of an opened book', () => {
    const { getByText } = renderView({ book: makeBook({ progress: [42, 317] }) });

    expect(getByText('Pages')).toBeTruthy();
    expect(getByText('317')).toBeTruthy();
  });

  it('falls back to Unknown for a book that has never been opened', () => {
    const { getByText } = renderView({ book: makeBook() });

    const label = getByText('Pages');
    expect(label.parentElement!.textContent).toContain('Unknown');
  });
});

describe('BookDetailView tags and subjects', () => {
  it('normalizes clicked tag and subject values before shelf navigation', () => {
    const onMetadataValueClick = vi.fn();
    const { getByText } = renderView({
      book: makeBook({ tags: [' Favorite '] }),
      metadata: {
        title: 'Test Book',
        author: 'Test Author',
        language: 'en',
        subject: ['History'],
      },
      onMetadataValueClick,
    });

    fireEvent.click(getByText('History'));
    expect(onMetadataValueClick).toHaveBeenCalledWith('subject', 'History');
    fireEvent.click(getByText('Favorite'));
    expect(onMetadataValueClick).toHaveBeenCalledWith('tag', 'Favorite');
  });
});
