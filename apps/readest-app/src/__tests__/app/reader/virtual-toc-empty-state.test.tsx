// 侧栏目录空态（Task 6）：目录元数据缺失/退化时，TOC 面板给出「从正文生成目录」入口，
// 让用户能把正文合成的虚拟目录写进书籍 config；目录健康时不出现该入口。
import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import Content from '@/app/reader/components/sidebar/Content';

// 由 mock 的 getBookData 读取，供「非 EPUB」用例覆写；默认 EPUB 让既有用例保持原语义。
const mockBook = vi.hoisted(() => ({ format: 'EPUB' as string }));

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
    // R14：入口与弹窗挂载两处都要看书籍格式，格式从 store 取（Content 的 props
    // 里没有 book）。格式可变，供「非 EPUB」用例覆写。
    getBookData: () => ({ book: { format: mockBook.format } }),
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

// 退化判据要按 section 路径比对锚点，夹具必须给 splitTOCHref（EPUB 形态）。
const makeProps = (toc: unknown, bookDocOverrides: Record<string, unknown> = {}) =>
  ({
    bookDoc: {
      toc,
      sections: [{ id: 's1' }, { id: 's2' }],
      rendition: { layout: 'reflowable' },
      metadata: {},
      splitTOCHref: (href: string) => href.split('#'),
      ...bookDocOverrides,
    },
    sideBarBookKey: 'k1',
  }) as unknown as ContentProps;

// 样本书形态：NCX 3 条结构条目（信息/目录/全文）全部无锚点地指向同一个巨型文件。
const structuralToc = [
  { id: 1, label: '信息', href: 'page-0.html', index: 0, subitems: [] },
  { id: 2, label: '目录', href: 'page-0.html', index: 0, subitems: [] },
  { id: 3, label: '全文', href: 'page-0.html', index: 0, subitems: [] },
];
const slabSections = [{ id: 'page-0.html', size: 300 * 1024, linear: 'yes' }];
// 每章一个文件、远小于 slab 阈值的健康分章书。
const healthySections = [
  { id: 'chap-1.html', size: 32 * 1024, linear: 'yes' },
  { id: 'chap-2.html', size: 32 * 1024, linear: 'yes' },
];

describe('侧栏 TOC 空态', () => {
  afterEach(() => {
    cleanup();
    mockBook.format = 'EPUB';
  });

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

  it('单 section 的书仍显示生成入口（从正文正则扫描的主战场）', () => {
    render(<Content {...makeProps([], { sections: [{ id: 's1' }] })} />);
    expect(screen.getByRole('button', { name: GENERATE_ENTRY })).toBeTruthy();
  });

  it('空目录时不渲染章节导航，避免空态与导航同时出现', () => {
    render(<Content {...makeProps([])} />);
    expect(screen.queryByTestId('toc-chapter-nav')).toBeNull();
  });

  it('目录非空时渲染章节导航', () => {
    render(<Content {...makeProps([tocItem])} />);
    expect(screen.getByTestId('toc-chapter-nav')).toBeTruthy();
  });

  it('toc 3 条 + slab（退化非空）时 TOCView 与生成入口同时出现', () => {
    render(<Content {...makeProps(structuralToc, { sections: slabSections })} />);
    expect(screen.getByTestId('toc-view')).toBeTruthy();
    expect(screen.getByRole('button', { name: GENERATE_ENTRY })).toBeTruthy();
  });

  it('toc 3 条 + 无 slab（健康分章书）时只有 TOCView、无生成入口', () => {
    render(<Content {...makeProps(structuralToc, { sections: healthySections })} />);
    expect(screen.getByTestId('toc-view')).toBeTruthy();
    expect(screen.queryByRole('button', { name: GENERATE_ENTRY })).toBeNull();
  });

  // R41：无 slab 的书首次生成后，toc 非空且不退化——旧的入口条件把它判死，
  // 用户无法重新生成或改 pattern。只要 toc 已含虚拟条目（href 是 CFI 串，即
  // config 落盘形态），入口必须保持可见（与 TOCView 并列，同退化非空形态）。
  it('无 slab 书 toc 已含 CFI 虚拟条目时生成入口仍渲染', () => {
    const virtualToc = [{ id: -1, label: '第一章 开端', href: 'epubcfi(/6/4!/4/2)', index: 0 }];
    render(<Content {...makeProps(virtualToc, { sections: healthySections })} />);
    expect(screen.getByTestId('toc-view')).toBeTruthy();
    expect(screen.getByRole('button', { name: GENERATE_ENTRY })).toBeTruthy();
  });

  it('非 EPUB（MOBI）即使目录退化也不给生成入口', () => {
    mockBook.format = 'MOBI';
    render(<Content {...makeProps(structuralToc, { sections: slabSections })} />);
    expect(screen.getByTestId('toc-view')).toBeTruthy();
    expect(screen.queryByRole('button', { name: GENERATE_ENTRY })).toBeNull();
  });

  it('非 EPUB（MOBI）空目录时不给生成入口', () => {
    mockBook.format = 'MOBI';
    render(<Content {...makeProps([])} />);
    expect(screen.queryByRole('button', { name: GENERATE_ENTRY })).toBeNull();
  });
});
