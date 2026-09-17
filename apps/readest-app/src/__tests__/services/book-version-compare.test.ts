import { describe, expect, it } from 'vitest';
import {
  buildVersionComparison,
  buildNewVersionFacts,
  countSideChapters,
  shortMetaHash,
  type VersionSideFacts,
} from '@/services/bookVersionCompare';
import type { Book } from '@/types/book';

const side = (overrides: Partial<VersionSideFacts> = {}): VersionSideFacts => ({
  label: 'old',
  title: 'Test Book',
  author: 'Test Author',
  identifier: 'abcdef12',
  format: 'EPUB',
  tocSource: 'unknown',
  toc: null,
  ...overrides,
});

const toc = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ label: `第 ${index + 1} 章`, depth: 0 }));

const rowOf = (result: ReturnType<typeof buildVersionComparison>, key: string) =>
  result.rows.find((row) => row.key === key)!;

describe('buildVersionComparison', () => {
  it('fills unknown fields with 未记录 instead of hiding the row', () => {
    const result = buildVersionComparison(side(), side({ label: 'new' }));

    expect(rowOf(result, 'size').old).toBe('未记录');
    expect(rowOf(result, 'mtime').new).toBe('未记录');
    expect(rowOf(result, 'textLength').old).toBe('未记录');
    expect(rowOf(result, 'chapters').old).toBe('未记录');
  });

  it('formats sizes and timestamps for display', () => {
    const result = buildVersionComparison(
      side({ sizeBytes: 900, mtime: new Date(2026, 8, 17, 9, 5).getTime() }),
      side({ label: 'new', sizeBytes: 3 * 1024 * 1024 }),
    );

    expect(rowOf(result, 'size').old).toBe('900 B');
    expect(rowOf(result, 'size').new).toBe('3.0 MB');
    expect(rowOf(result, 'mtime').old).toBe('2026-09-17 09:05');
  });

  // 正文字数是"哪边更新"最可靠的弱信号：新旧两版重排后字数会变。
  it('summarises a text-length change with its direction and magnitude', () => {
    const result = buildVersionComparison(
      side({ textLength: 1000 }),
      side({ label: 'new', textLength: 1120 }),
    );

    expect(rowOf(result, 'textLength').direction).toBe('up');
    expect(result.summary.some((line) => line.includes('正文字数增多 +120'))).toBe(true);
  });

  it('summarises a shrinking text as a decrease', () => {
    const result = buildVersionComparison(
      side({ textLength: 1000 }),
      side({ label: 'new', textLength: 900 }),
    );

    expect(rowOf(result, 'textLength').direction).toBe('down');
    expect(result.summary.some((line) => line.includes('减少 −100'))).toBe(true);
  });

  it('says so when only one side has a text length', () => {
    const result = buildVersionComparison(
      side({ textLength: undefined }),
      side({ label: 'new', textLength: 900 }),
    );

    expect(rowOf(result, 'textLength').direction).toBeUndefined();
    expect(result.summary.some((line) => line.includes('只有一侧有记录'))).toBe(true);
  });

  // PDF 与 MOBI 不走原生解析器，再导多少次都不会有字数。"再导一次同一本即可
  // 补上"对它们是错误归因——用户会一直等一个不会发生的事。
  it('explains the format when it never records a text length', () => {
    const result = buildVersionComparison(
      side({ format: 'PDF', textLength: undefined }),
      side({ label: 'new', format: 'PDF', textLength: undefined }),
    );

    const note = result.summary.find((line) => line.includes('正文字数'))!;
    expect(note).toContain('PDF 不统计正文字数');
    expect(note).not.toContain('再导入一次');
  });

  // 反过来：EPUB 老记录缺字数是"这个字段晚出现"，再导一次确实能补上。
  it('keeps the "import it once more" hint for EPUB', () => {
    const result = buildVersionComparison(
      side({ format: 'EPUB', textLength: undefined }),
      side({ label: 'new', format: 'EPUB', textLength: 900 }),
    );

    expect(result.summary.some((line) => line.includes('再导入一次同一本即可补上'))).toBe(true);
  });

  it('counts chapters from the TOC when there is one, else from the recorded count', () => {
    expect(countSideChapters(side({ toc: toc(12) }))).toBe(12);
    expect(countSideChapters(side({ toc: null, sectionCount: 7 }))).toBe(7);
    expect(countSideChapters(side({ toc: null }))).toBeUndefined();
  });

  it('compares chapters without deciding which side is newer', () => {
    const result = buildVersionComparison(
      side({ toc: toc(10), tocSource: 'nav-cache' }),
      side({ label: 'new', toc: toc(12), tocSource: 'native', sectionCount: 12 }),
    );

    expect(result.sectionComparable).toBe(true);
    expect(rowOf(result, 'chapters').old).toBe('10');
    expect(rowOf(result, 'chapters').new).toBe('12');
    expect(rowOf(result, 'chapters').direction).toBe('up');
    expect(result.oldToc).toHaveLength(10);
    expect(result.newToc).toHaveLength(12);
  });

  // 一侧没有目录缓存时"章节数 34 / 未记录"已经由表格说清；再并排一份空列表
  // 会让人读成"新版少了 34 章"。
  it('collapses the chapter area and explains why when the old side has no TOC', () => {
    const result = buildVersionComparison(
      side({ toc: null, tocSource: 'unknown' }),
      side({ label: 'new', toc: toc(34), tocSource: 'native' }),
    );

    expect(result.sectionComparable).toBe(false);
    expect(result.sectionNote).toContain('还没有目录缓存');
    expect(result.sectionNote).toContain('只对比正文规模');
    expect(result.oldToc).toBeUndefined();
    expect(result.newToc).toBeUndefined();
  });

  it('names the incoming file as the incomplete side', () => {
    const result = buildVersionComparison(
      side({ toc: toc(20), tocSource: 'nav-cache' }),
      side({ label: 'new', toc: [], tocSource: 'unknown' }),
    );

    expect(result.sectionComparable).toBe(false);
    expect(result.sectionNote).toContain('导入的这本自带目录不完整');
  });

  it('collapses the chapter area when both sides are degraded', () => {
    const result = buildVersionComparison(side({ toc: [] }), side({ label: 'new', toc: [] }));

    expect(result.sectionComparable).toBe(false);
    expect(rowOf(result, 'chapters').old).toBe('未记录');
  });

  // 用户自己生成的目录是可用的对比对象，但来源要如实标注（它未必等于自带目录）。
  it('accepts a user-generated virtual TOC as a chapter source', () => {
    const result = buildVersionComparison(
      side({ toc: toc(6), tocSource: 'virtual' }),
      side({ label: 'new', toc: toc(6), tocSource: 'native', sectionCount: 6 }),
    );

    expect(result.sectionComparable).toBe(true);
    expect(rowOf(result, 'chapters').direction).toBe('same');
    expect(result.summary.some((line) => line.includes('章节数相同'))).toBe(true);
  });
});

