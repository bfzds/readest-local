import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Book } from '@/types/book';
import type { SystemSettings } from '@/types/settings';

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
  normalizeFilePathForIndex,
  selectNewImportableFiles,
} from '@/services/bookService';
import { ingestFile } from '@/services/ingestService';

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
  title: 'Copy Mode Book',
  author: 'Author',
  language: 'en',
  identifier: 'isbn-copy-mode',
};

const SOURCE_PATH = '/lib/watched/book.epub';
const OTHER_PATH = '/lib/watched/book-renamed.epub';

/** Copy mode (in-place off) with the same watcher semantics. */
const settingsStub = {
  externalLibraryFolders: [],
  autoImportFolders: [SOURCE_PATH.slice(0, '/lib/watched'.length)],
} as unknown as SystemSettings;

/**
 * A watched folder imported in *copy* mode used to re-parse and re-hash every
 * file on every scan: the source path was never recorded, so the path-based
 * known-file filter could not recognize it. These tests pin the ledger that
 * fixes that, and that it stays opt-in.
 */
describe('copy-mode imports remember their source path', () => {
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
    // Same bytes for every path: a re-scan of a renamed/moved file dedups by hash.
    mockPartialMD5.mockResolvedValue('copy-hash');
    mockOpen.mockResolvedValue({
      book: { metadata: TEST_METADATA, getCover: vi.fn().mockResolvedValue(null) },
      format: 'EPUB',
    });
  });

  it('records the source path when asked to', async () => {
    const library: Book[] = [];
    const remembered = vi.fn();

    await service.importBook(SOURCE_PATH, library, {
      lookupIndex: buildBookLookupIndex(library, 'linux'),
      rememberSourcePath: true,
      onSourcePathRemembered: remembered,
    });

    const book = library.find((b) => !b.deletedAt)!;
    // The copy keeps living in Books/<hash>/, so the source is a ledger entry only.
    expect(book.filePath).toBeUndefined();
    expect(book.altFilePaths).toEqual([SOURCE_PATH]);
    expect(remembered).toHaveBeenCalledTimes(1);
  });

  it('leaves the ledger untouched without the opt-in', async () => {
    const library: Book[] = [];
    const remembered = vi.fn();

    await service.importBook(SOURCE_PATH, library, {
      lookupIndex: buildBookLookupIndex(library, 'linux'),
      onSourcePathRemembered: remembered,
    });

    const book = library.find((b) => !b.deletedAt)!;
    expect(book.filePath).toBeUndefined();
    expect(book.altFilePaths).toBeUndefined();
    expect(remembered).not.toHaveBeenCalled();
  });

  // The catch-up case: books imported before the ledger existed. Their re-scan
  // hits the byHash short-circuit (copy mode never reaches the full path), so
  // the ledger has to be filled in there or those books stay unrecognized
  // forever and every scan re-parses the whole folder.
  it('fills the ledger for an already-imported book on a hash hit', async () => {
    const library: Book[] = [];
    await service.importBook(SOURCE_PATH, library, {
      lookupIndex: buildBookLookupIndex(library, 'linux'),
    });
    const existing = library.find((b) => !b.deletedAt)!;
    expect(existing.altFilePaths).toBeUndefined();
    // The managed copy has to look present, otherwise the short-circuit is
    // skipped and the import falls through to the full (re-copy) path.
    service.getFs().exists.mockResolvedValue(true);

    const remembered = vi.fn();
    const onDedupHit = vi.fn();
    await service.importBook(OTHER_PATH, library, {
      lookupIndex: buildBookLookupIndex(library, 'linux'),
      rememberSourcePath: true,
      onSourcePathRemembered: remembered,
      onDedupHit,
    });

    expect(onDedupHit).toHaveBeenCalledWith('already-in-library');
    expect(existing.altFilePaths).toEqual([OTHER_PATH]);
    expect(remembered).toHaveBeenCalledTimes(1);
    // Still one book, still read from its managed copy.
    expect(library.filter((b) => !b.deletedAt)).toHaveLength(1);
  });

  it('does not grow the ledger on repeated imports of the same path', async () => {
    const library: Book[] = [];
    await service.importBook(SOURCE_PATH, library, {
      lookupIndex: buildBookLookupIndex(library, 'linux'),
      rememberSourcePath: true,
    });
    const book = library.find((b) => !b.deletedAt)!;

    const remembered = vi.fn();
    await service.importBook(SOURCE_PATH, library, {
      lookupIndex: buildBookLookupIndex(library, 'linux'),
      rememberSourcePath: true,
      onSourcePathRemembered: remembered,
    });

    expect(book.altFilePaths).toEqual([SOURCE_PATH]);
    expect(remembered).not.toHaveBeenCalled();
  });

  it('makes a later scan recognize the file by path instead of re-importing it', async () => {
    const library: Book[] = [];
    await service.importBook(SOURCE_PATH, library, {
      lookupIndex: buildBookLookupIndex(library, 'linux'),
      rememberSourcePath: true,
    });

    const known = collectKnownSourcePaths(library, 'linux');
    const fresh = selectNewImportableFiles([{ fullPath: SOURCE_PATH, size: 1024 }], {
      extensions: ['epub'],
      minSizeBytes: 0,
      existingPaths: known,
      osPlatform: 'linux',
    });

    expect(fresh).toEqual([]);
  });

  it('passes the opt-in through ingestFile and reports it back', async () => {
    const library: Book[] = [];

    const result = await ingestFile(
      {
        file: SOURCE_PATH,
        books: library,
        lookupIndex: buildBookLookupIndex(library, 'linux'),
        rememberSourcePath: true,
      },
      { appService: service, settings: settingsStub },
    );

    expect(result?.sourcePathRemembered).toBe(true);
    expect(result?.book.altFilePaths).toEqual([SOURCE_PATH]);
  });

  it('does not report a remembered path when the opt-in is absent', async () => {
    const library: Book[] = [];

    const result = await ingestFile(
      { file: SOURCE_PATH, books: library, lookupIndex: buildBookLookupIndex(library, 'linux') },
      { appService: service, settings: settingsStub },
    );

    expect(result?.sourcePathRemembered).toBeUndefined();
    expect(result?.book.altFilePaths).toBeUndefined();
  });

  it('keeps in-place imports on the existing displaced-path behaviour', async () => {
    const library: Book[] = [];
    await service.importBook(SOURCE_PATH, library, {
      lookupIndex: buildBookLookupIndex(library, 'linux'),
      inPlace: true,
      rememberSourcePath: true,
    });
    const book = library.find((b) => !b.deletedAt)!;

    // In-place books carry the source path on `filePath` itself; nothing is
    // duplicated into the ledger.
    expect(book.filePath).toBe(SOURCE_PATH);
    expect(book.altFilePaths).toBeUndefined();
  });

  // The app's primary desktop platform is Windows: backslash separators and a
  // case-insensitive filesystem. Everything below pins that the ledger stores
  // the raw path but *compares* through the platform-aware normalization.
  it('remembers a Windows backslash path and filters it out of later scans', async () => {
    service.osPlatform = 'windows';
    const winPath = 'C:\\lib\\watched\\book.epub';
    const library: Book[] = [];

    await service.importBook(winPath, library, {
      lookupIndex: buildBookLookupIndex(library, 'windows'),
      rememberSourcePath: true,
    });

    const book = library.find((b) => !b.deletedAt)!;
    // The raw (backslash) form is stored; normalization happens only when
    // paths are compared against each other.
    expect(book.filePath).toBeUndefined();
    expect(book.altFilePaths).toEqual([winPath]);

    const known = collectKnownSourcePaths(library, 'windows');
    expect(known.has('c:/lib/watched/book.epub')).toBe(true);
    const fresh = selectNewImportableFiles([{ fullPath: winPath, size: 1024 }], {
      extensions: ['epub'],
      minSizeBytes: 0,
      existingPaths: known,
      osPlatform: 'windows',
    });
    expect(fresh).toEqual([]);
  });

  it('does not duplicate a ledger entry that differs only by casing on Windows', async () => {
    service.osPlatform = 'windows';
    const winPath = 'C:\\lib\\watched\\book.epub';
    const library: Book[] = [];
    await service.importBook(winPath, library, {
      lookupIndex: buildBookLookupIndex(library, 'windows'),
      rememberSourcePath: true,
    });
    const book = library.find((b) => !b.deletedAt)!;
    // The re-import hits the byHash short-circuit, which requires the managed
    // copy to look present (same mock shape as the hash-hit test above).
    service.getFs().exists.mockResolvedValue(true);

    const remembered = vi.fn();
    await service.importBook('C:\\LIB\\Watched\\BOOK.EPUB', library, {
      lookupIndex: buildBookLookupIndex(library, 'windows'),
      rememberSourcePath: true,
      onSourcePathRemembered: remembered,
    });

    expect(book.altFilePaths).toEqual([winPath]);
    expect(remembered).not.toHaveBeenCalled();
    expect(library.filter((b) => !b.deletedAt)).toHaveLength(1);
  });

  it('keeps casing-only variants as distinct paths on Linux', async () => {
    const upper = '/lib/watched/Book.epub';
    const lower = '/lib/watched/book.epub';
    const library: Book[] = [];
    await service.importBook(upper, library, {
      lookupIndex: buildBookLookupIndex(library, 'linux'),
      rememberSourcePath: true,
    });
    const book = library.find((b) => !b.deletedAt)!;
    service.getFs().exists.mockResolvedValue(true);

    const remembered = vi.fn();
    await service.importBook(lower, library, {
      lookupIndex: buildBookLookupIndex(library, 'linux'),
      rememberSourcePath: true,
      onSourcePathRemembered: remembered,
    });

    // Linux is case-sensitive: the two paths that collapse into one entry on
    // Windows stay distinct here — the platform difference is explicit.
    expect(normalizeFilePathForIndex(upper, 'linux')).not.toBe(
      normalizeFilePathForIndex(lower, 'linux'),
    );
    expect(book.altFilePaths).toEqual([upper, lower]);
    expect(remembered).toHaveBeenCalledTimes(1);
  });

  it('fills the ledger when a soft-deleted book is re-imported from the same path', async () => {
    const library: Book[] = [];
    await service.importBook(SOURCE_PATH, library, {
      lookupIndex: buildBookLookupIndex(library, 'linux'),
    });
    const existing = library.find((b) => !b.deletedAt)!;
    expect(existing.altFilePaths).toBeUndefined();
    existing.deletedAt = Date.now();

    const remembered = vi.fn();
    const onDedupHit = vi.fn();
    const revivedBook = await service.importBook(SOURCE_PATH, library, {
      lookupIndex: buildBookLookupIndex(library, 'linux'),
      rememberSourcePath: true,
      onSourcePathRemembered: remembered,
      onDedupHit,
    });

    expect(onDedupHit).toHaveBeenCalledWith('revived');
    expect(revivedBook?.deletedAt).toBeNull();
    expect(revivedBook?.altFilePaths).toEqual([SOURCE_PATH]);
    expect(remembered).toHaveBeenCalledTimes(1);
    // The tombstone slot in the array was replaced by the revived copy.
    expect(library.filter((b) => !b.deletedAt)).toHaveLength(1);
  });

  it('accumulates several source paths for one book without growing on repeats', async () => {
    const paths = [
      '/lib/watched/book.epub',
      '/lib/watched/book-copy.epub',
      '/lib/watched/book-again.epub',
    ];
    const library: Book[] = [];
    // Imports 2..n hit the byHash short-circuit, which requires the managed
    // copy to look present.
    service.getFs().exists.mockResolvedValue(true);
    for (const path of paths) {
      await service.importBook(path, library, {
        lookupIndex: buildBookLookupIndex(library, 'linux'),
        rememberSourcePath: true,
      });
    }

    const book = library.find((b) => !b.deletedAt)!;
    // Copy mode: the book is read from Books/<hash>/, every source is a
    // ledger entry, all three of them.
    expect(book.filePath).toBeUndefined();
    expect(book.altFilePaths).toEqual(paths);

    await service.importBook(paths[0]!, library, {
      lookupIndex: buildBookLookupIndex(library, 'linux'),
      rememberSourcePath: true,
    });
    expect(book.altFilePaths).toEqual(paths);
    expect(library.filter((b) => !b.deletedAt)).toHaveLength(1);
  });
});
