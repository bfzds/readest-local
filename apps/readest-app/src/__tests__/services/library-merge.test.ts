import { describe, expect, it } from 'vitest';
import { mergeLibraryRows } from '@/services/libraryService';
import type { Book } from '@/types/book';

const makeBook = (hash: string, partial: Partial<Book> = {}): Book => ({
  hash,
  format: 'MD',
  title: partial.title ?? 'Title',
  author: '',
  createdAt: 1,
  updatedAt: 1,
  ...partial,
});

describe('mergeLibraryRows (B-7 LWW + merge-floor)', () => {
  it('磁盘较新的记录不被旧窗口覆盖（标题/元数据不被旧对象碾压）', () => {
    const onDisk = makeBook('b1', { title: '最新标题', updatedAt: 200 });
    const fromStaleWindow = makeBook('b1', { title: '旧标题', updatedAt: 100 });
    const merged = mergeLibraryRows([onDisk], [fromStaleWindow]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.title).toBe('最新标题');
  });

  it('incoming 较新时覆盖（正常单窗口保存语义保留）', () => {
    const onDisk = makeBook('b1', { title: '旧', updatedAt: 100 });
    const newer = makeBook('b1', { title: '新', updatedAt: 200 });
    const merged = mergeLibraryRows([onDisk], [newer]);
    expect(merged[0]!.title).toBe('新');
  });

  it('磁盘已软删的书不被无 tombstone 陈旧窗口复活', () => {
    const onDisk = makeBook('b1', { deletedAt: 999 });
    const stale = makeBook('b1', { updatedAt: 50 });
    const merged = mergeLibraryRows([onDisk], [stale]);
    expect(merged[0]!.deletedAt).toBe(999);
  });

  it('显式携带 deletedAt 的 incoming 允许本轮删除覆盖', () => {
    const onDisk = makeBook('b1', { updatedAt: 100 });
    const deleting = makeBook('b1', { deletedAt: 200, updatedAt: 200 });
    const merged = mergeLibraryRows([onDisk], [deleting]);
    expect(merged[0]!.deletedAt).toBe(200);
  });

  it('增加新书不改动 merge-floor（旧快照不丢书）', () => {
    const onDisk = [makeBook('existing', { updatedAt: 100 })];
    const current = [
      makeBook('existing', { updatedAt: 100 }),
      makeBook('brand-new', { updatedAt: 300 }),
    ];
    const merged = mergeLibraryRows(onDisk, current);
    expect(merged.map((b) => b.hash).sort()).toEqual(['brand-new', 'existing']);
  });
});
