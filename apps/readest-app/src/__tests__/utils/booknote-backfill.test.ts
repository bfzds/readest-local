import { describe, expect, test } from 'vitest';
import { applyBackfilledPages } from '@/utils/booknoteBackfill';
import type { BookNote } from '@/types/book';

function note(overrides: Partial<BookNote>): BookNote {
  return {
    id: 'n1',
    type: 'annotation',
    cfi: 'epubcfi(/2/4)',
    note: '正文',
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe('applyBackfilledPages (B-1)', () => {
  test('给仍缺 page 的标注补 page', () => {
    const current = [note({ id: 'a' }), note({ id: 'b', page: 7 })];
    const merged = applyBackfilledPages(current, new Map([['a', 12]]));
    expect(merged[0]).toMatchObject({ id: 'a', page: 12 });
    // 已有 page 的标注不被覆盖
    expect(merged[1]).toMatchObject({ id: 'b', page: 7 });
  });

  test('回填期间新增的标注原样保留（不吞新书签）', () => {
    const current = [note({ id: 'exists' }), note({ id: 'newly-added', note: '用户新写' })];
    const merged = applyBackfilledPages(current, new Map([['exists', 5]]));
    expect(merged).toHaveLength(2);
    expect(merged[1]).toEqual(current[1]);
    expect(merged[1]!.note).toBe('用户新写');
  });

  test('回填期间被编辑的标注保留新内容', () => {
    const current = [note({ id: 'edited', note: '用户改过的文字' })];
    const merged = applyBackfilledPages(current, new Map([['edited', 9]]));
    // 补上了 page，但 note 文本是用户的最新版本
    expect(merged[0]).toMatchObject({ id: 'edited', page: 9, note: '用户改过的文字' });
  });

  test('回填期间被删除的标注不得复活', () => {
    const current = [note({ id: 'gone', deletedAt: 9999 })];
    const merged = applyBackfilledPages(current, new Map([['gone', 3]]));
    expect(merged[0]).toMatchObject({ id: 'gone', deletedAt: 9999 });
    expect(merged[0]!.page).toBeUndefined();
  });

  test('filled 中不存在的 id 不受影响', () => {
    const current = [note({ id: 'a' })];
    const merged = applyBackfilledPages(current, new Map([['zzz', 1]]));
    expect(merged[0]).toEqual(current[0]);
    expect(merged[0]!.page).toBeUndefined();
  });

  test('无可补 page 时返回原引用（不触发 zustand 变更）', () => {
    const current = [note({ id: 'a' })];
    const merged = applyBackfilledPages(current, new Map());
    expect(merged).toBe(current);
  });
});
