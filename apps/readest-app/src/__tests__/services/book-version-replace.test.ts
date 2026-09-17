import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Book, BookConfig, BookVersionConflictInfo } from '@/types/book';
import { AppService } from '@/types/system';
import { getMetadataHash } from '@/utils/book';
import { replaceBookVersion, selectVersionReplacements } from '@/services/bookVersionService';

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
vi.mock('@/utils/simplecc', () => ({
  initSimpleCC: vi.fn(),
  runSimpleCC: vi.fn(),
  simplifyChineseText: vi.fn(async (text: string) => text),
}));
vi.mock('@/services/statistics/statisticsDb', () => ({
  StatisticsDb: { peekOpen: () => null },
}));

import { BaseAppService } from '@/services/appService';
import { buildBookLookupIndex } from '@/services/bookService';

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

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    hash: 'old-hash-123',
    format: 'EPUB',
    title: 'Test Book',
    sourceTitle: 'Test Book',
    author: 'Test Author',
    createdAt: Date.now() - 10000,
    updatedAt: Date.now() - 10000,
    downloadedAt: Date.now() - 10000,
    deletedAt: null,
    ...overrides,
  };
}

const TEST_METADATA = {
  title: 'Test Book',
  author: 'Test Author',
  language: 'en',
  identifier: 'isbn-123',
};

function setupMockBookDoc(metadata: Record<string, unknown> = TEST_METADATA) {
  const bookDoc = {
    metadata,
    getCover: vi.fn().mockResolvedValue(null),
  };
  mockOpen.mockResolvedValue({ book: bookDoc, format: 'EPUB' });
}

function makeService() {
  const service = new TestAppService();
  const fs = service.getFs();
  fs.exists.mockResolvedValue(false);
  fs.createDir.mockResolvedValue(undefined);
  fs.writeFile.mockResolvedValue(undefined);
  fs.removeDir.mockResolvedValue(undefined);
  fs.readFile.mockResolvedValue('{}');
  return { service, fs };
}

/**
 * Import the same title/author as a *different* file. `identifier` decides what
 * the identity looks like: without one, metaHash degenerates to title+author and
 * the record is never foldable; with one it is a real (possibly differing) key.
 */
async function importConflict(args: {
  service: TestAppService;
  books: Book[];
  metadata: Record<string, unknown>;
  onVersionConflict?: (info: BookVersionConflictInfo) => void;
}) {
  const { service, books, metadata, onVersionConflict } = args;
  mockPartialMD5.mockResolvedValue('new-hash-456');
  setupMockBookDoc(metadata);
  const file = new File(['new content'], 'test.epub', { type: 'application/epub+zip' });
  const book = await service.importBook(
    file,
    books,
    onVersionConflict ? { onVersionConflict } : {},
  );
  return book;
}

