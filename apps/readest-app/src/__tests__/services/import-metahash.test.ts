import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Book } from '@/types/book';
import type { BookFormat, BookVersionConflictInfo } from '@/types/book';
import { getMetadataHash } from '@/utils/book';

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

const mockSimplifyChineseText = vi.hoisted(() => vi.fn(async (text: string) => text));

vi.mock('@/utils/simplecc', () => ({
  initSimpleCC: vi.fn(),
  runSimpleCC: vi.fn(),
  simplifyChineseText: mockSimplifyChineseText,
}));
import { BaseAppService } from '@/services/appService';
import {
  buildBookLookupIndex,
  normalizeFilePathForIndex,
  refreshBookMetadata,
} from '@/services/bookService';

// Concrete test subclass of BaseAppService with mocked fs
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
    format: 'EPUB' as Book['format'],
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

describe('importBook metaHash deduplication', () => {
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
  });

  // 命中同一身份（同书号、不同文件）不再原地接管旧记录：新文件落成自己的
  // 记录，旧记录连字段都不动，是否合并改由用户在弹窗里决定。
  it('lands a same-identity import as its own record instead of taking over', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);

    const existingBook = makeBook({ hash: 'old-hash-123', metaHash, updatedAt: 111 });
    const books: Book[] = [existingBook];

    mockPartialMD5.mockResolvedValue('new-hash-456');
    setupMockBookDoc();

    const mockFile = new File(['new content'], 'test.epub', { type: 'application/epub+zip' });
    const result = await service.importBook(mockFile, books);

    expect(books.length).toBe(2);
    expect(result!.hash).toBe('new-hash-456');
    expect(result!.metadata).toEqual(TEST_METADATA);
    expect(result!.metaHash).toBe(metaHash);
    // 旧记录一个字段都没变。
    expect(existingBook.hash).toBe('old-hash-123');
    expect(existingBook.updatedAt).toBe(111);
  });

  // 记录上传状态的语义随之改变：新记录是全新的一行（uploadedAt 为空，会自己
  // 上传一次），旧记录保持它原有的上传状态——它没有被删，也没有被换掉。
  it('leaves the existing record’s upload state alone on a same-identity import', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);
    const uploadedAt = Date.now() - 5000;
    const existingBook = makeBook({ hash: 'old-hash-123', metaHash, uploadedAt });
    const books: Book[] = [existingBook];

    mockPartialMD5.mockResolvedValue('new-hash-456');
    setupMockBookDoc();

    const mockFile = new File(['new content'], 'test.epub', { type: 'application/epub+zip' });
    const result = await service.importBook(mockFile, books);

    expect(books.length).toBe(2);
    expect(result!.hash).toBe('new-hash-456');
    expect(result!.uploadedAt).toBeNull();
    expect(existingBook.uploadedAt).toBe(uploadedAt);
    expect(existingBook.hash).toBe('old-hash-123');
  });

  it('should not match metaHash for deleted books', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);

    const deletedBook = makeBook({
      hash: 'old-hash-123',
      metaHash,
      deletedAt: Date.now(),
    });
    const books: Book[] = [deletedBook];

    mockPartialMD5.mockResolvedValue('new-hash-456');
    setupMockBookDoc();

    const mockFile = new File(['new content'], 'test.epub', { type: 'application/epub+zip' });
    const result = await service.importBook(mockFile, books);

    // Should create a new book since the existing one is deleted
    expect(result).not.toBe(deletedBook);
    expect(books.length).toBe(2);
  });

  // 旧记录连同它的 Books/<hash>/（书文件、阅读位置、书签、封面、nav 缓存）一律
  // 不动：这条路径曾经会搬走旧 config 再删掉整个旧目录，用户没被问过就丢了书。
  it('no longer migrates the old config nor deletes the old directory', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);
    const existingBook = makeBook({ hash: 'old-hash-123', metaHash, progress: [40, 200] });
    const books: Book[] = [existingBook];

    mockPartialMD5.mockResolvedValue('new-hash-456');
    setupMockBookDoc();

    const fs = service.getFs();
    fs.exists.mockImplementation(async (path: string) => {
      if (path === 'old-hash-123/config.json') return true;
      if (path === 'old-hash-123') return true;
      return false;
    });
    fs.readFile.mockResolvedValue('{"readProgress":0.5}');

    const mockFile = new File(['new content'], 'test.epub', { type: 'application/epub+zip' });
    await service.importBook(mockFile, books);

    expect(fs.readFile).not.toHaveBeenCalledWith('old-hash-123/config.json', 'Books', 'text');
    expect(fs.removeDir).not.toHaveBeenCalled();
    // 新记录拿到的是自己的初始 config，而不是旧记录那份阅读位置。
    const configWrite = fs.writeFile.mock.calls.find(
      (c: unknown[]) => c[0] === 'new-hash-456/config.json',
    );
    expect(configWrite).toBeDefined();
    expect(JSON.parse(configWrite![2] as string).readProgress).toBeUndefined();
    expect(existingBook.progress).toEqual([40, 200]);
  });

  it('should prefer exact file hash match over metaHash match', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);

    const exactMatchBook = makeBook({ hash: 'same-hash', metaHash });
    const metaMatchBook = makeBook({ hash: 'different-hash', metaHash });
    const books: Book[] = [exactMatchBook, metaMatchBook];

    mockPartialMD5.mockResolvedValue('same-hash');
    setupMockBookDoc();

    const mockFile = new File(['content'], 'test.epub', { type: 'application/epub+zip' });
    const result = await service.importBook(mockFile, books);

    // B-6：返回已存在书的不可变副本（新引用），原对象不被就地改。
    expect(result).not.toBe(exactMatchBook);
    expect(result?.hash).toBe('same-hash');
    expect(result?.deletedAt).toBeNull();
    expect(exactMatchBook.deletedAt).toBeNull();
    // 但同键的另一条**不再**被折叠：同一个身份对应两条存活记录时，身份已经
    // 无法定位唯一一本书，折叠只能靠"谁排在前面"。两道闸门见 bookService 的
    // mayFold 注释；用户会在下一次手动导入时被问到要不要合并。
    expect(metaMatchBook.deletedAt).toBeNull();
  });

  it('should not check metaHash for transient imports', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);
    const existingBook = makeBook({ hash: 'old-hash', metaHash });
    const books: Book[] = [existingBook];

    mockPartialMD5.mockResolvedValue('new-hash');
    setupMockBookDoc();

    const fs = service.getFs();
    fs.openFile.mockResolvedValue(new File(['content'], 'test.epub'));

    // Transient import requires string file path
    const result = await service.importBook('/path/to/test.epub', books, { transient: true });

    // Should create a new entry, not override existing
    expect(result).not.toBe(existingBook);
  });

  it('should promote extracted ISBN into metadata.isbn during import', async () => {
    const books: Book[] = [];

    mockPartialMD5.mockResolvedValue('new-hash-456');
    setupMockBookDoc({
      ...TEST_METADATA,
      identifier: 'calibre:abc123',
      altIdentifier: ['urn:isbn:9780316033664', 'mobi-asin:B004J4XGN6'],
    });

    const mockFile = new File(['new content'], 'test.epub', { type: 'application/epub+zip' });
    const result = await service.importBook(mockFile, books);
    expect(result).not.toBeNull();
    if (!result) {
      throw new Error('Expected importBook to return an imported book');
    }

    expect(result.metadata?.isbn).toBe('9780316033664');
  });

  it('simplifies traditional Chinese title and author on import', async () => {
    const originalMetadata = {
      title: '紅樓夢',
      author: '葉嘉瑩',
      language: 'zh-TW',
      identifier: 'isbn-123',
    };
    const metaHash = getMetadataHash(originalMetadata);

    mockPartialMD5.mockResolvedValue('new-hash-456');
    setupMockBookDoc(originalMetadata);
    mockSimplifyChineseText.mockImplementation(async (text: string) => {
      if (text === '紅樓夢') return '红楼梦';
      if (text === '葉嘉瑩') return '叶嘉莹';
      return text;
    });

    const mockFile = new File(['new content'], 'test.epub', { type: 'application/epub+zip' });
    const result = await service.importBook(mockFile, []);

    expect(result?.title).toBe('红楼梦');
    expect(result?.sourceTitle).toBe('红楼梦');
    expect(result?.author).toBe('叶嘉莹');
    expect(result?.metadata?.title).toBe('红楼梦');
    expect(result?.metadata?.author).toBe('叶嘉莹');
    expect(result?.metaHash).toBe(metaHash);
  });
});

