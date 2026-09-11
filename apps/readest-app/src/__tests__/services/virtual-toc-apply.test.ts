// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  applyVirtualToc,
  isVirtualTocItem,
  isWholeBookTocItem,
  stripVirtualTocItems,
  virtualTocToItems,
} from '@/services/virtualToc/apply';
import type { VirtualTocEntry } from '@/types/book';
import type { BookDoc, SectionItem, TOCItem } from '@/libs/document';

const entries: VirtualTocEntry[] = [
  { label: '第1章', cfi: 'epubcfi(/6/4!/4/2)', source: 'pattern', generatedAt: 1 },
  { label: '第2章', cfi: 'epubcfi(/6/4!/4/8)', source: 'pattern', generatedAt: 1 },
];

// sections 可选覆盖（默认空数组 = 无 slab = 不退化，既有用例语义不变）。
const makeDoc = (toc: BookDoc['toc'], sections: BookDoc['sections'] = []): BookDoc =>
  ({
    toc,
    sections,
    rendition: {},
    splitTOCHref: (href: string) => href.split('#'),
  }) as unknown as BookDoc;

const section = (id: string, size: number): SectionItem =>
  ({ id, cfi: `epubcfi(/6/${id})`, size, linear: 'yes' }) as unknown as SectionItem;

// 扁平章节书：每章远小于 128KB 阈值。
const smallSection = (id: string) => section(id, 32 * 1024);
// 巨型内容 section（样例书 page-0.html 实测 267KB）。
const slabSection = (id: string) => section(id, 300 * 1024);

const tocItem = (id: number, href: string, subitems?: TOCItem[]): TOCItem => ({
  id,
  label: `条目${id}`,
  href,
  index: 0,
  subitems: subitems ?? [],
});

