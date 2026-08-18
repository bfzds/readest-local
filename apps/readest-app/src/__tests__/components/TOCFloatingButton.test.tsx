import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

const sidebar = {
  sideBarBookKey: '',
  isSideBarVisible: false,
  setSideBarBookKey: vi.fn(),
  setSideBarVisible: vi.fn(),
  setSearchBarVisible: vi.fn(),
  clearSearch: vi.fn(),
};

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));
vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: () => sidebar,
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({ setHoveredBookKey: vi.fn(), getView: () => ({ clearSearch: vi.fn() }) }),
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getConfig: () => ({ viewSettings: { sideBarTab: 'toc' } }),
    setConfig: vi.fn(),
  }),
}));

import TOCFloatingButton from '@/app/reader/components/TOCFloatingButton';

afterEach(() => cleanup());

describe('TOCFloatingButton', () => {
  it('opens the sidebar with the TOC tab', () => {
    render(<TOCFloatingButton bookKey='book-1' />);
    fireEvent.click(screen.getByLabelText('Table of Contents'));
    expect(sidebar.setSideBarBookKey).toHaveBeenCalledWith('book-1');
    expect(sidebar.setSideBarVisible).toHaveBeenCalledWith(true);
    // Opening the TOC must dismiss any lingering in-book search state so the
    // TOC panel (not the stale search panel) is shown.
    expect(sidebar.setSearchBarVisible).toHaveBeenCalledWith(false);
    expect(sidebar.clearSearch).toHaveBeenCalledWith('book-1');
  });

  it('is hidden while the sidebar is open for the same book', () => {
    sidebar.sideBarBookKey = 'book-1';
    sidebar.isSideBarVisible = true;
    render(<TOCFloatingButton bookKey='book-1' />);
    expect(screen.queryByLabelText('Table of Contents')).toBeNull();
  });
});