describe('importBook metaHash aggregation', () => {
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
  });

  // 同一个身份对应多条存活记录时不再折叠（§5 的唯一性护栏）：身份已经无法
  // 定位唯一一本书，谁被并进谁只能靠数组顺序。代价是历史重复不会再被自动清理，
  // 改为在下一次手动导入时询问用户。
  it('does not fold records that share one identity', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);

    const book1 = makeBook({ hash: 'hash-1', metaHash });
    const book2 = makeBook({ hash: 'hash-2', metaHash });
    const book3 = makeBook({ hash: 'hash-3', metaHash });
    const unrelated = makeBook({ hash: 'other', metaHash: 'different' });
    const books: Book[] = [book1, book2, book3, unrelated];

    mockPartialMD5.mockResolvedValue('new-hash');
    setupMockBookDoc();

    const mockFile = new File(['content'], 'test.epub', { type: 'application/epub+zip' });
    await service.importBook(mockFile, books);

    // 三条同键记录全部存活，加上新导入的这本共 5 条，谁都没被并进谁。
    expect(books.filter((b) => !b.deletedAt)).toHaveLength(5);
    expect(book1.deletedAt).toBeNull();
    expect(book2.deletedAt).toBeNull();
    expect(book3.deletedAt).toBeNull();
    expect(unrelated.deletedAt).toBeNull();
  });

  it('should not aggregate books with different formats', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);

    const epubBook = makeBook({ hash: 'epub-hash', metaHash });
    const pdfBook = makeBook({
      hash: 'pdf-hash',
      metaHash,
      format: 'PDF' as Book['format'],
    });
    const books: Book[] = [epubBook, pdfBook];

    mockPartialMD5.mockResolvedValue('new-hash');
    setupMockBookDoc(); // Opens as EPUB

    const mockFile = new File(['content'], 'test.epub', { type: 'application/epub+zip' });
    await service.importBook(mockFile, books);

    // PDF book should not be soft-deleted (different format)
    expect(pdfBook.deletedAt).toBeNull();
    // EPUB book should survive (promoted as existing, not a duplicate of itself)
    expect(epubBook.deletedAt).toBeNull();
  });

  it('does not clean up directories of same-identity records', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);

    const book1 = makeBook({ hash: 'hash-1', metaHash });
    const book2 = makeBook({ hash: 'hash-2', metaHash });
    const book3 = makeBook({ hash: 'hash-3', metaHash });
    const books: Book[] = [book1, book2, book3];

    mockPartialMD5.mockResolvedValue('new-hash');
    setupMockBookDoc();

    const fs = service.getFs();
    fs.exists.mockImplementation(async (path: string) => {
      return ['hash-2', 'hash-3'].includes(path);
    });

    const mockFile = new File(['content'], 'test.epub', { type: 'application/epub+zip' });
    await service.importBook(mockFile, books);

    expect(books.filter((b) => !b.deletedAt)).toHaveLength(4);
    expect(fs.removeDir).not.toHaveBeenCalled();
  });

  it('does not remove same-identity duplicates on an exact hash match either', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);

    const exactMatch = makeBook({ hash: 'exact-hash', metaHash });
    const dup1 = makeBook({ hash: 'dup-1', metaHash });
    const dup2 = makeBook({ hash: 'dup-2', metaHash });
    const books: Book[] = [exactMatch, dup1, dup2];

    mockPartialMD5.mockResolvedValue('exact-hash');
    setupMockBookDoc();

    const fs = service.getFs();
    fs.exists.mockImplementation(async (path: string) => {
      return ['dup-1', 'dup-2'].includes(path);
    });

    const mockFile = new File(['content'], 'test.epub', { type: 'application/epub+zip' });
    const result = await service.importBook(mockFile, books);

    expect(result?.hash).toBe('exact-hash');
    expect(result?.deletedAt).toBeNull();
    expect(books.filter((b) => !b.deletedAt)).toHaveLength(3);
    expect(fs.removeDir).not.toHaveBeenCalled();
  });

  it('does not merge configs across same-identity records at import time', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);

    const exactMatch = makeBook({ hash: 'exact-hash', metaHash });
    const dup = makeBook({ hash: 'dup-hash', metaHash });
    const books: Book[] = [exactMatch, dup];

    mockPartialMD5.mockResolvedValue('exact-hash');
    setupMockBookDoc();

    const fs = service.getFs();
    fs.exists.mockImplementation(async (path: string) => {
      if (path.endsWith('/config.json')) return true;
      if (path === 'dup-hash') return true;
      return false;
    });
    fs.readFile.mockImplementation(async (path: string) => {
      if (path === 'exact-hash/config.json')
        return JSON.stringify({
          updatedAt: 1000,
          progress: [10, 100],
          booknotes: [
            { id: 'n1', type: 'annotation', cfi: 'c1', note: 'x', createdAt: 1, updatedAt: 1 },
          ],
        });
      if (path === 'dup-hash/config.json')
        return JSON.stringify({
          updatedAt: 5000,
          progress: [70, 100],
          location: 'newer',
          booknotes: [
            { id: 'n2', type: 'bookmark', cfi: 'c2', note: 'y', createdAt: 2, updatedAt: 2 },
          ],
        });
      return '{}';
    });

    const mockFile = new File(['content'], 'test.epub', { type: 'application/epub+zip' });
    await service.importBook(mockFile, books);

    // 折叠被唯一性护栏挡下：两条记录的 config 都保持原样，谁也没被并进谁。
    const written = fs.writeFile.mock.calls
      .map((c: unknown[]) => c[0] as string)
      .filter((path: string) => path.endsWith('/config.json'));
    expect(written).not.toContain('dup-hash/config.json');
    expect(books.filter((b) => !b.deletedAt)).toHaveLength(2);
  });
});