describe('buildNewVersionFacts', () => {
  const incoming: Book = {
    hash: 'new-hash-456',
    format: 'EPUB',
    metaHash: 'fedcba9876543210',
    title: 'Test Book',
    author: 'Test Author',
    createdAt: 1,
    updatedAt: 1,
  };

  it('prefers the import-time facts over the record', () => {
    const facts = buildNewVersionFacts(incoming, {
      sizeBytes: 4242,
      mtime: 1_700_000_000_000,
      textLength: 999,
      sectionCount: 12,
      toc: toc(12),
    });

    expect(facts.sizeBytes).toBe(4242);
    expect(facts.textLength).toBe(999);
    expect(facts.sectionCount).toBe(12);
    expect(facts.tocSource).toBe('native');
    expect(facts.identifier).toBe('fedcba98');
  });

  it('falls back to the record textLength and reports no TOC when unparsed', () => {
    const facts = buildNewVersionFacts({ ...incoming, textLength: 500 }, undefined);

    expect(facts.textLength).toBe(500);
    expect(facts.toc).toBeNull();
    expect(facts.tocSource).toBe('unknown');
  });
});

describe('shortMetaHash', () => {
  it('truncates and handles the missing case', () => {
    expect(shortMetaHash('0123456789abcdef')).toBe('01234567');
    expect(shortMetaHash(undefined)).toBeUndefined();
  });
});
