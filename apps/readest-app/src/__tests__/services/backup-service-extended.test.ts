import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mergeBookConfigs,
  mergeBookMetadata,
  persistRestoredLibrary,
  reviveRestoredBooks,
  validateBackupStructure,
  type RevivedBook,
} from '@/services/backupService';
import { mergeLibraryRows } from '@/services/libraryService';
import { Book, BookConfig, BookNote } from '@/types/book';

/**
 * Extended tests for backupService covering:
 * - validateBackupStructure
 * - mergeBookConfigs edge cases (empty configs, no booknotes, notes with zero/undefined updatedAt)
 * - mergeBookMetadata edge cases (equal timestamps, undefined deletedAt)
 */

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    hash: 'abc123',
    format: 'EPUB',
    title: 'Test Book',
    author: 'Author',
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function makeNote(overrides: Partial<BookNote> = {}): BookNote {
  return {
    id: 'note-1',
    type: 'annotation',
    cfi: 'cfi-1',
    note: 'test note',
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

describe('validateBackupStructure', () => {
  it('should return true when library.json is present', () => {
    expect(validateBackupStructure(['library.json', 'abc123/book.epub'])).toBe(true);
  });

  it('should return false when library.json is missing', () => {
    expect(validateBackupStructure(['abc123/book.epub', 'abc123/config.json'])).toBe(false);
  });

  it('should return false for empty entries', () => {
    expect(validateBackupStructure([])).toBe(false);
  });

  it('should not match partial names like library.json.bak', () => {
    expect(validateBackupStructure(['library.json.bak'])).toBe(false);
  });

  it('should not match subdirectory library.json', () => {
    // Only exact match counts; 'subdir/library.json' !== 'library.json'
    expect(validateBackupStructure(['subdir/library.json'])).toBe(false);
  });

  it('should return true even with many other entries', () => {
    const entries = Array.from({ length: 100 }, (_, i) => `hash${i}/book.epub`);
    entries.push('library.json');
    expect(validateBackupStructure(entries)).toBe(true);
  });
});

describe('mergeBookConfigs - extended', () => {
  it('should handle both configs having zero progress', () => {
    const current: BookConfig = { progress: [0, 200], updatedAt: 100 };
    const backup: BookConfig = { progress: [0, 200], updatedAt: 90 };
    const result = mergeBookConfigs(current, backup);
    // When progress is equal (both 0), current wins (backupPage > currentPage is false)
    expect(result.progress).toEqual([0, 200]);
  });

  it('should handle configs with no progress at all', () => {
    const current: Partial<BookConfig> = { updatedAt: 100 };
    const backup: Partial<BookConfig> = { updatedAt: 90 };
    const result = mergeBookConfigs(current, backup);
    // Both progress[0] default to 0, so current wins
    expect(result.booknotes).toEqual([]);
  });

  it('should merge notes from current when backup has none', () => {
    const note = makeNote({ id: 'c1', note: 'current-only' });
    const current: BookConfig = { booknotes: [note], updatedAt: 100 };
    const backup: BookConfig = { updatedAt: 90 };
    const result = mergeBookConfigs(current, backup);
    expect(result.booknotes).toHaveLength(1);
    expect(result.booknotes![0]!.id).toBe('c1');
  });

  it('should merge notes from backup when current has none', () => {
    const note = makeNote({ id: 'b1', note: 'backup-only' });
    const current: BookConfig = { updatedAt: 100 };
    const backup: BookConfig = { booknotes: [note], updatedAt: 90 };
    const result = mergeBookConfigs(current, backup);
    expect(result.booknotes).toHaveLength(1);
    expect(result.booknotes![0]!.id).toBe('b1');
  });

  it('should handle notes with updatedAt of 0', () => {
    const currentNote = makeNote({ id: '1', note: 'current', updatedAt: 0 });
    const backupNote = makeNote({ id: '1', note: 'backup', updatedAt: 0 });
    const current: BookConfig = { booknotes: [currentNote], updatedAt: 100 };
    const backup: BookConfig = { booknotes: [backupNote], updatedAt: 100 };
    const result = mergeBookConfigs(current, backup);
    // When both are 0, backup note doesn't win ((0 || 0) > (0 || 0) is false)
    expect(result.booknotes).toHaveLength(1);
    expect(result.booknotes![0]!.note).toBe('current');
  });

  it('should handle notes with undefined updatedAt (treated as 0)', () => {
    const currentNote = makeNote({
      id: '1',
      note: 'current',
      updatedAt: undefined as unknown as number,
    });
    const backupNote = makeNote({ id: '1', note: 'backup', updatedAt: 50 });
    const current: BookConfig = { booknotes: [currentNote], updatedAt: 100 };
    const backup: BookConfig = { booknotes: [backupNote], updatedAt: 100 };
    const result = mergeBookConfigs(current, backup);
    // Backup note has updatedAt 50, current has undefined (treated as 0)
    // (50 || 0) > (undefined || 0) => 50 > 0 => true, backup wins
    expect(result.booknotes).toHaveLength(1);
    expect(result.booknotes![0]!.note).toBe('backup');
  });

  it('should merge many notes from both sides without duplicates', () => {
    const currentNotes = Array.from({ length: 5 }, (_, i) =>
      makeNote({ id: `note-${i}`, note: `current-${i}`, updatedAt: 100 }),
    );
    const backupNotes = Array.from({ length: 5 }, (_, i) =>
      makeNote({ id: `note-${i + 3}`, note: `backup-${i + 3}`, updatedAt: 200 }),
    );
    // Overlapping ids: note-3, note-4 (exist in both)
    const current: BookConfig = { booknotes: currentNotes, updatedAt: 100 };
    const backup: BookConfig = { booknotes: backupNotes, updatedAt: 100 };
    const result = mergeBookConfigs(current, backup);

    // Total unique ids: note-0..note-7 = 8
    expect(result.booknotes).toHaveLength(8);

    // Overlapping notes should use backup version (higher updatedAt)
    const note3 = result.booknotes!.find((n) => n.id === 'note-3');
    expect(note3!.note).toBe('backup-3');
    const note4 = result.booknotes!.find((n) => n.id === 'note-4');
    expect(note4!.note).toBe('backup-4');

    // Non-overlapping from current should be preserved
    const note0 = result.booknotes!.find((n) => n.id === 'note-0');
    expect(note0!.note).toBe('current-0');
  });

  it('should preserve location from config with higher progress', () => {
    const current: BookConfig = { progress: [10, 200], location: 'loc-A', updatedAt: 100 };
    const backup: BookConfig = { progress: [20, 200], location: 'loc-B', updatedAt: 90 };
    const result = mergeBookConfigs(current, backup);
    expect(result.location).toBe('loc-B'); // backup has higher progress
  });

  it('should preserve location from current when current has higher progress', () => {
    const current: BookConfig = { progress: [30, 200], location: 'loc-A', updatedAt: 100 };
    const backup: BookConfig = { progress: [20, 200], location: 'loc-B', updatedAt: 90 };
    const result = mergeBookConfigs(current, backup);
    expect(result.location).toBe('loc-A');
  });

  it('should not mutate the original configs', () => {
    const currentNote = makeNote({ id: '1', note: 'original' });
    const current: BookConfig = { booknotes: [currentNote], progress: [10, 200], updatedAt: 100 };
    const backup: BookConfig = { progress: [20, 200], updatedAt: 90 };
    const currentCopy = JSON.parse(JSON.stringify(current)) as BookConfig;
    const backupCopy = JSON.parse(JSON.stringify(backup)) as BookConfig;

    mergeBookConfigs(current, backup);

    // Original objects should not be mutated
    expect(current.booknotes).toHaveLength(1);
    expect(JSON.stringify(current)).toBe(JSON.stringify(currentCopy));
    expect(JSON.stringify(backup)).toBe(JSON.stringify(backupCopy));
  });
});

describe('mergeBookMetadata - extended', () => {
  it('should handle equal updatedAt timestamps', () => {
    const current = makeBook({ updatedAt: 2000, title: 'Current Title' });
    const backup = makeBook({ updatedAt: 2000, title: 'Backup Title' });
    const result = mergeBookMetadata(current, backup);
    // When equal, backup.updatedAt > current.updatedAt is false, so current wins
    expect(result.title).toBe('Current Title');
    expect(result.updatedAt).toBe(2000);
  });

  it('should handle equal createdAt timestamps', () => {
    const current = makeBook({ createdAt: 1000 });
    const backup = makeBook({ createdAt: 1000 });
    const result = mergeBookMetadata(current, backup);
    expect(result.createdAt).toBe(1000);
  });

  it('should handle deletedAt being undefined (treated like null)', () => {
    const current = makeBook({ deletedAt: undefined });
    const backup = makeBook({ deletedAt: 5000 });
    const result = mergeBookMetadata(current, backup);
    // Only deleted if BOTH sides agree; undefined is falsy
    expect(result.deletedAt).toBeNull();
  });

  it('should handle both deletedAt being undefined', () => {
    const current = makeBook({ deletedAt: undefined });
    const backup = makeBook({ deletedAt: undefined });
    const result = mergeBookMetadata(current, backup);
    expect(result.deletedAt).toBeNull();
  });

  it('should handle deletedAt being 0 (falsy number)', () => {
    const current = makeBook({ deletedAt: 0 });
    const backup = makeBook({ deletedAt: 5000 });
    const result = mergeBookMetadata(current, backup);
    // 0 is falsy, so current.deletedAt && backup.deletedAt is falsy
    expect(result.deletedAt).toBeNull();
  });

  it('should preserve other fields from the base (higher updatedAt)', () => {
    const current = makeBook({
      updatedAt: 1000,
      hash: 'hash1',
      format: 'EPUB',
      author: 'Author A',
    });
    const backup = makeBook({
      updatedAt: 3000,
      hash: 'hash1',
      format: 'PDF',
      author: 'Author B',
    });
    const result = mergeBookMetadata(current, backup);
    // Backup has higher updatedAt, so its fields are base
    expect(result.format).toBe('PDF');
    expect(result.author).toBe('Author B');
  });

  it('should reconcile timestamps correctly when backup is older', () => {
    const current = makeBook({ updatedAt: 5000, createdAt: 500 });
    const backup = makeBook({ updatedAt: 3000, createdAt: 200 });
    const result = mergeBookMetadata(current, backup);
    expect(result.updatedAt).toBe(5000); // max
    expect(result.createdAt).toBe(200); // min
  });

  it('should reconcile timestamps correctly when current is older', () => {
    const current = makeBook({ updatedAt: 1000, createdAt: 100 });
    const backup = makeBook({ updatedAt: 5000, createdAt: 500 });
    const result = mergeBookMetadata(current, backup);
    expect(result.updatedAt).toBe(5000); // max
    expect(result.createdAt).toBe(100); // min
  });

  it('should handle both sides deleted with equal timestamps', () => {
    const current = makeBook({ deletedAt: 4000 });
    const backup = makeBook({ deletedAt: 4000 });
    const result = mergeBookMetadata(current, backup);
    expect(result.deletedAt).toBe(4000);
  });
});

/**
 * 复活没被「防复活护栏」吞掉的关键在 revivedAt：备份恢复把「备份里存活、
 * 本地已删」的书复活时，保存路径的 mergeLibraryRows 只认 revivedAt 放行，
 * 所以 reviveRestoredBooks 必须给每条都盖章，否则恢复结果保存时被整行丢弃
 * （界面上恢复了、重启后又没了）。revivedAt / updatedAt 的既有断言在
 * backup-service.test.ts 里没有覆盖，这里补齐。
 */
describe('reviveRestoredBooks - 复活与防复活护栏', () => {
  const NOW = 1_700_000_000_000;

  it('为多条复活书盖 revivedAt、清 syncedAt、按统一偏移抬高 updatedAt，并从备份恢复下载状态', () => {
    const revived: RevivedBook[] = [
      {
        book: makeBook({
          hash: 'a',
          deletedAt: null,
          updatedAt: 1000,
          syncedAt: 500,
          downloadedAt: null,
          coverDownloadedAt: null,
        }),
        backup: makeBook({ hash: 'a', updatedAt: 900, downloadedAt: 555, coverDownloadedAt: 666 }),
      },
      {
        book: makeBook({
          hash: 'b',
          deletedAt: null,
          updatedAt: 1500,
          syncedAt: 500,
          downloadedAt: null,
          coverDownloadedAt: null,
        }),
        backup: makeBook({ hash: 'b', updatedAt: 1200, downloadedAt: 777, coverDownloadedAt: 888 }),
      },
    ];

    reviveRestoredBooks(revived, NOW);
    const [a, b] = revived.map((r) => r.book);

    expect(a!.revivedAt).toBe(NOW);
    expect(b!.revivedAt).toBe(NOW);
    // max updatedAt 是 1500，统一偏移 = NOW - 1500；b 恰好落在 NOW。
    expect(a!.updatedAt).toBe(NOW - 500);
    expect(b!.updatedAt).toBe(NOW);
    // 相对顺序不变（库页「最近更新」排序保持）。
    expect(a!.updatedAt).toBeLessThan(b!.updatedAt);
    expect(a!.syncedAt).toBeNull();
    expect(b!.syncedAt).toBeNull();
    expect(a!.downloadedAt).toBe(555);
    expect(a!.coverDownloadedAt).toBe(666);
    expect(b!.downloadedAt).toBe(777);
    expect(b!.coverDownloadedAt).toBe(888);
  });

  it('不负责清 deletedAt —— 清墓碑是恢复循环里 mergeBookMetadata 的职责', () => {
    // reviveRestoredBooks 直接拿到的是「mergeBookMetadata 已经清过墓碑」的
    // 记录；它自己不该再碰 deletedAt。这里故意传入仍带墓碑的 book，断言
    // 该函数保持其原值，锁住职责边界。
    const revived: RevivedBook[] = [
      {
        book: makeBook({ deletedAt: 1000, updatedAt: 1000 }),
        backup: makeBook({ updatedAt: 900 }),
      },
    ];

    reviveRestoredBooks(revived, NOW);
    expect(revived[0]!.book.deletedAt).toBe(1000);
    expect(revived[0]!.book.revivedAt).toBe(NOW);
  });

  it('空数组入参不抛错、不做任何改动', () => {
    expect(() => reviveRestoredBooks([], NOW)).not.toThrow();
  });
});

/**
 * persistRestoredLibrary 是恢复主流程里「盖章 → 保存」两步的接线：revivedAt
 * 必须在 saveLibraryBooks 看到记录**之前**盖好，否则 mergeLibraryRows 的防复活
 * 护栏会把复活行整行丢弃（界面上恢复了、重启后又没了）。这里用「保存被调用
 * 的那一刻」读记录状态的假 appService 锁死顺序——单独测 reviveRestoredBooks
 * 或 mergeLibraryRows 都发现不了这两步被调换 / 删掉。
 */
describe('persistRestoredLibrary - 恢复主流程的盖章→保存接线', () => {
  const NOW = 1_700_000_000_000;

  // persistRestoredLibrary 内部走 reviveRestoredBooks 的默认 Date.now()，
  // 用假时钟固定住，让 revivedAt 断言确定。
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeRevived(): RevivedBook {
    return {
      book: makeBook({ hash: 'h1', deletedAt: null, updatedAt: 1000, syncedAt: 500 }),
      backup: makeBook({ hash: 'h1', updatedAt: 900 }),
    };
  }

  it('保存被调用的那一刻，复活书已经带上 revivedAt（盖章先于保存）', async () => {
    const revived = [makeRevived()];
    const books = [revived[0]!.book];
    const revivedAtAtSaveTime: (number | null | undefined)[] = [];
    const appService = {
      saveLibraryBooks: vi.fn(async (saved: Book[]) => {
        revivedAtAtSaveTime.push(saved.find((b) => b.hash === 'h1')?.revivedAt);
        return saved;
      }),
    };

    await persistRestoredLibrary(appService, books, revived);

    expect(revivedAtAtSaveTime).toEqual([NOW]);
    expect(revived[0]!.book.revivedAt).toBe(NOW);
  });

  it('恰好调用一次保存，且拿到的就是同一批 books 数组', async () => {
    const revived = [makeRevived()];
    const books = [revived[0]!.book];
    const appService = { saveLibraryBooks: vi.fn(async (saved: Book[]) => saved) };

    await persistRestoredLibrary(appService, books, revived);

    expect(appService.saveLibraryBooks).toHaveBeenCalledTimes(1);
    expect(appService.saveLibraryBooks).toHaveBeenCalledWith(books);
  });

  it('与护栏联动：保存时的这批记录喂给 mergeLibraryRows 能穿过墓碑护栏存活', async () => {
    // 磁盘侧是一条墓碑（deletedAt 有值）；恢复链路产物必须在合并后仍是活行。
    const onDiskTombstone = makeBook({ hash: 'h1', deletedAt: 1_000, updatedAt: 1_000 });
    const revived = [makeRevived()];
    const books = [revived[0]!.book];
    let savedBooks: Book[] = [];
    const appService = {
      saveLibraryBooks: vi.fn(async (saved: Book[]) => {
        savedBooks = saved;
        return saved;
      }),
    };

    await persistRestoredLibrary(appService, books, revived);

    const merged = mergeLibraryRows([onDiskTombstone], savedBooks);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.hash).toBe('h1');
    expect(merged[0]!.deletedAt).toBeNull();
    expect(merged[0]!.revivedAt).toBe(NOW);
  });

  it('revived 为空数组时照样调用保存、不抛错', async () => {
    const books = [makeBook({ hash: 'plain' })];
    const appService = { saveLibraryBooks: vi.fn(async (saved: Book[]) => saved) };

    await expect(persistRestoredLibrary(appService, books, [])).resolves.toBeUndefined();
    expect(appService.saveLibraryBooks).toHaveBeenCalledTimes(1);
    expect(appService.saveLibraryBooks).toHaveBeenCalledWith(books);
  });
});
