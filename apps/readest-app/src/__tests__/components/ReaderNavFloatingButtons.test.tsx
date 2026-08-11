import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));
vi.mock('@/app/reader/hooks/usePagination', () => ({
  viewPagination: vi.fn(),
}));

import { viewPagination } from '@/app/reader/hooks/usePagination';
import ReaderNavFloatingButtons from '@/app/reader/components/ReaderNavFloatingButtons';

const historyBack = vi.fn();
const historyForward = vi.fn();
const view = {
  history: {
    canGoBack: true,
    canGoForward: true,
    back: historyBack,
    forward: historyForward,
  },
};

let viewSettings: Record<string, unknown> = { rtl: false, showChapterNavigationButtons: true };

vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({
    getView: () => view,
    getViewSettings: () => viewSettings,
  }),
}));

afterEach(() => cleanup());
beforeEach(() => {
  vi.mocked(viewPagination).mockClear();
  historyBack.mockClear();
  historyForward.mockClear();
  view.history.canGoBack = true;
  view.history.canGoForward = true;
  viewSettings = { rtl: false, showChapterNavigationButtons: true };
});

describe('ReaderNavFloatingButtons', () => {
  it('stacks chapter and history buttons top to bottom on the left', () => {
    const { container } = render(<ReaderNavFloatingButtons bookKey='book-1' />);
    const stack = container.querySelector('div');
    expect(stack?.className).toContain('bottom-24');
    expect(stack?.className).toContain('left-4');
    expect(stack?.className).toContain('flex-col');
    const labels = Array.from(container.querySelectorAll('button')).map((button) =>
      button.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Previous Section', 'Next Section', 'Go Back', 'Go Forward']);
  });

  it('hides chapter buttons when the chapter navigation toggle is off', () => {
    viewSettings = { rtl: false, showChapterNavigationButtons: false };
    const { container } = render(<ReaderNavFloatingButtons bookKey='book-1' />);
    const labels = Array.from(container.querySelectorAll('button')).map((button) =>
      button.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Go Back', 'Go Forward']);
    expect(screen.queryByLabelText('Previous Section')).toBeNull();
    expect(screen.queryByLabelText('Next Section')).toBeNull();
  });

  it('navigates chapters and reading history', () => {
    render(<ReaderNavFloatingButtons bookKey='book-1' />);
    fireEvent.click(screen.getByLabelText('Previous Section'));
    expect(viewPagination).toHaveBeenCalledWith(view, viewSettings, 'left', 'section');
    fireEvent.click(screen.getByLabelText('Next Section'));
    expect(viewPagination).toHaveBeenCalledWith(view, viewSettings, 'right', 'section');
    fireEvent.click(screen.getByLabelText('Go Back'));
    expect(historyBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Go Forward'));
    expect(historyForward).toHaveBeenCalledTimes(1);
  });

  it('disables history buttons when the history cannot go further', () => {
    view.history.canGoBack = false;
    view.history.canGoForward = false;
    render(<ReaderNavFloatingButtons bookKey='book-1' />);
    expect((screen.getByLabelText('Go Back') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Go Forward') as HTMLButtonElement).disabled).toBe(true);
  });
});
