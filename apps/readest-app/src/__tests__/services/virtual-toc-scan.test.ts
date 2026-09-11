// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  countChapterMatches,
  generateVirtualTocEntries,
  type ScanProgress,
} from '@/services/virtualToc/scan';
import type { BookDoc, SectionItem } from '@/libs/document';
import { SIZE_PER_LOC } from '@/services/constants';

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

// --- 修复一：数字噪声过滤 / 修复二：内嵌目录密集簇 ---------------------------------

const para = (t: string) => `<p>${t}</p>`;
// 「正文段落。」不命中任何内置规则，只用来撑开候选块的下标间隔。
const filler = (n: number) => para('正文段落。').repeat(n);
const bodyOf = (...parts: string[]) =>
  `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>${parts.join('')}</body></html>`;

const docOfMany = (bodies: string[]): BookDoc =>
  ({
    rendition: {},
    sections: bodies.map((body, i) => ({
      id: `s${i + 1}`,
      cfi: `epubcfi(/6/${4 * (i + 1)})`,
      size: body.length,
      linear: 'yes',
      loadText: async () => body,
      createDocument: async () => new DOMParser().parseFromString(body, 'application/xhtml+xml'),
    })) as unknown as SectionItem[],
  }) as unknown as BookDoc;

const docOf = (body: string): BookDoc => docOfMany([body]);

describe('virtualToc scan：数字噪声过滤（修复一）', () => {
  it('内置规则下过滤日期/纯数字命中，保留真标题', async () => {
    const doc = docOf(bodyOf(para('2024-09-01'), para('2025'), para('123'), para('第一章 开端')));
    const entries = await generateVirtualTocEntries(doc, '');
    expect(entries.map((e) => e.label)).toEqual(['第一章 开端']);
    // 预览数与生成数同源：过滤只发生在 collectMatches 一处
    expect(await countChapterMatches(doc, '')).toBe(1);
  });

  it('中文序数词行（一、开端）不被噪声过滤误杀', async () => {
    const doc = docOf(bodyOf(para('一、开端'), para('二、发展')));
    const entries = await generateVirtualTocEntries(doc, '');
    expect(entries.map((e) => e.label)).toEqual(['一、开端', '二、发展']);
  });

  it('手写正则时不做噪声过滤（日记体按日期分章是用户主权）', async () => {
    const doc = docOf(bodyOf(para('2024-09-01'), para('2025-06-16')));
    const entries = await generateVirtualTocEntries(doc, '^\\d{4}-\\d{2}-\\d{2}$');
    expect(entries.map((e) => e.label)).toEqual(['2024-09-01', '2025-06-16']);
  });
});

describe('virtualToc scan：内嵌目录密集簇（修复二）', () => {
  it('连续间隔 ≤3 且 ≥3 条的密集簇整簇丢弃，稀疏跳跃命中原样保留', async () => {
    const dense = ['序章', '第一章', '第二章', '第三章', '第四章', '第五章', '第六章']
      .map(para)
      .join('');
    const sparse = [
      '序章 剑南来潮',
      '第一章 风起云涌',
      '第二章 潮落',
      '第三章 归途',
      '第四章 雪原',
      '第五章 长夜',
      '第六章 天光',
    ]
      .map((t) => para(t) + filler(4))
      .join('');
    const doc = docOf(bodyOf(dense, filler(4), sparse));
    const entries = await generateVirtualTocEntries(doc, '');
    expect(entries.map((e) => e.label)).toEqual([
      '序章 剑南来潮',
      '第一章 风起云涌',
      '第二章 潮落',
      '第三章 归途',
      '第四章 雪原',
      '第五章 长夜',
      '第六章 天光',
    ]);
    expect(await countChapterMatches(doc, '')).toBe(7);
  });

  it('间隔恰好 3 并簇丢弃；间隔 4 不成簇而保留（GAP 边界）', async () => {
    const gap3 = para('第一章 甲') + filler(2) + para('第二章 乙') + filler(2) + para('第三章 丙');
    expect(await generateVirtualTocEntries(docOf(bodyOf(gap3)), '')).toHaveLength(0);

    const gap4 = para('第一章 甲') + filler(3) + para('第二章 乙') + filler(3) + para('第三章 丙');
    expect(await generateVirtualTocEntries(docOf(bodyOf(gap4)), '')).toHaveLength(3);
  });

  it('仅 2 条紧密命中不构成簇（MIN 边界）', async () => {
    const doc = docOf(bodyOf(para('第一章 甲'), para('第二章 乙'), filler(5), para('第三章 丙')));
    expect(await generateVirtualTocEntries(doc, '')).toHaveLength(3);
  });

  // 日记体最自然的排版就是「日期标题 + 2~3 段正文」：候选项下标差恰好 3，会被
  // 簇判据整簇吃掉。手写正则是主权行为（同修复一），这里必须关门。
  it('手写正则路径不做簇丢弃（日记体按日期分章不被清空）', async () => {
    const dense =
      para('2024-01-01') + filler(2) + para('2024-01-02') + filler(2) + para('2024-01-03');
    const doc = docOf(bodyOf(dense));
    const entries = await generateVirtualTocEntries(doc, '^\\d{4}-\\d{2}-\\d{2}$');
    expect(entries.map((e) => e.label)).toEqual(['2024-01-01', '2024-01-02', '2024-01-03']);
  });
});

