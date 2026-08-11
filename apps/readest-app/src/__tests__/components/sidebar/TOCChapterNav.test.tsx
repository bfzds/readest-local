import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

const view = { renderer: { prevSection: vi.fn(), nextSection: vi.fn() } };
const viewSettings = {};
const { viewPagination } = vi.hoisted(() => ({ viewPagination: vi.fn() }));
const { progressState } = vi.hoisted(() => ({
  progressState: { index: 0, section: { total: 3 }, sectionLabel: 'Chapter 1' },
}));

const readerStoreState = {
  getView: () => view,
  getViewSettings: () => viewSettings,
};

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: (selector?: (state: typeof readerStoreState) => unknown) =>
    selector ? selector(readerStoreState) : readerStoreState,
}));
vi.mock('@/store/readerProgressStore', () => ({
  useBookProgress: () => progressState,
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: (selector?: (state: { getBookData: () => unknown }) => unknown) => {
    const state = { getBookData: () => ({ bookDoc: { sections: [{}, {}, {}] } }) };
    return selector ? selector(state) : state;
  },
}));
vi.mock('@/app/reader/hooks/usePagination', () => ({ viewPagination }));

import TOCChapterNav from '@/app/reader/components/sidebar/TOCChapterNav';

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  progressState.index = 0;
});

describe('TOCChapterNav', () => {
  it('disables Previous Chapter on the first chapter', () => {
    render(<TOCChapterNav bookKey='book-1' />);
    expect(
      (screen.getByText('Previous Chapter').closest('button') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByText('Next Chapter').closest('button') as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.getByText('Chapter 1')).toBeDefined();
  });

  it('calls viewPagination with up/section for Previous Chapter', () => {
    progressState.index = 1;
    render(<TOCChapterNav bookKey='book-1' />);
    fireEvent.click(screen.getByText('Previous Chapter'));
    expect(viewPagination).toHaveBeenCalledWith(view, viewSettings, 'up', 'section');
  });

  it('calls viewPagination with down/section for Next Chapter', () => {
    render(<TOCChapterNav bookKey='book-1' />);
    fireEvent.click(screen.getByText('Next Chapter'));
    expect(viewPagination).toHaveBeenCalledWith(view, viewSettings, 'down', 'section');
  });
});
