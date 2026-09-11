// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import { findActiveLocationKey, StaticListRow } from '@/app/reader/components/sidebar/TOCItem';
import type { TOCItem } from '@/libs/document';

afterEach(() => cleanup());

// 虚拟条目的 href 恒为 CFI 串（section 的 href 形如 OEBASE/page-0.html），
// 所以 href 相等永远判不出"当前章节"；只能靠 location 区间。
const virtualItem = (label: string, location: TOCItem['location']): TOCItem => ({
  id: -1,
  label,
  href: `epubcfi(/6/4!/4/${label})`,
  index: 0,
  location,
});

const keyOf = (item: TOCItem) => `${item.location!.current}:${item.location!.next}`;

describe('findActiveLocationKey（虚拟条目的当前章节判定）', () => {
  const toc: TOCItem[] = [
    virtualItem('1', { current: 0, next: 100, total: 1000 }),
    virtualItem('2', { current: 100, next: 250, total: 1000 }),
    virtualItem('3', { current: 250, next: 1000, total: 1000 }),
  ];

  it('progress 为 null 时不高亮任何虚拟条目', () => {
    expect(findActiveLocationKey(toc, null)).toBeNull();
  });

  it('fraction × total 落在区间内 → 该条目的 location key', () => {
    // 0.15 × 1000 = 150 ∈ [100, 250)
    expect(findActiveLocationKey(toc, 0.15)).toBe(keyOf(toc[1]!));
    // 0.99 × 1000 = 990 ∈ [250, 1000)（末条 next = total 兜底）
    expect(findActiveLocationKey(toc, 0.99)).toBe(keyOf(toc[2]!));
  });

  it('区间边界：current 含、next 不含', () => {
    // 0.1 × 1000 = 100 = 第 2 条的 current（含）
    expect(findActiveLocationKey(toc, 0.1)).toBe(keyOf(toc[1]!));
    // 第 1 条的 [0, 100) 已不含 100
    expect(findActiveLocationKey(toc, 0.1)).not.toBe(keyOf(toc[0]!));
  });

  it('没有带 location 的条目、或 total 非正 → 不高亮', () => {
    expect(
      findActiveLocationKey([{ id: 0, label: 'a', href: 'a.html', index: 0 }], 0.5),
    ).toBeNull();
    expect(
      findActiveLocationKey([virtualItem('1', { current: 0, next: 10, total: 0 })], 0.5),
    ).toBeNull();
  });
});

describe('虚拟条目的书本图标（当前章节高亮）', () => {
  const current = virtualItem('当前章', { current: 100, next: 250, total: 1000 });
  const other = virtualItem('别的章', { current: 250, next: 1000, total: 1000 });
  const activeLocationKey = findActiveLocationKey([other, current], 0.15)!;
  const flatItem = { item: current, depth: 0, index: 0 };
  const baseProps = {
    bookKey: 'book1',
    flatItem,
    activeHref: null,
    activeLocationKey,
    onToggleExpand: () => {},
    onItemClick: () => {},
  };

  it('区间内的虚拟条目显示书本图标并带 aria-current="page"', () => {
    render(<StaticListRow {...baseProps} />);
    const treeitem = screen.getByRole('treeitem');
    expect(treeitem.getAttribute('aria-current')).toBe('page');
    expect(treeitem.querySelector('svg')).toBeTruthy();
  });

  it('区间外的虚拟条目既无图标也无 aria-current', () => {
    render(
      <StaticListRow
        {...baseProps}
        flatItem={{ ...flatItem, item: other }}
        activeLocationKey='0:100'
      />,
    );
    const treeitem = screen.getByRole('treeitem');
    expect(treeitem.hasAttribute('aria-current')).toBe(false);
    expect(treeitem.querySelector('svg')).toBeNull();
  });

  it('真实条目仍按 href 相等判定（行为不变）', () => {
    const real: TOCItem = { id: 0, label: '第一章', href: 'chapter1.html', index: 0 };
    render(
      <StaticListRow
        {...baseProps}
        flatItem={{ ...flatItem, item: real }}
        activeHref='chapter1.html'
        activeLocationKey={null}
      />,
    );
    expect(screen.getByRole('treeitem').getAttribute('aria-current')).toBe('page');
  });

  it('真实条目带 location 也不会被区间判定点亮（只有虚拟条目走区间）', () => {
    // 退化 nav 里的真实结构条目同样带 location；若不加 isVirtualTocItem 判断，
    // 它们会和虚拟条目一起被点亮（一屏两个书本图标）。
    const realWithLocation: TOCItem = {
      id: 0,
      label: '正文',
      href: 'page-0.html',
      index: 0,
      location: { current: 100, next: 250, total: 1000 },
    };
    render(
      <StaticListRow
        {...baseProps}
        flatItem={{ ...flatItem, item: realWithLocation }}
        activeHref='page-0.html#other'
        activeLocationKey={activeLocationKey}
      />,
    );
    const treeitem = screen.getByRole('treeitem');
    expect(treeitem.hasAttribute('aria-current')).toBe(false);
    expect(treeitem.querySelector('svg')).toBeNull();
  });
});
