// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyVirtualToc, virtualTocToItems } from '@/services/virtualToc/apply';
import type { VirtualTocEntry } from '@/types/book';
import type { BookDoc } from '@/libs/document';

const entries: VirtualTocEntry[] = [
  { label: '第1章', cfi: 'epubcfi(/6/4!/4/2)', source: 'pattern', generatedAt: 1 },
  { label: '第2章', cfi: 'epubcfi(/6/4!/4/8)', source: 'pattern', generatedAt: 1 },
];

const makeDoc = (toc: BookDoc['toc']): BookDoc =>
  ({ toc, sections: [], rendition: {} }) as unknown as BookDoc;

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

  it('virtualTocToItems 生成负数 id 与空 subitems', () => {
    const items = virtualTocToItems(entries);
    expect(items[0]!.id).toBeLessThan(0);
    expect(items[0]!.subitems).toEqual([]);
  });
});
