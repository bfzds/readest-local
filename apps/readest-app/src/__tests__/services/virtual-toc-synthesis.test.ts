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

  it('label 取标题元素，缺省取首行并截断，cfi 用 section.cfi', async () => {
    const entries = await synthesizeSectionToc(doc3());
    expect(entries).toHaveLength(3);
    expect(entries[0]!.label).toBe('第一章');
    expect(entries[1]!.label.startsWith('第二章')).toBe(true);
    expect(entries[0]!.cfi).toBe('epubcfi(/6/4)');
    expect(entries.every((e) => e.source === 'section')).toBe(true);
  });
});
