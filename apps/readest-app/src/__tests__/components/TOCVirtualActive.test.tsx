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

  it('真实条目带 location 覆盖整块 slab 时，不抢走虚拟条目的 key（区间匹配只对虚拟条目生效）', () => {
    // 合并时真实条目被前置，nav 管线又给它们写了 section.location（样本书 3 条无锚点
    // 条目 href 就是 section href，条件 id === item.href 成立）→ 真实条目的区间覆盖
    // 整块 slab。若在全表上做 find，0.05 × 1000 = 50 会先命中真实条目、返回 "0:1000"，
    // 虚拟条目永远拿不到自己的 key（C 要修的症状原样保留）。
    const realWithSlabLocation: TOCItem = {
      id: 0,
      label: '正文',
      href: 'page-0.html',
      index: 0,
      location: { current: 0, next: 1000, total: 1000 },
    };
    expect(
      findActiveLocationKey(
        [realWithSlabLocation, virtualItem('1', { current: 0, next: 100, total: 1000 })],
        0.05,
      ),
    ).toBe('0:100');
  });

  it('currentLoc 落在真实条目区间、不在任何虚拟条目区间 → 返回 null（顺序无关）', () => {
    // R35 负向钉子，钉住两半：区间匹配只认虚拟条目（isVirtualTocItem 过滤），
    // total 也从虚拟条目探测。真实条目 location [0,1000) 覆盖 0.05×1000=50，
    // 虚拟条目 [100,250) 不含 50——若实现把真实条目纳入区间匹配，这里会命中
    // 真实条目返回 '0:1000' 而非 null。两种排列都断言，防「按顺序先命中」。
    const realWithLocation: TOCItem = {
      id: 0,
      label: '正文',
      href: 'page-0.html',
      index: 0,
      location: { current: 0, next: 1000, total: 1000 },
    };
    const virtual = virtualItem('1', { current: 100, next: 250, total: 1000 });
    expect(findActiveLocationKey([realWithLocation, virtual], 0.05)).toBeNull();
    expect(findActiveLocationKey([virtual, realWithLocation], 0.05)).toBeNull();
  });

  it('total 探测只认虚拟条目的 total（真实条目 total 不同且前置时不被带偏）', () => {
    // 真实条目的 total（500）与虚拟条目（1000）不同且被前置：若实现退化成全表
    // 探测（items.filter(isVirtualTocItem) 丢掉过滤），total 会取到 500 →
    // currentLoc = round(0.45 × 500) = 225 → 落进真实条目 [0,500) 的区间，
    // 返回 '0:500' 而非虚拟条目的 key，本用例必红。
    const real: TOCItem = {
      id: 0,
      label: '真实',
      href: 'OEBPS/a.html',
      index: 0,
      location: { current: 0, next: 500, total: 500 },
    };
    const v1 = virtualItem('甲', { current: 0, next: 300, total: 1000 });
    const v2 = virtualItem('乙', { current: 300, next: 600, total: 1000 });
    // 0.45 × 1000 = 450 ∈ [300, 600) → 乙
    expect(findActiveLocationKey([real, v1, v2], 0.45)).toBe(keyOf(v2));
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

describe('全书级条目（书名条目）不参与当前章节高亮', () => {
  // 单 section 书书自带的「书名条目」：真实条目、href 是裸 section 路径（无
  // fragment）、location 跨度覆盖全书（实测 {current:1, next:179, total:179}，
  // 99.4%）。foliate 的 tocProgress 在单 section 书里恒命中它 → activeHref 恒等于
  // 它的 href；按跨度占比判为全书级后不再参与高亮（列表里仍显示，只是永不点亮）。
  const titleItem: TOCItem = {
    id: 0,
    label: '书名',
    href: 'OEBPS/page-0.html',
    index: 0,
    location: { current: 1, next: 179, total: 179 },
  };
  const virtualChapter = virtualItem('当前章', { current: 0, next: 100, total: 179 });
  const baseProps = {
    bookKey: 'book1',
    flatItem: { item: titleItem, depth: 0, index: 0 },
    activeHref: 'OEBPS/page-0.html',
    activeLocationKey: null,
    onToggleExpand: () => {},
    onItemClick: () => {},
  };

  it('activeHref 命中书名条目也不亮（无 aria-current、无书本图标）', () => {
    render(<StaticListRow {...baseProps} />);
    const treeitem = screen.getByRole('treeitem');
    expect(treeitem.hasAttribute('aria-current')).toBe(false);
    expect(treeitem.querySelector('svg')).toBeNull();
  });

  it('同场景下并列的虚拟章节条目仍按区间点亮（书名条目不抢、不干扰区间判定）', () => {
    render(
      <div>
        <StaticListRow {...baseProps} activeLocationKey={keyOf(virtualChapter)} />
        <StaticListRow
          {...baseProps}
          flatItem={{ ...baseProps.flatItem, item: virtualChapter }}
          activeLocationKey={keyOf(virtualChapter)}
        />
      </div>,
    );
    const rows = screen.getAllByRole('treeitem');
    const titleRow = rows[0]!;
    const chapterRow = rows[1]!;
    expect(titleRow.hasAttribute('aria-current')).toBe(false);
    expect(titleRow.querySelector('svg')).toBeNull();
    expect(chapterRow.getAttribute('aria-current')).toBe('page');
    expect(chapterRow.querySelector('svg')).toBeTruthy();
  });

  it('反例：小跨度真实条目 + activeHref 相等仍亮（不误杀正常章节）', () => {
    const chapter: TOCItem = {
      id: 1,
      label: '第一章',
      href: 'OEBPS/chap-1.html',
      index: 0,
      location: { current: 0, next: 10, total: 179 },
    };
    render(
      <StaticListRow
        {...baseProps}
        flatItem={{ item: chapter, depth: 0, index: 0 }}
        activeHref='OEBPS/chap-1.html'
        activeLocationKey={null}
      />,
    );
    const treeitem = screen.getByRole('treeitem');
    expect(treeitem.getAttribute('aria-current')).toBe('page');
    expect(treeitem.querySelector('svg')).toBeTruthy();
  });
});
