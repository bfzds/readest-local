// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  countChapterMatches,
  generateVirtualTocEntries,
  type ScanProgress,
} from '@/services/virtualToc/scan';
import type { BookDoc, SectionItem } from '@/libs/document';

const html = (title: string) =>
  `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>` +
  `<p>开场白</p><p>${title}</p><p>正文内容。</p></body></html>`;

const makeSection = (id: string, body: string, cfi: string): SectionItem =>
  ({
    id,
    cfi,
    size: body.length,
    linear: 'yes',
    loadText: async () => body,
    createDocument: async () => new DOMParser().parseFromString(body, 'application/xhtml+xml'),
  }) as unknown as SectionItem;

const makeDoc = (): BookDoc =>
  ({
    rendition: {},
    sections: [
      makeSection('s1', html('第一章 开端'), 'epubcfi(/6/4)'),
      makeSection('s2', html('第二章 发展'), 'epubcfi(/6/8)'),
      makeSection('s3', html('只是普通段落'), 'epubcfi(/6/12)'),
    ],
  }) as unknown as BookDoc;

describe('virtualToc scan', () => {
  it('countChapterMatches 统计全部 section 的命中数', async () => {
    expect(await countChapterMatches(makeDoc(), '')).toBe(2);
    expect(await countChapterMatches(makeDoc(), '【[一二三]+】[^\\n]{0,20}')).toBe(2);
    expect(await countChapterMatches(makeDoc(), '开场白')).toBe(5);
  });

  it('generateVirtualTocEntries 产出带 label 与元素级 CFI 的条目', async () => {
    const entries = await generateVirtualTocEntries(makeDoc(), '');
    expect(entries.map((e) => e.label)).toEqual(['第一章 开端', '第二章 发展']);
    expect(entries[0]!.cfi.startsWith('epubcfi(/6/4!')).toBe(true);
    expect(entries[0]!.cfi).not.toBe('epubcfi(/6/4)');
    expect(entries[0]!.source).toBe('pattern');
    expect(entries[0]!.generatedAt).toBeGreaterThan(0);
  });

  it('onProgress 汇报进度且 done 最终等于 total', async () => {
    const seen: ScanProgress[] = [];
    await countChapterMatches(makeDoc(), '', undefined, (p) => seen.push({ ...p }));
    expect(seen.at(-1)!.done).toBe(seen.at(-1)!.total);
  });
});