// --- 修复四：近似 location ---------------------------------------------------------

// 每段约 12KB 的纯正文段落（不含任何规则命中），用来把章节标题摊开到不同的字节位置。
const bigPara = () => `<p>${'正文'.repeat(2000)}</p>`;

describe('virtualToc scan：近似 location（修复四）', () => {
  it('条目携带近似 location：单调递增、total 按 SIZE_PER_LOC、末条以 total 收尾', async () => {
    // 章节之间隔 4 个纯正文段（间隔 > EMBEDDED_TOC_RUN_GAP），避免被当成内嵌目录簇丢弃
    const b = bigPara();
    const body = bodyOf(
      b,
      b,
      para('第一章 甲'),
      b,
      b,
      b,
      b,
      para('第二章 乙'),
      b,
      b,
      b,
      b,
      para('第三章 丙'),
      b,
      b,
    );
    const doc = docOf(body);
    const entries = await generateVirtualTocEntries(doc, '');
    expect(entries.map((e) => e.label)).toEqual(['第一章 甲', '第二章 乙', '第三章 丙']);

    const locs = entries.map((e) => e.location!);
    const total = Math.floor(body.length / SIZE_PER_LOC);
    expect(locs.every((l) => l.total === total)).toBe(true);
    expect(locs[0]!.current).toBeLessThan(locs[1]!.current);
    expect(locs[1]!.current).toBeLessThan(locs[2]!.current);
    expect(locs[2]!.current).toBeLessThan(total);
    // next = 下一条的 current；末条以全书总 loc 收尾
    expect(locs[0]!.next).toBe(locs[1]!.current);
    expect(locs[1]!.next).toBe(locs[2]!.current);
    expect(locs[2]!.next).toBe(total);
  });

  it('location 计入本 section 之前的累计字节（跨 section 偏移）', async () => {
    const s1 = bodyOf(para('第一章 甲'), bigPara(), bigPara(), bigPara(), bigPara());
    const s2 = bodyOf(para('第二章 乙'));
    const entries = await generateVirtualTocEntries(docOfMany([s1, s2]), '');
    const locs = entries.map((e) => e.location!);
    // 第二条在第二个 section 的开头：至少要有第一个 section 的全部字节在前
    expect(locs[1]!.current).toBeGreaterThanOrEqual(Math.floor(s1.length / SIZE_PER_LOC));
    expect(locs[1]!.current).toBeGreaterThan(locs[0]!.current);
  });

  it('手写正则路径同样产出 location（分区与过滤无关）', async () => {
    const body = bodyOf(para('2024-09-01'), bigPara(), bigPara(), bigPara());
    const entries = await generateVirtualTocEntries(docOf(body), '^\\d{4}-\\d{2}-\\d{2}$');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.location!.total).toBe(Math.floor(body.length / SIZE_PER_LOC));
  });
});
