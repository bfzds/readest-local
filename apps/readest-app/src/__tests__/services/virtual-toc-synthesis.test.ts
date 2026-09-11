// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { shouldOfferSynthesis, synthesizeSectionToc } from '@/services/virtualToc/synthesis';
import type { BookDoc, SectionItem } from '@/libs/document';

const section = (id: string, body: string): SectionItem =>
  ({
    id,
    cfi: `epubcfi(/6/${id})`,
    size: body.length,
    linear: 'yes',
    loadText: async () => body,
    createDocument: async () => new DOMParser().parseFromString(body, 'application/xhtml+xml'),
  }) as unknown as SectionItem;

const doc3 = (): BookDoc =>
  ({
    rendition: {},
    toc: [],
    sections: [
      section('4', '<html><body><h2>第一章</h2><p>a</p></body></html>'),
      section('8', '<html><body><p>第二章 无标题文件的首行</p><p>b</p></body></html>'),
      section('12', '<html><body><p>c</p></body></html>'),
    ],
  }) as unknown as BookDoc;

// 巨型内容 section（样例书 267KB）：size 直接给字节数。
const bigSection = (id: string): SectionItem =>
  ({
    id,
    cfi: `epubcfi(/6/${id})`,
    size: 300 * 1024,
    linear: 'yes',
    loadText: async () => '<html><body><p>x</p></body></html>',
    createDocument: async () =>
      new DOMParser().parseFromString(
        '<html><body><p>x</p></body></html>',
        'application/xhtml+xml',
      ),
  }) as unknown as SectionItem;

const item = (id: number, href: string) => ({
  id,
  label: `条目${id}`,
  href,
  index: 0,
  subitems: [],
});

const withToc = (toc: ReturnType<typeof item>[], sections: SectionItem[]): BookDoc =>
  ({
    rendition: {},
    toc,
    sections,
    splitTOCHref: (href: string) => href.split('#'),
  }) as unknown as BookDoc;

describe('synthesizeSectionToc', () => {
  it('toc 空且多 section 时建议合成', () => {
    expect(shouldOfferSynthesis(doc3())).toBe(true);
  });

  it('toc 健康或单 section 时不建议', () => {
    const healthy = { ...doc3(), toc: [{ id: 1 }, { id: 2 }] } as unknown as BookDoc;
    expect(shouldOfferSynthesis(healthy)).toBe(false);
    const single = { ...doc3(), sections: [section('4', 'x')] } as unknown as BookDoc;
    expect(shouldOfferSynthesis(single)).toBe(false);
  });

  it('toc 多条但退化（slab 只被 1 条指到）时仍建议按文件分章', () => {
    const degraded = withToc(
      [item(1, 'content.html'), item(2, 'content.html'), item(3, 'content.html')],
      [
        bigSection('content.html'),
        section('8', '<html><body><p>b</p></body></html>'),
        section('12', '<html><body><p>c</p></body></html>'),
      ],
    );
    expect(shouldOfferSynthesis(degraded)).toBe(true);
  });

  it('toc 多条且分别指向 slab（健康单文件书）时不建议', () => {
    const healthyAnchored = withToc(
      [item(1, 'content.html#ch1'), item(2, 'content.html#ch2'), item(3, 'content.html#ch3')],
      [bigSection('content.html'), section('8', '<html><body><p>b</p></body></html>')],
    );
    expect(shouldOfferSynthesis(healthyAnchored)).toBe(false);
  });

  it('label 取标题元素，缺省取首行并截断，cfi 用 section.cfi', async () => {
    const entries = await synthesizeSectionToc(doc3());
    expect(entries).toHaveLength(3);
    expect(entries[0]!.label).toBe('第一章');
    expect(entries[1]!.label.startsWith('第二章')).toBe(true);
    expect(entries[0]!.cfi).toBe('epubcfi(/6/4)');
    expect(entries.every((e) => e.source === 'section')).toBe(true);
  });
});

describe('synthesizeSectionToc 回归（R6）', () => {
  it('wrapper div 不被当作首块，改取其后第一个块元素', async () => {
    const wrapped = {
      ...doc3(),
      sections: [
        section(
          '4',
          '<html><body><div class="wrap"><p>第一段</p><p>第二段</p></div></body></html>',
        ),
      ],
    } as unknown as BookDoc;
    const entries = await synthesizeSectionToc(wrapped);
    expect(entries[0]!.label).toBe('第一段');
  });

  it('pre-paginated 布局不提供合成（fixed-layout 门禁）', () => {
    const fixed = { ...doc3(), rendition: { layout: 'pre-paginated' } } as unknown as BookDoc;
    expect(shouldOfferSynthesis(fixed)).toBe(false);
  });
});
