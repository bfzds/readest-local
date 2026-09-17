import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Book, BookVersionConflictInfo } from '@/types/book';

const mockOpen = vi.hoisted(() => vi.fn());
const mockPartialMD5 = vi.hoisted(() => vi.fn());

vi.mock('@/utils/md5', async () => {
  const actual = await vi.importActual<typeof import('@/utils/md5')>('@/utils/md5');
  return { ...actual, partialMD5: mockPartialMD5 };
});

vi.mock('@/libs/document', async () => {
  const actual = await vi.importActual<typeof import('@/libs/document')>('@/libs/document');
  class MockDocumentLoader {
    open() {
      return mockOpen();
    }
  }
  return { ...actual, DocumentLoader: MockDocumentLoader };
});

vi.mock('@/utils/txt', () => ({ TxtToEpubConverter: vi.fn() }));
vi.mock('@/utils/svg', () => ({ svg2png: vi.fn() }));
import { BaseAppService } from '@/services/appService';
import {
  buildBookLookupIndex,
  collectKnownSourcePaths,
  selectNewImportableFiles,
} from '@/services/bookService';

class TestAppService extends BaseAppService {
  protected fs = {
    openFile: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    copyFile: vi.fn(),
    removeFile: vi.fn(),
    readDir: vi.fn(),
    createDir: vi.fn(),
    removeDir: vi.fn(),
    exists: vi.fn(),
    stats: vi.fn(),
    resolvePath: vi.fn(),
    getURL: vi.fn(),
    getBlobURL: vi.fn().mockResolvedValue(''),
    getImageURL: vi.fn(),
    getPrefix: vi.fn(),
  };

  protected resolvePath() {
    return { baseDir: 0, basePrefix: async () => '', fp: '', base: 'Books' as const };
  }

  override osPlatform = 'linux' as BaseAppService['osPlatform'];

  async init() {}
  async setCustomRootDir() {}
  async selectDirectory() {
    return '';
  }
  async selectFiles() {
    return [];
  }
  async saveFile() {
    return false;
  }
  async saveImageToGallery() {
    return false;
  }
  async ask() {
    return false;
  }
  async openDatabase() {
    return {} as ReturnType<BaseAppService['openDatabase']>;
  }
  async createWindow() {}
  async getCacheDir() {
    return '';
  }
  async clearWebviewCache() {}
  async showNotification() {}

  getFs() {
    return this.fs;
  }
}

const TEST_METADATA = {
  title: 'Duplicated Book',
  author: 'Author',
  language: 'en',
  identifier: 'isbn-dup',
};

/** One watched folder holding the same book under two different filenames. */
const ORIGINAL_PATH = '/lib/watched/book.epub';
const DUPLICATE_PATH = '/lib/watched/book-copy.epub';
const SCANNED = [
  { fullPath: ORIGINAL_PATH, size: 1024 },
  { fullPath: DUPLICATE_PATH, size: 1024 },
];

