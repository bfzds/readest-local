import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Book, BookConfig, BookVersionConflictInfo } from '@/types/book';
import type { BookMetadata } from '@/libs/document';
import { AppService } from '@/types/system';
import { getMetadataHash } from '@/utils/book';
import {
  discardImportedBook,
  findBatchVersionConflicts,
  findIncomingVersionConflict,
  mergeBatchVersionConflicts,
  planVersionConflictResolution,
  replaceBookVersion,
} from '@/services/bookVersionService';

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
// TXT 导入会先把原始 TXT 转成 EPUB 再解析。这里给一个确定的转换产物，好让
// "转换产物字节稳定"这件事从断言里隔离出去（真实转换器的 dc:identifier 取自
// 原始 TXT 的 partialMD5、zip 时间戳被钉成 0，本来就是字节稳定的）。
vi.mock('@/utils/txt-worker', () => ({
  convertTxtToEpubWithFallback: vi.fn(async () => ({
    file: new File(['converted epub'], 'Test Book.epub', { type: 'application/epub+zip' }),
    bookTitle: 'Test Book',
    chapterCount: 1,
    language: 'zh',
    textLength: 4,
    toc: [{ label: '第一章', depth: 0 }],
    usedFallback: false,
  })),
}));
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
  fs.stats.mockResolvedValue({
    isFile: true,
    isDirectory: false,
    size: 0,
    mtime: null,
    atime: null,
    birthtime: null,
  });
  return { service, fs };
}

type StubFs = ReturnType<TestAppService['getFs']>;

