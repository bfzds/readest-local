// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyVirtualToc, virtualTocToItems } from '@/services/virtualToc/apply';
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
});