describe('auto-import: watched folder with duplicated files', () => {
  let service: TestAppService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TestAppService();
    const fs = service.getFs();
    fs.exists.mockResolvedValue(false);
    fs.createDir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
    fs.removeDir.mockResolvedValue(undefined);
    fs.readFile.mockResolvedValue('{}');
    fs.openFile.mockImplementation(async (path: string) => new File(['content'], path));
    // Same bytes under both names -> identical partial md5.
    mockPartialMD5.mockResolvedValue('dup-hash');
    mockOpen.mockResolvedValue({
      book: { metadata: TEST_METADATA, getCover: vi.fn().mockResolvedValue(null) },
      format: 'EPUB',
    });
  });

  /** One auto-import pass: pick the files that look new, then ingest them. */
  const runScan = async (
    library: Book[],
    onVersionConflict?: (info: BookVersionConflictInfo) => void,
  ) => {
    const existingPaths = collectKnownSourcePaths(library, 'linux');
    const fresh = selectNewImportableFiles(SCANNED, {
      extensions: ['epub'],
      minSizeBytes: 0,
      existingPaths,
      osPlatform: 'linux',
    });
    const lookupIndex = buildBookLookupIndex(library, 'linux');
    for (const entry of fresh) {
      await service.importBook(entry.fullPath, library, {
        lookupIndex,
        inPlace: true,
        ...(onVersionConflict ? { onVersionConflict } : {}),
      });
    }
    return fresh.map((f) => f.fullPath);
  };

  it('does not re-import the duplicate on every later scan', async () => {
    const library: Book[] = [];

    const first = await runScan(library);
    expect(first).toEqual([ORIGINAL_PATH, DUPLICATE_PATH]);
    // Both files are the same book, so the library holds a single entry.
    expect(library.filter((b) => !b.deletedAt)).toHaveLength(1);

    // Second scan (app returns to the foreground): nothing on disk changed, so
    // nothing should be imported again.
    const second = await runScan(library);
    expect(second).toEqual([]);

    // And it must stay quiet on every later scan, not ping-pong between the
    // two paths.
    const third = await runScan(library);
    expect(third).toEqual([]);
  });

  it('keeps both names on the single deduped entry', async () => {
    const library: Book[] = [];
    await runScan(library);

    const book = library.find((b) => !b.deletedAt)!;
    // The most recently ingested file owns `filePath` (that is what makes a
    // rename recoverable); the other name is remembered alongside it.
    expect(book.filePath).toBe(DUPLICATE_PATH);
    expect(book.altFilePaths).toEqual([ORIGINAL_PATH]);
  });

  it('does not accumulate duplicate entries across repeated imports', async () => {
    const library: Book[] = [];
    await runScan(library);

    const book = library.find((b) => !b.deletedAt)!;
    const lookupIndex = buildBookLookupIndex(library, 'linux');
    // Re-importing the same two files (manual folder import, which ignores the
    // known-path filter) must not grow the list without bound.
    await service.importBook(ORIGINAL_PATH, library, { lookupIndex, inPlace: true });
    await service.importBook(DUPLICATE_PATH, library, { lookupIndex, inPlace: true });

    expect(book.filePath).toBe(DUPLICATE_PATH);
    expect(book.altFilePaths).toEqual([ORIGINAL_PATH]);
  });

  it('follows a rename and remembers the vacated path', async () => {
    const library: Book[] = [];
    const lookupIndex = buildBookLookupIndex(library, 'linux');
    await service.importBook(ORIGINAL_PATH, library, { lookupIndex, inPlace: true });

    const originalObject = library[0]!;
    expect(library[0]!.filePath).toBe(ORIGINAL_PATH);

    const renamed = '/lib/watched/renamed.epub';
    await service.importBook(renamed, library, {
      lookupIndex: buildBookLookupIndex(library, 'linux'),
      inPlace: true,
    });

    // B-6：原对象不被动过；store 通过新数组引用拿到更新后的副本。
    expect(originalObject.filePath).toBe(ORIGINAL_PATH);
    // Content is read from `filePath`, so it must point at the name that
    // actually exists on disk now.
    expect(library[0]!.filePath).toBe(renamed);
    expect(library[0]!.altFilePaths).toEqual([ORIGINAL_PATH]);
  });

  // 另一个去重臂：字节不同（hash 不同）、但描述同一本书（metaHash 相同）的两个
  // 文件。导入路径不再把旧记录折进新的那条——那是会连带删掉旧目录的静默删除。
  // 两条记录各自记住自己的来源路径，所以重扫依旧安静：不会反复"发现新文件"，
  // 冲突也只在第一次导入时上报一次。
  it('keeps two records for two files sharing a metaHash and remembers both paths', async () => {
    mockPartialMD5.mockImplementation(async (file: File) =>
      file.name === ORIGINAL_PATH ? 'hash-a' : 'hash-b',
    );

    const library: Book[] = [];
    const conflicts: BookVersionConflictInfo[] = [];
    const first = await runScan(library, (info) => conflicts.push(info));
    expect(first).toEqual([ORIGINAL_PATH, DUPLICATE_PATH]);
    expect(library.filter((b) => !b.deletedAt)).toHaveLength(2);

    expect(library.find((b) => b.hash === 'hash-a')!.filePath).toBe(ORIGINAL_PATH);
    expect(library.find((b) => b.hash === 'hash-b')!.filePath).toBe(DUPLICATE_PATH);
    // 静默重扫没有回调就不会问，但判定结果照样产出（调用方决定何时弹）。
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.reason).toBe('same-identifier');
    expect(conflicts[0]!.candidates.map((b) => b.hash)).toEqual(['hash-a']);
    expect(await runScan(library)).toEqual([]);
  });

  it('leaves alternative paths unset for a copy-mode import', async () => {
    const library: Book[] = [];
    const lookupIndex = buildBookLookupIndex(library, 'linux');
    await service.importBook(ORIGINAL_PATH, library, { lookupIndex });
    await service.importBook(DUPLICATE_PATH, library, { lookupIndex });

    const book = library.find((b) => !b.deletedAt)!;
    // Copy-mode books live under Books/<hash>/ and carry no source path at all.
    expect(book.filePath).toBeUndefined();
    expect(book.altFilePaths).toBeUndefined();
  });
});