/** 让"书文件还在盘上"这条判据成立，byHash 命中才会走不打扰的短路路径。 */
function makeManagedFileExist(fs: StubFs) {
  fs.exists.mockImplementation(async (path: string) => path === 'old-hash-123/Test Book.epub');
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
        expect(conflicts[0]!.candidates[0]).toBe(existing);
        expect(conflicts[0]!.incoming.hash).toBe('new-hash-456');
        expect(conflicts[0]!.reason).toBe('incoming-without-identifier');
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

  // 显式身份也同样不折叠了：以前"书号相同"会自动原地替换并删掉旧目录，现在
  // 一律落成独立记录、交给用户在弹窗里决定——导入路径不再删除任何东西。
  it('does not fold a same-identifier import even without a callback', async () => {
    const { service, fs } = makeService();
    fs.exists.mockImplementation(async (path: string) => path === 'old-hash-123');
    const existing = makeBook({
      metaHash: getMetadataHash(TEST_METADATA),
      progress: [40, 200],
    });
    const books: Book[] = [existing];

    await importConflict({ service, books, metadata: TEST_METADATA });

    expect(books.filter((b) => !b.deletedAt)).toHaveLength(2);
    expect(books[0]!.hash).toBe('old-hash-123');
    expect(books[0]!.progress).toEqual([40, 200]);
    expect(fs.removeDir).not.toHaveBeenCalled();
  });

  // 不变量 2 / §5 护栏：同一个身份在本库里对应两条存活记录时，身份不再能定位
  // 唯一的一本书，因此一律不折、改为询问。这条同时覆盖"用户选过保留为两本"留下
  // 的状态、历史遗留的同键重复、以及同步带进来的同键记录。
  it('leaves both live records for the same identity untouched', async () => {
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
    // 两条同书号记录都进候选：[0] 按进度排在前面（这里都没有进度，取书库顺序）。
    expect(conflicts[0]!.candidates.map((b) => b.hash)).toEqual(['old-hash-123', 'kept-hash']);
    expect(conflicts[0]!.reason).toBe('same-identifier');
  });

  // 候选按阅读进度降序：书库里那条读得最远的才是"替换目标"，否则用户看到的
  // [0] 会随书库顺序抖动。
  it('orders candidates by reading progress', async () => {
    const { service } = makeService();
    const metaHash = getMetadataHash(TEST_METADATA);
    const barelyStarted = makeBook({ hash: 'b-hash', metaHash, progress: [1, 300] });
    const farAlong = makeBook({ hash: 'a-hash', metaHash, progress: [250, 300] });
    const books: Book[] = [barelyStarted, farAlong];
    const conflicts: BookVersionConflictInfo[] = [];

    await importConflict({
      service,
      books,
      metadata: TEST_METADATA,
      onVersionConflict: (info) => conflicts.push(info),
    });

    expect(conflicts[0]!.candidates.map((b) => b.hash)).toEqual(['a-hash', 'b-hash']);
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
    expect(conflicts[0]!.reason).toBe('identifier-differs');
    expect(conflicts[0]!.candidates).toEqual([existing]);
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
    expect(conflicts[0]!.candidates[0]).toBe(existing);
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

  // PDF 的"书号"是文件名字盐（#5411），所以同名 PDF 必然同书号。以前它会被
  // 静默原地替换掉旧记录（连带删掉旧目录），现在同样进弹窗、由用户决定。
  it('reports a conflict for a same-named PDF and keeps both records', async () => {
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

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.reason).toBe('same-identifier');
    expect(conflicts[0]!.candidates).toEqual([existing]);
    // 旧记录原封不动：不再被原地替换、目录不再被删。
    expect(books.filter((b) => !b.deletedAt)).toHaveLength(2);
    expect(books[0]!.hash).toBe('old-hash-123');
    expect(fs.removeDir).not.toHaveBeenCalled();
  });

  // 反过来：不同名的两个 PDF 即使元数据是同一段样板文字（"PowerPoint
  // Presentation"），也绝不能互相认作版本——那正是 #5411 要防的误判。宽松的
  // "同名同作者"那一层只对 EPUB 开放。
  it('does not report a conflict for differently-named PDFs sharing boilerplate metadata', async () => {
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
      metaHash: getMetadataHash(pdfMetadata, 'quarterly-report'),
    });
    const books: Book[] = [existing];
    const conflicts: BookVersionConflictInfo[] = [];

    mockPartialMD5.mockResolvedValue('pdf-hash-3');
    mockOpen.mockResolvedValue({
      book: { metadata: pdfMetadata, getCover: vi.fn().mockResolvedValue(null) },
      format: 'PDF',
    });
    await service.importBook(new File(['v3'], 'handout.pdf', { type: 'application/pdf' }), books, {
      onVersionConflict: (info) => conflicts.push(info),
    });

    expect(conflicts).toHaveLength(0);
    expect(books.filter((b) => !b.deletedAt)).toHaveLength(2);
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

  // 判定输入里的"新文件事实"由调用方拼装，用于弹窗的并列展示。
  it('reports the incoming file facts alongside the conflict', async () => {
    const { service, fs } = makeService();
    fs.stats.mockResolvedValue({
      isFile: true,
      isDirectory: false,
      size: 4242,
      mtime: new Date(1_700_000_000_000),
      atime: null,
      birthtime: null,
    });
    fs.openFile.mockResolvedValue(new File(['content'], 'test.epub'));
    const existing = makeBook({ metaHash: 'unrelated' });
    const books: Book[] = [existing];
    const conflicts: BookVersionConflictInfo[] = [];

    mockPartialMD5.mockResolvedValue('new-hash-456');
    setupMockBookDoc({ title: 'Test Book', author: 'Test Author', language: 'en' });
    await service.importBook('/books/test.epub', books, {
      onVersionConflict: (info) => conflicts.push(info),
    });

    // 大小取内存里那份 File（已经在手上，无需再读盘），mtime 现读一次源文件。
    expect(conflicts[0]!.incomingFacts).toEqual({
      sizeBytes: 7,
      mtime: 1_700_000_000_000,
      textLength: undefined,
      sectionCount: undefined,
    });
  });
});