// PDF metadata is often generic (e.g. every PowerPoint export is titled
// "PowerPoint Presentation" with the same author), so metaHash alone wrongly
// collapses distinct PDFs into one book (issue #5411). PDF metaHash is salted
// with the original filename so only same-named files dedupe.
describe('importBook PDF filename-aware dedup', () => {
  let service: TestAppService;

  const PDF_METADATA = {
    title: 'PowerPoint Presentation',
    author: 'Alice Author',
    language: 'en',
  };

  function setupMockPdfDoc() {
    const bookDoc = {
      metadata: { ...PDF_METADATA },
      getCover: vi.fn().mockResolvedValue(null),
    };
    mockOpen.mockResolvedValue({ book: bookDoc, format: 'PDF' });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TestAppService();
    const fs = service.getFs();
    fs.exists.mockResolvedValue(false);
    fs.createDir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
    fs.removeDir.mockResolvedValue(undefined);
    fs.readFile.mockResolvedValue('{}');
  });

  it('imports PDFs with identical metadata but different filenames as separate books', async () => {
    const books: Book[] = [];

    mockPartialMD5.mockResolvedValue('pdf-hash-1');
    setupMockPdfDoc();
    const book1 = await service.importBook(
      new File(['slides 1'], 'lecture-01.pdf', { type: 'application/pdf' }),
      books,
    );

    mockPartialMD5.mockResolvedValue('pdf-hash-2');
    setupMockPdfDoc();
    const book2 = await service.importBook(
      new File(['slides 2'], 'lecture-02.pdf', { type: 'application/pdf' }),
      books,
    );

    expect(book2).not.toBe(book1);
    expect(books.filter((b) => !b.deletedAt)).toHaveLength(2);
  });

  // 同名 PDF 以前会被静默原地替换——旧记录连带它的整个 Books/<hash>/ 目录一起
  // 消失。现在它和其他格式一样落成两条记录，是否替换交给用户在弹窗里决定。
  it('keeps a same-named PDF re-import as a separate record and asks', async () => {
    const books: Book[] = [];

    mockPartialMD5.mockResolvedValue('pdf-hash-1');
    setupMockPdfDoc();
    const book1 = await service.importBook(
      new File(['v1'], 'deck.pdf', { type: 'application/pdf' }),
      books,
    );

    mockPartialMD5.mockResolvedValue('pdf-hash-2');
    setupMockPdfDoc();
    const conflicts: BookVersionConflictInfo[] = [];
    const book2 = await service.importBook(
      new File(['v2'], 'deck.pdf', { type: 'application/pdf' }),
      books,
      { onVersionConflict: (info) => conflicts.push(info) },
    );

    expect(book2).not.toBe(book1);
    expect(book1!.hash).toBe('pdf-hash-1');
    expect(books.filter((b) => !b.deletedAt)).toHaveLength(2);
    // 文件名字盐一致 → 判据是"书号相同"，两侧书号并列给用户看。
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.reason).toBe('same-identifier');
    expect(conflicts[0]!.candidates[0]).toBe(book1);
  });

  it('refreshBookMetadata preserves the salted metaHash for PDFs', async () => {
    // The original filename is lost after import (files are stored under the
    // metadata title), so re-parsing the file cannot reproduce the salt and
    // must keep the metaHash stamped at import time.
    const book = makeBook({
      hash: 'pdf-hash-1',
      format: 'PDF' as Book['format'],
      metaHash: 'salted-import-hash',
    });

    const fs = service.getFs();
    fs.exists.mockResolvedValue(true);
    fs.openFile.mockResolvedValue(new File(['pdf'], 'Test Book.pdf'));
    setupMockPdfDoc();

    const refreshed = await refreshBookMetadata(
      fs as unknown as Parameters<typeof refreshBookMetadata>[0],
      book,
    );

    expect(refreshed).toBe(true);
    expect(book.metaHash).toBe('salted-import-hash');
  });
});

