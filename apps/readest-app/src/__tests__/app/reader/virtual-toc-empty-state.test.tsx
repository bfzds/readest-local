// 侧栏目录空态（Task 6）：目录元数据缺失/退化时，TOC 面板给出「从正文生成目录」入口，
// 让用户能把正文合成的虚拟目录写进书籍 config；目录健康时不出现该入口。
import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import Content from '@/app/reader/components/sidebar/Content';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));

vi.mock('@/store/readerStore', () => ({
  useReaderStore: () => ({ setHoveredBookKey: vi.fn() }),
}));

vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: () => ({ setSideBarVisible: vi.fn(), setSearchBarVisible: vi.fn() }),
}));

vi.mock('@/store/bookDataStore', () => {
  const state = {
    getConfig: () => ({ viewSettings: { sideBarTab: 'toc' } }),
    setConfig: vi.fn(),
  };
  return {
    useBookDataStore: (selector?: (s: typeof state) => unknown) =>
      selector ? selector(state) : state,
  };
});

// 重的子组件一律 stub，用例只关心「空态入口出现/不出现」这一件事。
vi.mock('overlayscrollbars-react', () => ({
  OverlayScrollbarsComponent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/app/reader/components/sidebar/TOCView', () => ({
  default: () => <div data-testid='toc-view' />,
}));
vi.mock('@/app/reader/components/sidebar/BooknoteView', () => ({ default: () => null }));
vi.mock('@/app/reader/components/sidebar/TabNavigation', () => ({ default: () => null }));
vi.mock('@/app/reader/components/sidebar/TOCChapterNav', () => ({
  default: () => <div data-testid='toc-chapter-nav' />,
}));

const GENERATE_ENTRY = 'Generate TOC from content';

type ContentProps = ComponentProps<typeof Content>;

const tocItem = { id: 1, label: 'a', href: 'h', index: 0, subitems: [] };

const makeProps = (toc: unknown, bookDocOverrides: Record<string, unknown> = {}) =>
  ({
    bookDoc: {
      toc,
      sections: [{ id: 's1' }, { id: 's2' }],
      rendition: { layout: 'reflowable' },
      metadata: {},
      ...bookDocOverrides,
    },
    sideBarBookKey: 'k1',
  }) as unknown as ContentProps;

describe('侧栏 TOC 空态', () => {
  afterEach(cleanup);

  it('toc 为空数组时显示「从正文生成目录」入口', () => {
    render(<Content {...makeProps([])} />);
    expect(screen.getByRole('button', { name: GENERATE_ENTRY })).toBeTruthy();
  });

  it('toc 为 undefined 时同样显示该入口', () => {
    render(<Content {...makeProps(undefined)} />);
    expect(screen.getByRole('button', { name: GENERATE_ENTRY })).toBeTruthy();
  });

  it('toc 有条目时渲染 TOCView 且不显示生成入口', () => {
    render(<Content {...makeProps([tocItem])} />);
    expect(screen.getByTestId('toc-view')).toBeTruthy();
    expect(screen.queryByRole('button', { name: GENERATE_ENTRY })).toBeNull();
  });

  it('fixed-layout（pre-paginated）没有可生成的虚拟目录，只显示无目录文案', () => {
    render(<Content {...makeProps([], { rendition: { layout: 'pre-paginated' } })} />);
    expect(screen.queryByRole('button', { name: GENERATE_ENTRY })).toBeNull();
    expect(screen.getByText('No TOC')).toBeTruthy();
  });

  it('无 sections 时无从扫描正文，只显示无目录文案', () => {
    render(<Content {...makeProps([], { sections: [] })} />);
    expect(screen.queryByRole('button', { name: GENERATE_ENTRY })).toBeNull();
    expect(screen.getByText('No TOC')).toBeTruthy();
  });

  it('空目录时不渲染章节导航，避免空态与导航同时出现', () => {
    render(<Content {...makeProps([])} />);
    expect(screen.queryByTestId('toc-chapter-nav')).toBeNull();
  });

  it('目录非空时渲染章节导航', () => {
    render(<Content {...makeProps([tocItem])} />);
    expect(screen.getByTestId('toc-chapter-nav')).toBeTruthy();
  });
});