describe('applyVirtualToc', () => {
  it('空目录时并入并产生新数组引用', () => {
    const doc = makeDoc([]);
    expect(applyVirtualToc(doc, entries)).toBe(true);
    expect(doc.toc).toHaveLength(2);
    expect(doc.toc![0]!.label).toBe('第1章');
    expect(doc.toc![0]!.href).toBe('epubcfi(/6/4!/4/2)');
  });

  it('退化目录（1 条）时追加而非替换', () => {
    const existing = { id: 1, label: '正文', href: 'a.html', index: 0, subitems: [] };
    const doc = makeDoc([existing]);
    expect(applyVirtualToc(doc, entries)).toBe(true);
    expect(doc.toc).toHaveLength(3);
    expect(doc.toc![0]).toBe(existing);
  });

  it('健康目录（>1 条真实条目）、空条目、fixed-layout 均不应用', () => {
    const healthy = makeDoc([
      { id: 1, label: 'a', href: 'a', index: 0, subitems: [] },
      { id: 2, label: 'b', href: 'b', index: 0, subitems: [] },
    ]);
    expect(applyVirtualToc(healthy, entries)).toBe(false);
    expect(applyVirtualToc(makeDoc([]), [])).toBe(false);
    expect(applyVirtualToc(makeDoc([]), undefined)).toBe(false);
    const fixed = makeDoc([]);
    (fixed as { rendition?: { layout?: string } }).rendition = { layout: 'pre-paginated' };
    expect(applyVirtualToc(fixed, entries)).toBe(false);
  });

  it('重新生成：既有虚拟条目（负 id）被剥离替换而非叠加（R2）', () => {
    const virtualized = makeDoc([
      { id: 1, label: '正文', href: 'a.html', index: 0, subitems: [] },
      { id: -1, label: '旧第1章', href: 'epubcfi(/6/4!/4/2)', index: 0, subitems: [] },
      { id: -2, label: '旧第2章', href: 'epubcfi(/6/4!/4/8)', index: 0, subitems: [] },
    ]);
    expect(applyVirtualToc(virtualized, entries)).toBe(true);
    expect(virtualized.toc).toHaveLength(3); // 1 真实 + 2 新虚拟
    expect(virtualized.toc!.filter((t) => t.id < 0).map((t) => t.label)).toEqual([
      '第1章',
      '第2章',
    ]);
  });

  // 核心守门用例（nav.json 污染自愈）：历史 nav.json 把虚拟条目重新编号成 0..N 的非负
  // id，旧判据 `item.id >= 0` 就把这 14 条当成真实条目 → 永不剥离 → 每次打开残留 + 叠加
  // （用户真机看到 21 条）。判据必须回到 href 是不是 CFI 串。
  it('重编号为非负 id（href 仍是 CFI）的虚拟条目照样被剥离、不叠加（nav.json 污染自愈）', () => {
    const staleNavToc: TOCItem[] = [
      { id: 0, label: '正文', href: 'page-0.html', index: 0 },
      ...Array.from({ length: 14 }, (_, i) => ({
        id: i + 1,
        label: `旧第${i + 1}章`,
        href: `epubcfi(/6/4!/4/${2 + i * 2})`,
        index: 0,
      })),
    ];
    const doc = makeDoc(staleNavToc, [slabSection('page-0.html')]);
    expect(applyVirtualToc(doc, entries)).toBe(true);
    // 1 条真实 + 2 条新虚拟；旧实现会留下 1 + 14 + 2 = 17 条。
    expect(doc.toc).toHaveLength(3);
    expect(doc.toc!.filter((item) => item.href.startsWith('epubcfi('))).toHaveLength(2);
    expect(doc.toc!.map((item) => item.label)).toEqual(['正文', '第1章', '第2章']);
  });

  it('3 条结构条目 + slab（大 section 只被 1 条指到）时应用虚拟目录', () => {
    const doc = makeDoc(
      [tocItem(1, 'page-0.html'), tocItem(2, 'page-0.html'), tocItem(3, 'page-0.html')],
      [slabSection('page-0.html')],
    );
    expect(applyVirtualToc(doc, entries)).toBe(true);
    expect(doc.toc!.filter((t) => t.id < 0)).toHaveLength(2);
  });

  it('健康分章书（多章节 section、无 slab、多条目录）不应用', () => {
    const doc = makeDoc(
      [tocItem(1, 'chap-1.html'), tocItem(2, 'chap-2.html'), tocItem(3, 'chap-3.html')],
      [smallSection('chap-1.html'), smallSection('chap-2.html'), smallSection('chap-3.html')],
    );
    expect(applyVirtualToc(doc, entries)).toBe(false);
  });

  it('有 slab 但被多条不同锚点指到（单文件 + 锚点目录）不应用', () => {
    const doc = makeDoc(
      [
        tocItem(1, 'content.html#ch1'),
        tocItem(2, 'content.html#ch2'),
        tocItem(3, 'content.html#ch3'),
      ],
      [slabSection('content.html')],
    );
    expect(applyVirtualToc(doc, entries)).toBe(false);
  });

  it('subitems 里的锚点也计入指向 slab 的锚点数（扁平化后再去重）', () => {
    const doc = makeDoc(
      [tocItem(1, 'nav.html'), tocItem(2, 'content.html#ch1', [tocItem(3, 'content.html#ch2')])],
      [slabSection('content.html')],
    );
    expect(applyVirtualToc(doc, entries)).toBe(false);
  });

  // 空 subitems 数组是 truthy，会被侧栏当成可展开父节点画出假三角；
  // 整键省略（undefined）才是叶子。
  it('virtualTocToItems 生成负数 id 且整个省略 subitems 键', () => {
    const items = virtualTocToItems(entries);
    expect(items[0]!.id).toBeLessThan(0);
    expect(items[0]!.subitems).toBeUndefined();
    expect('subitems' in items[0]!).toBe(false);
  });

  it('virtualTocToItems 透传 location，并用 CFI 推出真 spine 序 index', () => {
    const located: VirtualTocEntry[] = [
      {
        label: '第1章',
        cfi: 'epubcfi(/6/4!/4/8)',
        source: 'pattern',
        generatedAt: 1,
        location: { current: 3, next: 12, total: 178 },
      },
      { label: '第2章', cfi: 'epubcfi(/6/8!/4/8)', source: 'pattern', generatedAt: 1 },
    ];
    const items = virtualTocToItems(located);
    expect(items[0]!.location).toEqual({ current: 3, next: 12, total: 178 });
    // 旧 config 里的条目无 location：行为同现状（不塞假值）
    expect(items[1]!.location).toBeUndefined();
    // index 不再是恒 0 的占位，而是 CFI 对应的真 spine 序
    expect(items[0]!.index).toBeGreaterThan(0);
    expect(items[1]!.index).toBeGreaterThan(items[0]!.index!);
  });
});