describe('importBook version conflict reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 不变量 1：无显式身份（没标识符、没有文件名盐）的导入在任何路径上都不折叠。
  // 判据必须无条件生效——不注册回调的静默路径（受监视文件夹重扫、双击打开）
  // 同样不能吃掉记录，否则用户连发现的机会都没有。
  it('never folds an identifier-less import, with or without a callback', async () => {
    for (const withCallback of [true, false]) {
      vi.clearAllMocks();
      const { service, fs } = makeService();
      fs.exists.mockImplementation(async (path: string) => path === 'old-hash-123');
      const metadata = { title: 'Test Book', author: 'Test Author', language: 'en' };
      const existing = makeBook({ metaHash: getMetadataHash(metadata) });
      const books: Book[] = [existing];
      const conflicts: BookVersionConflictInfo[] = [];

      await importConflict({
        service,
        books,
        metadata,
        ...(withCallback
          ? { onVersionConflict: (info: BookVersionConflictInfo) => conflicts.push(info) }
          : {}),
      });

      // Both records survive, nothing was deleted, nothing was re-keyed.
      expect(books.filter((b) => !b.deletedAt)).toHaveLength(2);
      expect(fs.removeDir).not.toHaveBeenCalledWith('old-hash-123', 'Books', true);
      expect(existing.hash).toBe('old-hash-123');
      if (withCallback) {
        // The dialog still asks: the loose title+author probe covers it.
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]!.existing).toBe(existing);
        expect(conflicts[0]!.incoming.hash).toBe('new-hash-456');
      } else {
        expect(conflicts).toHaveLength(0);
      }
    }
  });

  // 不变量 1 的第二个方向（实测过它会删目录）：以同 hash 命中进入（同一个文件
  // 重导）时，库里那条无标识符的同键记录同样不能被折叠。修复前这条路径会把
  // 另一条记录 tombstone 掉并删掉它的目录。
  it('does not fold an identifier-less same-key record on a same-hash re-import', async () => {
    const { service, fs } = makeService();
    fs.exists.mockImplementation(async (path: string) => path === 'kept-hash');
    const metadata = { title: 'Test Book', author: 'Test Author', language: 'en' };
    const metaHash = getMetadataHash(metadata);
    const reimported = makeBook({ hash: 'other-hash', metaHash });
    const kept = makeBook({ hash: 'kept-hash', metaHash });
    const books: Book[] = [reimported, kept];

    // Re-import the very file that produced `reimported` (identical hash).
    mockPartialMD5.mockResolvedValue('other-hash');
    setupMockBookDoc(metadata);
    await service.importBook(
      new File(['same bytes'], 'test.epub', { type: 'application/epub+zip' }),
      books,
      {},
    );

    expect(books.filter((b) => !b.deletedAt)).toHaveLength(2);
    expect(books.find((b) => b.hash === 'kept-hash')!.deletedAt).toBeFalsy();
    expect(fs.removeDir).not.toHaveBeenCalled();
  });

  // 不变量 1（显式身份的正常路径必须保住）：Pixiv 这类带标识符的书，静默路径
  // 上仍走自动合并——受监视文件夹里重新下载的同一篇会原地更新，进度保留。
  it('still auto-merges a same-identifier import without a callback', async () => {
    const { service, fs } = makeService();
    fs.exists.mockImplementation(async (path: string) => path === 'old-hash-123');
    const existing = makeBook({
      metaHash: getMetadataHash(TEST_METADATA),
      progress: [40, 200],
    });
    const books: Book[] = [existing];

    await importConflict({ service, books, metadata: TEST_METADATA });

    expect(books.filter((b) => !b.deletedAt)).toHaveLength(1);
    expect(books[0]!.hash).toBe('new-hash-456');
    expect(fs.removeDir).toHaveBeenCalledWith('old-hash-123', 'Books', true);
  });

  // 不变量 2 / §5 护栏：同一个身份在本库里对应两条存活记录时，身份不再能定位
  // 唯一的一本书，折叠只能靠"谁排在前面"，因此一律不折、改为询问。这条同时
  // 覆盖"用户选过保留为两本"留下的状态、历史遗留的同键重复、以及同步带进来的
  // 同键记录。
  it('refuses to fold when the library holds two live records for the same identity', async () => {
    const { service, fs } = makeService();
    fs.exists.mockImplementation(async (path: string) => path === 'kept-hash');
    const metaHash = getMetadataHash(TEST_METADATA);
    const oldBook = makeBook({ hash: 'old-hash-123', metaHash });
    const keptBook = makeBook({ hash: 'kept-hash', metaHash });
    const books: Book[] = [oldBook, keptBook];
    const conflicts: BookVersionConflictInfo[] = [];

    await importConflict({
      service,
      books,
      metadata: TEST_METADATA,
      onVersionConflict: (info) => conflicts.push(info),
    });

    // Nothing was folded in either direction, and the user is asked instead.
    expect(books.filter((b) => !b.deletedAt)).toHaveLength(3);
    expect(books.find((b) => b.hash === 'kept-hash')!.deletedAt).toBeFalsy();
    expect(books.find((b) => b.hash === 'old-hash-123')!.deletedAt).toBeFalsy();
    expect(fs.removeDir).not.toHaveBeenCalled();
    expect(conflicts).toHaveLength(1);
  });

  // Same guard, other entry: the ambiguous identity stays untouched even when the
  // incoming file is byte-identical to one of the two records.
  it('refuses to fold an ambiguous identity on a same-hash re-import too', async () => {
    const { service, fs } = makeService();
    fs.exists.mockImplementation(async (path: string) => path === 'other-hash');
    const metaHash = getMetadataHash(TEST_METADATA);
    const reimported = makeBook({ hash: 'other-hash', metaHash });
    const other = makeBook({ hash: 'old-hash-123', metaHash });
    const books: Book[] = [reimported, other];

    mockPartialMD5.mockResolvedValue('other-hash');
    setupMockBookDoc(TEST_METADATA);
    await service.importBook(
      new File(['same bytes'], 'test.epub', { type: 'application/epub+zip' }),
      books,
      {},
    );

    expect(books.filter((b) => !b.deletedAt)).toHaveLength(2);
    expect(fs.removeDir).not.toHaveBeenCalled();
  });

  // 换了一个下载源，UUID 不同 → metaHash 不同，但标题作者一致：统一走询问。
  it('reports a same-title-author match when the metaHash differs', async () => {
    const { service } = makeService();
    const existing = makeBook({
      metaHash: getMetadataHash({
        title: 'Test Book',
        author: 'Test Author',
        language: 'en',
        identifier: 'old-uuid',
      }),
    });
    const books: Book[] = [existing];
    const conflicts: BookVersionConflictInfo[] = [];

    await importConflict({
      service,
      books,
      metadata: {
        title: 'Test Book',
        author: 'Test Author',
        language: 'en',
        identifier: 'new-uuid',
      },
      onVersionConflict: (info) => conflicts.push(info),
    });

    expect(conflicts).toHaveLength(1);
    expect(books.filter((b) => !b.deletedAt)).toHaveLength(2);
  });

  it('finds a renamed book by its import-time title', async () => {
    const { service } = makeService();
    const existing = makeBook({
      title: '我改过的书名',
      sourceTitle: 'Test Book',
      metaHash: 'unrelated',
    });
    const books: Book[] = [existing];
    const conflicts: BookVersionConflictInfo[] = [];

    await importConflict({
      service,
      books,
      metadata: { title: 'Test Book', author: 'Test Author', language: 'en' },
      onVersionConflict: (info) => conflicts.push(info),
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.existing).toBe(existing);
  });

  it('ignores a tombstoned book', async () => {
    const { service } = makeService();
    const existing = makeBook({ metaHash: 'unrelated', deletedAt: Date.now() });
    const books: Book[] = [existing];
    const conflicts: BookVersionConflictInfo[] = [];

    await importConflict({
      service,
      books,
      metadata: { title: 'Test Book', author: 'Test Author', language: 'en' },
      onVersionConflict: (info) => conflicts.push(info),
    });

    expect(conflicts).toHaveLength(0);
  });

  // 格式闸门：PDF 元数据是样板文字（#5411），不参与候选匹配。
  it('does not report conflicts for non-EPUB formats', async () => {
    const { service, fs } = makeService();
    fs.exists.mockImplementation(async (path: string) => path === 'old-hash-123');
    const pdfMetadata = {
      title: 'PowerPoint Presentation',
      author: 'Alice Author',
      language: 'en',
    };
    const existing = makeBook({
      format: 'PDF',
      title: 'PowerPoint Presentation',
      author: 'Alice Author',
      // PDF metaHash is salted with the extension-less filename (#5411).
      metaHash: getMetadataHash(pdfMetadata, 'deck'),
    });
    const books: Book[] = [existing];
    const conflicts: BookVersionConflictInfo[] = [];

    mockPartialMD5.mockResolvedValue('pdf-hash-2');
    mockOpen.mockResolvedValue({
      book: { metadata: pdfMetadata, getCover: vi.fn().mockResolvedValue(null) },
      format: 'PDF',
    });
    await service.importBook(new File(['v2'], 'deck.pdf', { type: 'application/pdf' }), books, {
      onVersionConflict: (info) => conflicts.push(info),
    });

    expect(conflicts).toHaveLength(0);
    // Still the old silent auto-merge path.
    expect(books.filter((b) => !b.deletedAt)).toHaveLength(1);
    expect(books[0]!.hash).toBe('pdf-hash-2');
  });

  it('does not report conflicts for transient imports', async () => {
    const { service } = makeService();
    const fs = service.getFs();
    fs.openFile.mockResolvedValue(new File(['content'], 'test.epub'));
    const existing = makeBook({ metaHash: 'unrelated' });
    const books: Book[] = [existing];
    const conflicts: BookVersionConflictInfo[] = [];

    mockPartialMD5.mockResolvedValue('transient-hash');
    setupMockBookDoc({ title: 'Test Book', author: 'Test Author', language: 'en' });
    await service.importBook('/path/to/test.epub', books, {
      transient: true,
      onVersionConflict: (info) => conflicts.push(info),
    });

    expect(conflicts).toHaveLength(0);
  });

  it('works without a lookup index (linear fallback)', async () => {
    const { service } = makeService();
    const existing = makeBook({ metaHash: 'unrelated' });
    const books: Book[] = [existing];
    const conflicts: BookVersionConflictInfo[] = [];
    const lookupIndex = buildBookLookupIndex(books);
    // Simulate a caller that built only a partial index.
    delete (lookupIndex as { byVersionKey?: unknown }).byVersionKey;

    mockPartialMD5.mockResolvedValue('new-hash-456');
    setupMockBookDoc({ title: 'Test Book', author: 'Test Author', language: 'en' });
    await service.importBook(
      new File(['content'], 'test.epub', { type: 'application/epub+zip' }),
      books,
      { lookupIndex, onVersionConflict: (info) => conflicts.push(info) },
    );

    expect(conflicts).toHaveLength(1);
  });
});

