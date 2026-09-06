import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

const sidebar = {
  sideBarBookKey: '',
  isSideBarVisible: false,
  setSideBarBookKey: vi.fn(),
  setSideBarVisible: vi.fn(),
  setSearchBarVisible: vi.fn(),
};

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));
vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: () => sidebar,
}));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: () => ({
    getConfig: () => ({ viewSettings: { sideBarTab: 'annotations' } }),
    setConfig: vi.fn(),
  }),
}));

import SearchFloatingButton from '@/app/reader/components/SearchFloatingButton';

afterEach(() => cleanup());

describe('SearchFloatingButton', () => {
  it('opens the sidebar with the search bar', () => {
    render(<SearchFloatingButton bookKey='book-1' />);
    fireEvent.click(screen.getByLabelText('Search'));
    expect(sidebar.setSideBarBookKey).toHaveBeenCalledWith('book-1');
    expect(sidebar.setSideBarVisible).toHaveBeenCalledWith(true);
    expect(sidebar.setSearchBarVisible).toHaveBeenCalledWith(true);
  });

  it('stays visible while the sidebar is open; clicking opens the search bar in place', () => {
    // 规格变更（用户决策）：两颗悬浮按钮常驻，不再在侧栏展开时卸载。
    sidebar.sideBarBookKey = 'book-1';
    sidebar.isSideBarVisible = true;
    render(<SearchFloatingButton bookKey='book-1' />);
    fireEvent.click(screen.getByLabelText('Search'));
    expect(sidebar.setSearchBarVisible).toHaveBeenCalledWith(true);
    expect(sidebar.setSideBarVisible).not.toHaveBeenCalledWith(false);
  });

  it('sits above the TOC button on the same vertical line', () => {
    sidebar.sideBarBookKey = '';
    sidebar.isSideBarVisible = false;
    const { container } = render(<SearchFloatingButton bookKey='book-1' />);
    const button = container.querySelector('button');
    expect(button?.className).toContain('bottom-40');
    expect(button?.className).toContain('right-4');
    expect(button?.className).toContain('w-12');
  });
});
