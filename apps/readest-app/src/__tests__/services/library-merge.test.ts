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

  // 导入路径把墓碑书带回书架（bookService 的 hash 命中短路）时必须能落盘：
  // 否则书在界面上回来了、重启后又消失，这次一并补记的来源路径也丢，
  // 于是那本书每次重扫都要重新解析。
  it('显式复活的 incoming 穿过防复活护栏写入', () => {
    const onDisk = makeBook('b1', { deletedAt: 1000, updatedAt: 1000 });
    const revived = makeBook('b1', {
      deletedAt: null,
      updatedAt: 2000,
      revivedAt: 2000,
      altFilePaths: ['/lib/watched/book.epub'],
    });
    const merged = mergeLibraryRows([onDisk], [revived]);
    expect(merged[0]!.deletedAt).toBeNull();
    expect(merged[0]!.altFilePaths).toEqual(['/lib/watched/book.epub']);
  });

  it('复活标记早于删除时刻时仍按陈旧窗口拦下', () => {
    // 复活过、之后又在别的窗口被删：陈旧副本带着旧的 revivedAt 回来时，
    // 不能凭它把书重新变活。
    const onDisk = makeBook('b1', { deletedAt: 3000, updatedAt: 3000 });
    const stale = makeBook('b1', { deletedAt: null, updatedAt: 1000, revivedAt: 1000 });
    const merged = mergeLibraryRows([onDisk], [stale]);
    expect(merged[0]!.deletedAt).toBe(3000);
  });

  // 备份恢复把「备份里存活、本地已删」的书复活时，保存路径送进来的记录形状
  // 与陈旧窗口一模一样（无 tombstone、updatedAt 更新），必须靠 revivedAt
  // 穿过护栏——否则恢复在界面上生效、下次保存又被磁盘墓碑顶回去。
  it('备份恢复的复活记录（deletedAt 已清 + revivedAt 不早于墓碑）穿过护栏并保留字段', () => {
    const onDisk = makeBook('b1', { deletedAt: 1000, updatedAt: 1000 });
    const restored = makeBook('b1', {
      deletedAt: null,
      updatedAt: 2_000_000_000_000, // reviveRestoredBooks 抬高过的 updatedAt
      revivedAt: 2_000_000_000_000,
      downloadedAt: 555,
    });
    const merged = mergeLibraryRows([onDisk], [restored]);
    expect(merged[0]!.deletedAt).toBeNull();
    expect(merged[0]!.downloadedAt).toBe(555);
  });

  it('同样形状但缺 revivedAt 的记录仍被护栏拦下（护栏未被削弱）', () => {
    const onDisk = makeBook('b1', { deletedAt: 1000, updatedAt: 1000 });
    const noStamp = makeBook('b1', {
      deletedAt: null,
      updatedAt: 2_000_000_000_000,
      downloadedAt: 555,
    });
    const merged = mergeLibraryRows([onDisk], [noStamp]);
    expect(merged[0]!.deletedAt).toBe(1000);
  });
});