// 决策 #1：同一个文件重复导入不再打扰书库。记录还在时字段一个都不许动，
// 记录被删过则复活——否则删掉的书永远拿不回来。
describe('importBook same-file re-import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('leaves a live record byte for byte alone', async () => {
    const { service, fs } = makeService();
    makeManagedFileExist(fs);
    const existing = makeBook({
      hash: 'old-hash-123',
      progress: [7, 100],
      title: '我自己改的书名',
      updatedAt: 111,
      createdAt: 222,
    });
    const books: Book[] = [existing];
    const hits: string[] = [];

    mockPartialMD5.mockResolvedValue('old-hash-123');
    setupMockBookDoc();
    const result = await service.importBook(
      new File(['same bytes'], 'test.epub', { type: 'application/epub+zip' }),
      books,
      { onDedupHit: (kind) => hits.push(kind) },
    );

    expect(result).toBe(existing);
    expect(hits).toEqual(['already-in-library']);
    expect(existing.updatedAt).toBe(111);
    expect(existing.createdAt).toBe(222);
    expect(existing.title).toBe('我自己改的书名');
    expect(existing.progress).toEqual([7, 100]);
    // 不复制文件、不建目录、不重写 config、不刷新封面。
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.copyFile).not.toHaveBeenCalled();
    expect(fs.createDir).not.toHaveBeenCalled();
  });

  it('revives a tombstoned record', async () => {
    const { service, fs } = makeService();
    const existing = makeBook({ hash: 'old-hash-123', deletedAt: 999, updatedAt: 111 });
    const books: Book[] = [existing];
    const hits: string[] = [];

    mockPartialMD5.mockResolvedValue('old-hash-123');
    setupMockBookDoc();
    const before = Date.now();
    const result = await service.importBook(
      new File(['same bytes'], 'test.epub', { type: 'application/epub+zip' }),
      books,
      { onDedupHit: (kind) => hits.push(kind) },
    );

    expect(hits).toEqual(['revived']);
    expect(result!.deletedAt).toBeNull();
    expect(result!.updatedAt).toBeGreaterThanOrEqual(before);
    // 复活的那份必须回到调用方的数组里，否则同批后续文件看到的还是墓碑。
    expect(books[0]!.deletedAt).toBeNull();
    expect(books[0]).toBe(result);
    // 用户数据保留，且没有为此重写任何文件。
    expect(result!.title).toBe('Test Book');
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  // TXT 的墓碑**不进** sourceHash 短路面（findTxtDedupMatch 只认存活记录），
  // 但重导仍会复活它：转换产物的 dc:identifier 取自原始 TXT 的 partialMD5、
  // zip 时间戳被钉成 0，所以转换是字节稳定的、hash 不变，后面按 hash 命中的
  // 分支把它复活并如实上报 revived。这条锁住"TXT 删了也能拖回来"。
  it('revives a tombstoned TXT record through the hash path', async () => {
    const { service, fs } = makeService();
    const tombstone = makeBook({
      hash: 'txt-hash',
      sourceHash: 'src-hash',
      deletedAt: 999,
      updatedAt: 111,
    });
    const books: Book[] = [tombstone];
    const hits: string[] = [];

    // 第一次：原始 TXT 的 partialMD5；第二次：转换产物的 hash（稳定 → 命中墓碑）。
    mockPartialMD5.mockResolvedValueOnce('src-hash').mockResolvedValue('txt-hash');
    setupMockBookDoc();
    const before = Date.now();
    const result = await service.importBook(new File(['txt body'], 'sample.txt'), books, {
      onDedupHit: (kind) => hits.push(kind),
    });

    expect(hits).toEqual(['revived']);
    expect(result!.hash).toBe('txt-hash');
    expect(result!.deletedAt).toBeNull();
    expect(result!.updatedAt).toBeGreaterThanOrEqual(before);
    expect(books[0]!.deletedAt).toBeNull();
    expect(fs.removeDir).not.toHaveBeenCalled();
  });

  // 活记录但书文件不见了（用户手工清理过 Books/）：不能短路，得让完整路径
  // 把它重新落盘。
  it('falls through to a full import when the stored file is gone', async () => {
    const { service, fs } = makeService();
    const existing = makeBook({ hash: 'old-hash-123', updatedAt: 111 });
    const books: Book[] = [existing];
    const hits: string[] = [];

    mockPartialMD5.mockResolvedValue('old-hash-123');
    setupMockBookDoc();
    const result = await service.importBook(
      new File(['same bytes'], 'test.epub', { type: 'application/epub+zip' }),
      books,
      { onDedupHit: (kind) => hits.push(kind) },
    );

    expect(hits).toEqual([]);
    expect(result!.hash).toBe('old-hash-123');
    expect(fs.createDir).toHaveBeenCalledWith('old-hash-123', 'Books', true);
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

describe('discardImportedBook', () => {
  function makeFakeAppService() {
    const saved: Book[][] = [];
    const appService = {
      deleteBook: vi.fn(async () => {}),
      saveLibraryBooks: vi.fn(async (books: Book[]) => {
        saved.push(books);
        return books;
      }),
    } as unknown as AppService;
    return { appService, saved };
  }

  it('tombstones the imported row, purges its directory and persists a replace write', async () => {
    const { appService, saved } = makeFakeAppService();
    const kept = makeBook({ hash: 'kept-hash', progress: [40, 200] });
    const imported = makeBook({ hash: 'new-hash-456', filePath: '/library/new.epub' });

    const result = await discardImportedBook(appService, {
      book: imported,
      books: [kept, imported],
    });

    // purge 只清 Readest 自己管的 Books/<hash>/；in-place 的源文件不在其中，
    // 用户的原始文件不会被这次"撤销"碰掉。
    expect(appService.deleteBook).toHaveBeenCalledWith(imported, 'purge');
    const tombstone = result.library.find((book) => book.hash === 'new-hash-456')!;
    expect(tombstone.deletedAt).toBeGreaterThan(0);
    expect(tombstone.downloadedAt).toBeNull();
    // 墓碑保留 filePath：重扫的"已知路径"集合靠它认得这个文件，否则同一个文件
    // 会被反复当作新文件扫出来、反复弹窗。
    expect(tombstone.filePath).toBe('/library/new.epub');
    expect(result.library.find((book) => book.hash === 'kept-hash')).toBe(kept);
    // 必须 replace 写，否则默认的 read-merge-write 会把这条记录从磁盘带回来。
    expect(result.applied).toBe(true);
    expect(appService.saveLibraryBooks).toHaveBeenCalledWith(result.library, { replace: true });
    expect(saved[0]!.filter((book) => !book.deletedAt).map((book) => book.hash)).toEqual([
      'kept-hash',
    ]);
  });

  it('still tombstones the row when the directory cleanup fails', async () => {
    const { appService } = makeFakeAppService();
    (appService.deleteBook as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('EBUSY'));
    const imported = makeBook({ hash: 'new-hash-456' });

    const result = await discardImportedBook(appService, { book: imported, books: [imported] });

    expect(result.library[0]!.deletedAt).toBeGreaterThan(0);
    expect(appService.saveLibraryBooks).toHaveBeenCalled();
  });
});

describe('planVersionConflictResolution', () => {
  const conflict = (oldHash: string, newHash: string): BookVersionConflictInfo => ({
    incoming: makeBook({ hash: newHash }),
    candidates: [makeBook({ hash: oldHash })],
    reason: 'same-identifier',
  });

  it('splits the choices into replacements and discards', () => {
    const conflicts = [conflict('o1', 'n1'), conflict('o2', 'n2'), conflict('o3', 'n3')];
    const plan = planVersionConflictResolution(conflicts, ['replace', 'keep', 'discard']);

    expect(plan.replacements.map((c) => c.incoming.hash)).toEqual(['n1']);
    expect(plan.discards.map((c) => c.incoming.hash)).toEqual(['n3']);
    expect(plan.skipped).toEqual([]);
  });

  // 同一本旧书只能被折一次：后面的即使选了"替换"也不能执行，否则会把旧数据
  // 重复搬到第二个新记录上（旧行那时已经不在库里）。
  it('lets only the first conflict claim a given old book', () => {
    const conflicts = [conflict('o1', 'n1'), conflict('o1', 'n2')];
    const plan = planVersionConflictResolution(conflicts, ['replace', 'replace']);

    expect(plan.replacements.map((c) => c.incoming.hash)).toEqual(['n1']);
    expect(plan.skipped.map((c) => c.incoming.hash)).toEqual(['n2']);
  });

  // 撤销不需要仲裁：它只动这次导入新建的那一本，两条冲突不可能共享同一个
  // incoming 记录。
  it('does not arbitrate discards', () => {
    const conflicts = [conflict('o1', 'n1'), conflict('o1', 'n2')];
    const plan = planVersionConflictResolution(conflicts, ['discard', 'discard']);

    expect(plan.discards.map((c) => c.incoming.hash)).toEqual(['n1', 'n2']);
    expect(plan.skipped).toEqual([]);
  });

  it('skips a replace with nothing to replace', () => {
    const plan = planVersionConflictResolution(
      [{ ...conflict('o1', 'n1'), candidates: [] }],
      ['replace'],
    );

    expect(plan.replacements).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
  });
});

describe('findBatchVersionConflicts', () => {
  it('pairs two releases imported in the same batch', () => {
    const earlier = makeBook({ hash: 'v-old', author: 'Test Author' });
    const later = makeBook({ hash: 'v-new', author: 'Test Author' });
    const library = [makeBook({ hash: 'x-pre-existing' }), earlier, later];

    const conflicts = findBatchVersionConflicts({
      importedHashes: ['v-old', 'v-new'],
      library,
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.incoming.hash).toBe('v-new');
    expect(conflicts[0]!.candidates.map((b) => b.hash)).toEqual(['v-old']);
  });

  // 每对只报一次，且只报"本次新建"之间的配对——导入时刻已经报过的冲突
  // （新记录 vs 库里本来就有那条）不会在这里重复出现。
  it('never pairs a new record with a pre-existing library record', () => {
    const preExisting = makeBook({ hash: 'x-pre-existing' });
    const fresh = makeBook({ hash: 'v-new' });

    const conflicts = findBatchVersionConflicts({
      importedHashes: ['v-new'],
      library: [preExisting, fresh],
    });

    expect(conflicts).toEqual([]);
  });

  it('ignores tombstoned records', () => {
    const earlier = makeBook({ hash: 'v-old', deletedAt: Date.now() });
    const later = makeBook({ hash: 'v-new' });

    const conflicts = findBatchVersionConflicts({
      importedHashes: ['v-old', 'v-new'],
      library: [earlier, later],
    });

    expect(conflicts).toEqual([]);
  });

  // 同名同作者的两本书批内互判同样成立：换源重下时两条记录的书号本来就不一样。
  it('pairs by title and author when the identifiers differ', () => {
    const earlier = makeBook({ hash: 'v-old', metaHash: getMetadataHash(TEST_METADATA) });
    const later = makeBook({
      hash: 'v-new',
      metaHash: getMetadataHash({ ...TEST_METADATA, identifier: 'other-uuid' }),
      // 记录上留着 metadata，"这条记录有没有真书号"才判得出来。
      metadata: { ...TEST_METADATA, identifier: 'other-uuid' } as BookMetadata,
    });

    const conflicts = findBatchVersionConflicts({
      importedHashes: ['v-old', 'v-new'],
      library: [earlier, later],
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.reason).toBe('identifier-differs');
  });
});

describe('findIncomingVersionConflict', () => {
  it('returns null when nothing in the library matches', () => {
    const books = [makeBook({ hash: 'other', title: '另一本书', author: '别人' })];

    expect(
      findIncomingVersionConflict({
        books,
        incoming: {
          hash: 'new',
          format: 'EPUB',
          metaHash: undefined,
          metaHashIsIdentity: false,
          title: 'Test Book',
          author: 'Test Author',
          allowLooseMatch: true,
        },
      }),
    ).toBeNull();
  });
});

describe('mergeBatchVersionConflicts', () => {
  const conflict = (incomingHash: string, candidateHashes: string[]): BookVersionConflictInfo => ({
    incoming: makeBook({ hash: incomingHash }),
    candidates: candidateHashes.map((hash) => makeBook({ hash })),
    reason: 'same-identifier',
  });

  it('keeps the queue untouched when the batch probe found nothing', () => {
    const queued = [conflict('n1', ['o1'])];
    expect(mergeBatchVersionConflicts(queued, [])).toBe(queued);
  });

  // 同一对会被报两次：先完成的那个文件一旦入库，后完成的那个在导入时刻就看得见
  // 它（同批共用同一个 books 数组与索引）。按 incoming 去重，同一本新书只问一次。
  it('collapses two reports about the same incoming record', () => {
    const fromImport = conflict('n2', ['o1', 'n1']);
    const fromBatch = conflict('n2', ['n1']);

    const merged = mergeBatchVersionConflicts([fromImport], [fromBatch]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.candidates.map((b) => b.hash)).toEqual(['o1', 'n1']);
    // 判定依据取先报的那条：它来自导入时刻，两侧身份都是当时算出来的。
    expect(merged[0]!.reason).toBe(fromImport.reason);
  });

  // 候选取**并集**，不做"谁多留谁"：批后探测看到的批内版本与导入时刻看到的
  // 库内版本都对用户有用，取其一会让另一侧的候选凭空消失（"另有 N 本同书号
  // 记录"随执行顺序时多时少）。
  it('unions the candidates from both reports instead of dropping one side', () => {
    const fromImport = conflict('n3', ['o1']);
    const fromBatch = conflict('n3', ['n1', 'n2']);

    const merged = mergeBatchVersionConflicts([fromImport], [fromBatch]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.candidates.map((b) => b.hash).sort()).toEqual(['n1', 'n2', 'o1']);
  });

  // 并集后仍按阅读进度降序：[0] 是替换目标，读得最远的那本排最前。
  it('re-sorts the union by reading progress', () => {
    const fromImport: BookVersionConflictInfo = {
      incoming: makeBook({ hash: 'n3' }),
      candidates: [makeBook({ hash: 'o1', progress: [1, 300] })],
      reason: 'same-identifier',
    };
    const fromBatch: BookVersionConflictInfo = {
      incoming: makeBook({ hash: 'n3' }),
      candidates: [makeBook({ hash: 'n1', progress: [250, 300] })],
      reason: 'same-identifier',
    };

    const merged = mergeBatchVersionConflicts([fromImport], [fromBatch]);

    expect(merged[0]!.candidates.map((b) => b.hash)).toEqual(['n1', 'o1']);
  });

  it('appends batch-only conflicts for other incoming records', () => {
    const merged = mergeBatchVersionConflicts([conflict('n1', ['o1'])], [conflict('n2', ['n1'])]);

    expect(merged.map((c) => c.incoming.hash)).toEqual(['n1', 'n2']);
  });
});

describe('discardImportedBook when the record is already gone', () => {
  // 同批里另一次「用新版替换」可能把这条记录当替换目标折进了新版（替换先执行，
  // 旧行与旧目录都已处理）。此时再追加墓碑只会在 library.json 留一行永远隐藏、
  // 却会进同步与后续比较的孤儿。
  it('leaves the library untouched and writes nothing', async () => {
    const saved: Book[][] = [];
    const appService = {
      deleteBook: vi.fn(async () => {}),
      saveLibraryBooks: vi.fn(async (books: Book[]) => {
        saved.push(books);
        return books;
      }),
    } as unknown as AppService;
    const survivor = makeBook({ hash: 'kept-hash' });
    const gone = makeBook({ hash: 'folded-hash' });
    const books = [survivor];

    const result = await discardImportedBook(appService, { book: gone, books });

    expect(result.library).toBe(books);
    // 如实报告"这次没动手"，否则调用方会提示"已撤销 N 本"——一件没发生的事。
    expect(result.applied).toBe(false);
    expect(appService.saveLibraryBooks).not.toHaveBeenCalled();
    expect(appService.deleteBook).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });
});