describe('isVirtualTocItem', () => {
  it('href 是 CFI 串 → 虚拟（无论 id 正负）', () => {
    expect(isVirtualTocItem(tocItem(0, 'epubcfi(/6/4!/4/2)'))).toBe(true);
    expect(isVirtualTocItem(tocItem(3, 'epubcfi(/6/4!/4/8)'))).toBe(true);
  });

  it('普通 href + 非负 id → 真实；负 id → 虚拟（向后兼容）', () => {
    expect(isVirtualTocItem(tocItem(0, 'chapter1.html'))).toBe(false);
    expect(isVirtualTocItem(tocItem(7, 'OEBPS/page-0.html#ch1'))).toBe(false);
    expect(isVirtualTocItem(tocItem(-1, 'chapter1.html'))).toBe(true);
  });
});

describe('isWholeBookTocItem', () => {
  // 单 section 书书自带的「书名条目」（真实条目）：href 是裸 section 路径（无
  // fragment）、location 跨度覆盖全书（样例书实测 {1,179,179}，99.4%）。它没有
  // 章节粒度，isActiveTocItem 用本谓词把它排除出「当前章节」高亮。
  it('无 fragment 且跨度占全书 ≥ 0.9 → true（实测书名条目 {1,179,179}）', () => {
    expect(
      isWholeBookTocItem({
        ...tocItem(0, 'OEBPS/page-0.html'),
        location: { current: 1, next: 179, total: 179 },
      }),
    ).toBe(true);
  });

  it('无 fragment 但跨度小 → false（正常分章章节，不能误杀）', () => {
    expect(
      isWholeBookTocItem({
        ...tocItem(1, 'OEBPS/chap-1.html'),
        location: { current: 0, next: 10, total: 179 },
      }),
    ).toBe(false);
  });

  it('href 带 #fragment → 即使跨度占满全书也是 false（有锚点即有章节粒度）', () => {
    expect(
      isWholeBookTocItem({
        ...tocItem(2, 'OEBPS/page-0.html#ch1'),
        location: { current: 0, next: 179, total: 179 },
      }),
    ).toBe(false);
  });

  it('虚拟条目（CFI href）→ false（它有自己的 location 区间判定）', () => {
    expect(
      isWholeBookTocItem({
        ...tocItem(-1, 'epubcfi(/6/4!/4/2)'),
        location: { current: 1, next: 179, total: 179 },
      }),
    ).toBe(false);
  });

  it('缺 location、total 非正、next ≤ current → false（判不出跨度就不排除）', () => {
    expect(isWholeBookTocItem(tocItem(0, 'OEBPS/page-0.html'))).toBe(false);
    expect(
      isWholeBookTocItem({
        ...tocItem(0, 'OEBPS/page-0.html'),
        location: { current: 0, next: 179, total: 0 },
      }),
    ).toBe(false);
    expect(
      isWholeBookTocItem({
        ...tocItem(0, 'OEBPS/page-0.html'),
        location: { current: 179, next: 179, total: 179 },
      }),
    ).toBe(false);
    expect(
      isWholeBookTocItem({
        ...tocItem(0, 'OEBPS/page-0.html'),
        location: { current: 5, next: 3, total: 179 },
      }),
    ).toBe(false);
  });
});

describe('stripVirtualTocItems', () => {
  it('原地剥离 CFI 虚拟条目与负 id 条目，返回剥离条数，真实条目引用不变', () => {
    const real = tocItem(0, 'page-0.html');
    const renumbered = tocItem(1, 'epubcfi(/6/4!/4/2)');
    const negative = tocItem(-1, 'epubcfi(/6/4!/4/8)');
    const doc = makeDoc([real, renumbered, negative]);

    expect(stripVirtualTocItems(doc)).toBe(2);
    expect(doc.toc).toHaveLength(1);
    expect(doc.toc![0]).toBe(real);
  });

  it('没有虚拟条目时不动数组、返回 0；toc 缺失时返回 0', () => {
    const items = [tocItem(0, 'a.html'), tocItem(1, 'b.html')];
    const doc = makeDoc(items);
    expect(stripVirtualTocItems(doc)).toBe(0);
    expect(doc.toc).toBe(items);
    expect(stripVirtualTocItems(makeDoc(undefined))).toBe(0);
  });
});
