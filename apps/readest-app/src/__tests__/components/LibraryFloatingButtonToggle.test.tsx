import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

const viewSettings: Record<string, unknown> = {
  showGoToLibraryButton: true,
  showHeader: false,
  showFooter: false,
  vertical: false,
  scrolled: false,
  readingRulerEnabled: false,
  gapPercent: 0,
  doubleBorder: false,
};

vi.mock('@/store/readerStore', () => ({
  useReaderStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      viewStates: {
        'book-1': {
          viewerKey: 'viewer-1',
          viewSettings,
          inited: true,
        },
      },
      hoveredBookKey: null,
    }),
}));

const bookDataStore = {
  getConfig: () => ({ viewSettings }),
  getBookData: () => ({
    book: { title: 'Test Book', format: 'epub' },
    bookDoc: { toc: [] },
  }),
};

vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: (selector: (store: typeof bookDataStore) => unknown) => selector(bookDataStore),
}));

vi.mock('@/store/readerProgressStore', () => ({
  useBookProgress: () => ({}),
}));

vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({ safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 } }),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: {} }),
}));

vi.mock('@/app/reader/hooks/useContentInsets', () => ({
  useContentInsets: () => ({ viewInsets: {}, contentInsets: {} }),
}));

// Heavy reader chrome is out of scope for the floating-button visibility
// toggle test.
vi.mock('@/app/reader/components/FoliateViewer', () => ({ default: () => null }));
vi.mock('@/app/reader/components/HeaderBar', () => ({ default: () => null }));
vi.mock('@/app/reader/components/SectionInfo', () => ({ default: () => null }));
vi.mock('@/app/reader/components/HintInfo', () => ({ default: () => null }));
vi.mock('@/app/reader/components/ProgressBar', () => ({ default: () => null }));
vi.mock('@/app/reader/components/PageNavigationButtons', () => ({
  default: () => null,
}));
vi.mock('@/app/reader/components/ReaderNavFloatingButtons', () => ({
  default: () => null,
}));
vi.mock('@/app/reader/components/SearchFloatingButton', () => ({ default: () => null }));
vi.mock('@/app/reader/components/TOCFloatingButton', () => ({ default: () => null }));
vi.mock('@/app/reader/components/BookmarkPullDown', () => ({ default: () => null }));
vi.mock('@/app/reader/components/annotator/Annotator', () => ({ default: () => null }));
vi.mock('@/app/reader/components/sidebar/SearchResultsNav', () => ({ default: () => null }));
vi.mock('@/app/reader/components/sidebar/BooknotesNav', () => ({ default: () => null }));
vi.mock('@/app/reader/components/FootnotePopup', () => ({ default: () => null }));
vi.mock('@/app/reader/components/footerbar/FooterBar', () => ({ default: () => null }));
vi.mock('@/app/reader/components/ReadingStatsTracker', () => ({ default: () => null }));

import { BookCellInner } from '@/app/reader/components/BooksGrid';

const props = {
  bookKey: 'book-1',
  index: 0,
  gridInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  screenInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  appServiceHasRoundedWindow: false,
  isHoveredAnim: false,
  hoveredBookKey: null,
  isDropdownOpen: false,
  setDropdownOpenForBook: vi.fn(),
  onCloseBook: vi.fn(),
  onGoToLibrary: vi.fn(),
};

beforeEach(() => {
  viewSettings['showGoToLibraryButton'] = true;
});

afterEach(() => cleanup());

describe('LibraryFloatingButton integration', () => {
  it('renders the floating library button when showGoToLibraryButton is on', () => {
    render(<BookCellInner {...props} />);
    expect(screen.getByLabelText('Back to library')).toBeTruthy();
  });

  it('omits the floating library button when showGoToLibraryButton is off', () => {
    viewSettings['showGoToLibraryButton'] = false;
    render(<BookCellInner {...props} />);
    expect(screen.queryByLabelText('Back to library')).toBeNull();
  });
});