describe('importBook with BookLookupIndex', () => {
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
  });

  it('updates the lookup index after a successful new-book import', async () => {
    const books: Book[] = [];
    const lookupIndex = buildBookLookupIndex(books);

    mockPartialMD5.mockResolvedValue('imported-hash');
    setupMockBookDoc();

    const mockFile = new File(['content'], 'test.epub', { type: 'application/epub+zip' });
    const result = await service.importBook(mockFile, books, { lookupIndex });

    expect(result).not.toBeNull();
    expect(result?.hash).toBe('imported-hash');
    // The lookup index must contain the freshly imported book
    expect(lookupIndex.byHash.get('imported-hash')).toBe(result);
    if (result?.metaHash) {
      const key = `${result.metaHash}:${result.format}`;
      expect(lookupIndex.byMetaKey.get(key)).toContain(result);
    }
  });

  it('finds existing book via lookup index without scanning books array', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);
    const existingBook = makeBook({ hash: 'existing', metaHash });
    // Pass an EMPTY books array but a lookup index that already contains the book.
    // If the implementation falls back to books.find(), it will fail to find the
    // existing book and create a new one. If it consults the lookup index, it
    // will discover the existing book and update it.
    const books: Book[] = [];
    const lookupIndex = buildBookLookupIndex([existingBook]);

    mockPartialMD5.mockResolvedValue('existing'); // same hash as existing
    setupMockBookDoc();

    const mockFile = new File(['content'], 'test.epub', { type: 'application/epub+zip' });
    const result = await service.importBook(mockFile, books, { lookupIndex });

    // 复用已存在书（经 lookup index 发现，未新建 push 到空数组）
    expect(result?.hash).toBe('existing');
    expect(books).toHaveLength(0);
  });

  it('buildBookLookupIndex skips deleted and url-backed books in byFilePath', async () => {
    const inPlaceBook = makeBook({
      hash: 'a',
      filePath: '/lib/a.epub',
    });
    const deletedBook = makeBook({
      hash: 'b',
      filePath: '/lib/b.epub',
      deletedAt: Date.now(),
    });
    const urlBook = makeBook({ hash: 'c', filePath: 'https://example.com/c.epub' });

    const lookupIndex = buildBookLookupIndex([inPlaceBook, deletedBook, urlBook], 'linux');

    expect(lookupIndex.byFilePath.get('/lib/a.epub')).toBe(inPlaceBook);
    expect(lookupIndex.byFilePath.has('/lib/b.epub')).toBe(false);
    expect(lookupIndex.byFilePath.has('https://example.com/c.epub')).toBe(false);
  });

  it('restores Pixiv title and author when EPUB metadata falls back to filename', async () => {
    mockPartialMD5.mockResolvedValue('pixiv-hash');
    const fs = service.getFs();
    fs.openFile.mockResolvedValue(
      new File(['epub'], '23456789-小说标题.epub', { type: 'application/epub+zip' }),
    );
    setupMockBookDoc({
      title: '23456789-小说标题.epub',
      author: '',
      language: 'ja',
      identifier: '',
    });

    const result = await service.importBook('pixiv/作者A-12345678/23456789-小说标题.epub', [], {
      transient: true,
    });

    expect(result?.title).toBe('小说标题');
    expect(result?.author).toBe('作者A');
  });

  it('restores the Pixiv title when EPUB metadata holds a chapter heading', async () => {
    mockPartialMD5.mockResolvedValue('chapter-hash');
    const fs = service.getFs();
    fs.openFile.mockResolvedValue(
      new File(['epub'], '异世界魔物娘收容-1501076-kof_boss.epub', {
        type: 'application/epub+zip',
      }),
    );
    setupMockBookDoc({
      title: '第1章',
      author: '',
      language: 'ja',
      identifier: '',
    });

    const result = await service.importBook('异世界魔物娘收容-1501076-kof_boss.epub', [], {
      transient: true,
    });

    expect(result?.title).toBe('异世界魔物娘收容');
    expect(result?.author).toBe('kof_boss');
  });

  it('refreshes a stale title when the same Pixiv file is re-imported', async () => {
    mockPartialMD5.mockResolvedValue('reimport-hash');
    const fs = service.getFs();
    fs.openFile.mockResolvedValue(
      new File(['epub'], '异世界魔物娘收容-1501076-kof_boss.epub', {
        type: 'application/epub+zip',
      }),
    );
    setupMockBookDoc({
      title: '第1章',
      author: '',
      language: 'ja',
      identifier: '',
    });

    // 书库中已存在同 hash 的旧条目，标题是修复前留下的“第1章”。
    const existing = {
      hash: 'reimport-hash',
      format: 'EPUB' as BookFormat,
      metaHash: 'stale-meta-hash',
      title: '第1章',
      sourceTitle: '第1章',
      author: '',
      primaryLanguage: 'ja',
      createdAt: 1,
      updatedAt: 1,
      downloadedAt: 1,
    };
    const result = await service.importBook('异世界魔物娘收容-1501076-kof_boss.epub', [existing], {
      transient: true,
    });

    expect(result?.title).toBe('异世界魔物娘收容');
    expect(result?.author).toBe('kof_boss');
    // B-6：不可变语义 — 原对象引用不被就地修改；结果对象携带最新标题。
    expect(existing.title).toBe('第1章');
    expect(existing.sourceTitle).toBe('第1章');
  });

  it('generateCoverImageUrl 失败时不提前污染 byFilePath 索引（B-6 复核）', async () => {
    const metaHash = getMetadataHash(TEST_METADATA);
    const original = makeBook({ hash: 'old-hash', metaHash, format: 'PDF' });
    const books: Book[] = [original];
    const lookupIndex = buildBookLookupIndex(books);
    const storePath = 'C:/store/old-hash/test.pdf';
    const pathKey = normalizeFilePathForIndex(storePath);
    lookupIndex.byFilePath.set(pathKey, original);

    mockPartialMD5.mockResolvedValue('new-hash');
    setupMockBookDoc();
    service.generateCoverImageUrl = vi.fn(async () => {
      throw new Error('cover boom');
    });

    await expect(
      service.importBook(storePath, books, { lookupIndex, inPlace: true, transient: false }),
    ).rejects.toThrow('cover boom');

    // 失败路径：数组、byHash 与 byFilePath 均保持原引用，未被提前污染。
    expect(books[0]).toBe(original);
    expect(lookupIndex.byHash.get('old-hash')).toBe(original);
    expect(lookupIndex.byFilePath.get(pathKey)).toBe(original);
  });
});
