import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

import TOCFloatingButton from '@/app/reader/components/TOCFloatingButton';
import SearchFloatingButton from '@/app/reader/components/SearchFloatingButton';
import { useSidebarStore } from '@/store/sidebarStore';

/**
 * 悬浮按钮切换语义回归（用户决策：两颗按钮常驻，目录按钮变切换）：
 *
 * 此前 SearchFloatingButton / TOCFloatingButton 在侧栏为本书展开时直接
 * return null（按钮"消失"）。改为常驻后：
 *   - 「目录」按钮在侧栏展开时点击 = 收起侧栏（toggle），label 说明动作；
 *   - 「搜索」按钮侧栏展开时点击 = 在展开的侧栏里打开搜索栏。
 * 测试直接驱动真实 zustand store（不 mock 模块），断言状态变化。
 */

const BOOK_KEY = 'hash-1-uid1';

beforeEach(() => {
  useSidebarStore.setState({
    sideBarBookKey: null,
    isSideBarVisible: false,
    isSearchBarVisible: false,
  });
});

afterEach(() => cleanup());

describe('TOCFloatingButton（常驻 + 切换语义）', () => {
  it('侧栏为本书展开时仍然渲染（不再卸载）', () => {
    useSidebarStore.setState({ sideBarBookKey: BOOK_KEY, isSideBarVisible: true });
    render(<TOCFloatingButton bookKey={BOOK_KEY} />);
    expect(screen.queryByRole('button')).not.toBeNull();
  });

  it('侧栏展开时 label 说明动作是关闭，点击后收起侧栏', () => {
    useSidebarStore.setState({ sideBarBookKey: BOOK_KEY, isSideBarVisible: true });
    render(<TOCFloatingButton bookKey={BOOK_KEY} />);
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(useSidebarStore.getState().isSideBarVisible).toBe(false);
  });

  it('侧栏收起时点击 → 打开本书目录（原行为不变）', () => {
    useSidebarStore.setState({ sideBarBookKey: null, isSideBarVisible: false });
    render(<TOCFloatingButton bookKey={BOOK_KEY} />);
    fireEvent.click(screen.getByRole('button', { name: 'Table of Contents' }));
    const state = useSidebarStore.getState();
    expect(state.isSideBarVisible).toBe(true);
    expect(state.sideBarBookKey).toBe(BOOK_KEY);
  });

  it('侧栏为其他书展开时点击 → 切换到本书目录（原行为不变）', () => {
    useSidebarStore.setState({ sideBarBookKey: 'hash-2-uid2', isSideBarVisible: true });
    render(<TOCFloatingButton bookKey={BOOK_KEY} />);
    fireEvent.click(screen.getByRole('button', { name: 'Table of Contents' }));
    const state = useSidebarStore.getState();
    expect(state.isSideBarVisible).toBe(true);
    expect(state.sideBarBookKey).toBe(BOOK_KEY);
  });
});

describe('SearchFloatingButton（常驻）', () => {
  it('侧栏为本书展开时仍然渲染（不再卸载）', () => {
    useSidebarStore.setState({ sideBarBookKey: BOOK_KEY, isSideBarVisible: true });
    render(<SearchFloatingButton bookKey={BOOK_KEY} />);
    expect(screen.queryByRole('button')).not.toBeNull();
  });

  it('侧栏展开时点击 → 在展开的侧栏里打开搜索栏', () => {
    useSidebarStore.setState({ sideBarBookKey: BOOK_KEY, isSideBarVisible: true });
    render(<SearchFloatingButton bookKey={BOOK_KEY} />);
    fireEvent.click(screen.getByRole('button'));
    const state = useSidebarStore.getState();
    expect(state.isSearchBarVisible).toBe(true);
    expect(state.isSideBarVisible).toBe(true);
    expect(state.sideBarBookKey).toBe(BOOK_KEY);
  });

  it('侧栏收起时点击 → 打开侧栏并显示搜索栏（原行为不变）', () => {
    useSidebarStore.setState({ sideBarBookKey: null, isSideBarVisible: false });
    render(<SearchFloatingButton bookKey={BOOK_KEY} />);
    fireEvent.click(screen.getByRole('button'));
    const state = useSidebarStore.getState();
    expect(state.isSideBarVisible).toBe(true);
    expect(state.isSearchBarVisible).toBe(true);
    expect(state.sideBarBookKey).toBe(BOOK_KEY);
  });
});