describe('replaceBookVersion', () => {
  const OLD_CONFIG: Partial<BookConfig> = {
    updatedAt: 1000,
    bookHash: 'old-hash-123',
    metaHash: 'old-meta',
    location: 'epubcfi(/6/14!/4/2/2[c05]/1:0)',
    progress: [40, 200],
    viewSettings: { paragraphMargin: 1.8 },
    virtualToc: [
      { label: '自制章节', cfi: 'epubcfi(/6/14!/4/2/2[c05])', source: 'pattern', generatedAt: 1 },
    ],
    booknotes: [
      {
        id: 'note-1',
        type: 'annotation',
        cfi: 'epubcfi(/6/14!/4/2/2[c05])',
        note: '重点',
        bookHash: 'old-hash-123',
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  };

  function makeFakeAppService(config: Partial<BookConfig>) {
    const files = new Map<string, string>([['old-hash-123/config.json', JSON.stringify(config)]]);
    const saved: Book[][] = [];
    const appService = {
      readFile: vi.fn(async (path: string) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`missing ${path}`);
        return content;
      }),
      writeFile: vi.fn(async (path: string, _base: string, content: string) => {
        files.set(path, content);
      }),
      deleteBook: vi.fn(async () => {}),
      isDirectory: vi.fn(async () => true),
      deleteDir: vi.fn(async () => {}),
      saveLibraryBooks: vi.fn(async (books: Book[]) => {
        saved.push(books);
        return books;
      }),
    } as unknown as AppService;
    return { appService, files, saved };
  }

  function makePair() {
    const oldBook = makeBook({
      hash: 'old-hash-123',
      metaHash: 'old-meta',
      progress: [40, 200],
      groupId: 'g1',
      groupName: '我的分组',
      tags: ['科幻'],
      shelfIndex: 3,
      readingStatus: 'reading',
      readingStatusUpdatedAt: 5000,
      deletedAt: null,
    });
    const newBook = makeBook({
      hash: 'new-hash-456',
      metaHash: 'new-meta',
      createdAt: Date.now(),
      groupId: undefined,
      groupName: undefined,
      tags: undefined,
      shelfIndex: undefined,
    });
    return { oldBook, newBook, books: [oldBook, newBook] };
  }

  it('rewrites the config under the new hash and keeps the reading position', async () => {
    const { appService, files } = makeFakeAppService(OLD_CONFIG);
    const { oldBook, newBook, books } = makePair();

    await replaceBookVersion(appService, { oldBook, newBook, books });

    const written = JSON.parse(files.get('new-hash-456/config.json')!) as Partial<BookConfig>;
    expect(written.bookHash).toBe('new-hash-456');
    expect(written.metaHash).toBe('new-meta');
    expect(written.location).toBe(OLD_CONFIG.location);
    expect(written.progress).toEqual([40, 200]);
    expect(written.viewSettings).toEqual({ paragraphMargin: 1.8 });
    expect(written.virtualToc).toEqual(OLD_CONFIG.virtualToc);
    expect(written.booknotes).toHaveLength(1);
    expect(written.booknotes![0]!.bookHash).toBe('new-hash-456');
    expect(written.booknotes![0]!.note).toBe('重点');
  });

  it('moves row-level user data onto the surviving record', async () => {
    const { appService } = makeFakeAppService(OLD_CONFIG);
    const { oldBook, newBook, books } = makePair();

    const result = await replaceBookVersion(appService, { oldBook, newBook, books });

    expect(result.book.hash).toBe('new-hash-456');
    expect(result.book.progress).toEqual([40, 200]);
    expect(result.book.groupId).toBe('g1');
    expect(result.book.groupName).toBe('我的分组');
    expect(result.book.tags).toEqual(['科幻']);
    expect(result.book.shelfIndex).toBe(3);
    expect(result.book.readingStatus).toBe('reading');
    // The new file's own metadata/cover identity survives.
    expect(result.book.title).toBe('Test Book');
  });

  // 用户改过的书名属于用户数据（和分组、标签同类）：图书库的改名路径只写
  // `title`、留着 `sourceTitle`，两者不同即"改过名"。替换时取新版书名会静默
  // 撤销用户的编辑；时间戳也必须一起抬，否则这条记录会"声称用户在 T 时刻改过
  // 元数据"却显示着文件名自带的书名。
  it('carries a user-edited title over and stamps a fresh metadata clock', async () => {
    const { appService } = makeFakeAppService(OLD_CONFIG);
    const { oldBook, newBook } = makePair();
    const renamed = { ...oldBook, title: '我改过的书名', metadataUpdatedAt: 111 };
    const withRenamed = [renamed, newBook];

    const before = Date.now();
    const result = await replaceBookVersion(appService, {
      oldBook: renamed,
      newBook,
      books: withRenamed,
    });

    expect(result.book.title).toBe('我改过的书名');
    expect(result.book.metadataUpdatedAt).toBeGreaterThanOrEqual(before);
    // The untouched file-derived field still comes from the new import.
    expect(result.book.sourceTitle).toBe('Test Book');
  });

  it('keeps the new release title when the user never renamed the book', async () => {
    const { appService } = makeFakeAppService(OLD_CONFIG);
    const { oldBook, newBook } = makePair();
    const withUntouched = [{ ...oldBook, title: 'Test Book' }, newBook];

    const result = await replaceBookVersion(appService, {
      oldBook: withUntouched[0]!,
      newBook,
      books: withUntouched,
    });

    expect(result.book.title).toBe(newBook.title);
    expect(result.book.metadataUpdatedAt).toBeUndefined();
  });

  // 平局归旧：历史行可以带着阅读状态却没有时间戳（那个字段比数据晚出现），而
  // 新导入的记录永远没有时间戳。若平局判给新记录，用户的状态会被静默丢掉。
  it('keeps a status that carries no timestamp', async () => {
    const { appService } = makeFakeAppService(OLD_CONFIG);
    const { oldBook, newBook } = makePair();
    const legacy = {
      ...oldBook,
      readingStatus: 'finished' as const,
      readingStatusUpdatedAt: undefined,
    };

    const result = await replaceBookVersion(appService, {
      oldBook: legacy,
      newBook,
      books: [legacy, newBook],
    });

    expect(result.book.readingStatus).toBe('finished');
  });

  // 弹窗打开后旧行可能已经被折进另一个新记录（一条批里两个不同版本指向同一
  // 本旧书）：这时宁可明确失败、两本都留着，也不能拿过期快照把旧数据重复搬到
  // 第二个新记录上，更不能静默跳过。
  it('refuses to work from a stale snapshot when the old row is gone', async () => {
    const { appService, saved } = makeFakeAppService(OLD_CONFIG);
    const { oldBook, newBook } = makePair();

    await expect(
      replaceBookVersion(appService, { oldBook, newBook, books: [newBook] }),
    ).rejects.toThrow(/no longer in the library/);

    expect(appService.writeFile).not.toHaveBeenCalled();
    expect(appService.deleteDir).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it('drops the old row and persists a replace (not merge) write', async () => {
    const { appService, saved } = makeFakeAppService(OLD_CONFIG);
    const { oldBook, newBook, books } = makePair();

    const result = await replaceBookVersion(appService, { oldBook, newBook, books });

    expect(appService.saveLibraryBooks).toHaveBeenCalledWith(result.library, { replace: true });
    expect(saved[0]!.map((book) => book.hash)).toEqual(['new-hash-456']);
    expect(result.library).not.toContain(oldBook);
  });

  it('deletes the old managed directory', async () => {
    const { appService } = makeFakeAppService(OLD_CONFIG);
    const { oldBook, newBook, books } = makePair();

    await replaceBookVersion(appService, { oldBook, newBook, books });

    expect(appService.isDirectory).toHaveBeenCalledWith('old-hash-123', 'Books');
    expect(appService.deleteDir).toHaveBeenCalledWith('old-hash-123', 'Books', true);
  });

  it('is a no-op when both records already share a hash', async () => {
    const { appService } = makeFakeAppService(OLD_CONFIG);
    const book = makeBook({ hash: 'same-hash' });

    const result = await replaceBookVersion(appService, {
      oldBook: book,
      newBook: book,
      books: [book],
    });

    expect(result.book).toBe(book);
    expect(appService.saveLibraryBooks).not.toHaveBeenCalled();
    expect(appService.writeFile).not.toHaveBeenCalled();
  });

  it('still replaces when the old config is missing', async () => {
    const { appService, files } = makeFakeAppService({});
    const { oldBook, newBook, books } = makePair();

    const result = await replaceBookVersion(appService, { oldBook, newBook, books });

    const written = JSON.parse(files.get('new-hash-456/config.json')!) as Partial<BookConfig>;
    expect(written.bookHash).toBe('new-hash-456');
    expect(result.book.progress).toEqual([40, 200]);
  });
});

describe('selectVersionReplacements', () => {
  const conflict = (oldHash: string, newHash: string): BookVersionConflictInfo => ({
    existing: makeBook({ hash: oldHash }),
    incoming: makeBook({ hash: newHash }),
  });

  it('keeps only the chosen items', () => {
    const conflicts = [conflict('o1', 'n1'), conflict('o2', 'n2')];
    const { replacements, skipped } = selectVersionReplacements(conflicts, ['replace', 'keep']);

    expect(replacements.map((c) => c.incoming.hash)).toEqual(['n1']);
    expect(skipped.map((c) => c.incoming.hash)).toEqual(['n2']);
  });

  // 同一本旧书只能被折一次：后面的即使选了"替换"也不能执行，否则会把旧数据
  // 重复搬到第二个新记录上（旧行那时已经不在库里）。
  it('lets only the first conflict claim a given old book', () => {
    const conflicts = [conflict('o1', 'n1'), conflict('o1', 'n2')];
    const { replacements, skipped } = selectVersionReplacements(conflicts, ['replace', 'replace']);

    expect(replacements.map((c) => c.incoming.hash)).toEqual(['n1']);
    expect(skipped.map((c) => c.incoming.hash)).toEqual(['n2']);
  });
});
