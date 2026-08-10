import { describe, test, expect, vi } from 'vitest';

import { ingestFile } from '@/services/ingestService';
import type { Book } from '@/types/book';
import type { AppService, OsPlatform } from '@/types/system';
import type { SystemSettings } from '@/types/settings';

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    hash: 'hash1',
    format: 'EPUB',
    title: 'Test Book',
    author: 'Author',
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

function makeDeps(
  over: {
    importResult?: Book | null;
    externalLibraryFolders?: string[];
    osPlatform?: OsPlatform;
  } = {},
) {
  const importResult = over.importResult === undefined ? makeBook() : over.importResult;
  const importBook = vi.fn().mockResolvedValue(importResult);
  const appService = {
    importBook,
    osPlatform: over.osPlatform ?? ('linux' as OsPlatform),
  } as unknown as AppService;
  const settings = {
    externalLibraryFolders: over.externalLibraryFolders,
  } as SystemSettings;
  return { appService, settings, importBook };
}

describe('ingestFile', () => {
  test('returns the imported book', async () => {
    const { appService, settings } = makeDeps();
    const book = await ingestFile({ file: 'book.epub', books: [] }, { appService, settings });
    expect(book?.hash).toBe('hash1');
  });

  test('returns null when importBook returns null', async () => {
    const { appService, settings } = makeDeps({ importResult: null });
    const book = await ingestFile({ file: 'book.epub', books: [] }, { appService, settings });
    expect(book).toBeNull();
  });

  test('passes the lookup index through to importBook', async () => {
    const { appService, settings, importBook } = makeDeps();
    const lookupIndex = { byHash: new Map(), byMetaHash: new Map() } as never;
    await ingestFile({ file: 'book.epub', books: [], lookupIndex }, { appService, settings });
    expect(importBook).toHaveBeenCalledWith('book.epub', [], {
      lookupIndex,
      transient: undefined,
      inPlace: false,
    });
  });

  test('applies groupId and groupName', async () => {
    const { appService, settings } = makeDeps();
    const book = await ingestFile(
      { file: 'book.epub', books: [], groupId: 'g1', groupName: 'Sci-Fi' },
      { appService, settings },
    );
    expect(book?.groupId).toBe('g1');
    expect(book?.groupName).toBe('Sci-Fi');
  });

  test('clears the group when groupId is the empty string (flatten-into-root)', async () => {
    const { appService, settings } = makeDeps({
      importResult: makeBook({ groupId: 'old', groupName: 'Old/Folder' }),
    });
    const book = await ingestFile(
      { file: 'book.epub', books: [], groupId: '', groupName: undefined },
      { appService, settings },
    );
    expect(book?.groupId).toBe('');
    expect(book?.groupName).toBeUndefined();
  });

  test('applies a subject tag and bumps updatedAt', async () => {
    const { appService, settings } = makeDeps();
    const book = await ingestFile(
      { file: 'book.epub', books: [], subjectTag: 'scifi' },
      { appService, settings },
    );
    expect(book?.tags).toContain('scifi');
    expect(book?.updatedAt).toBeGreaterThan(2000);
  });

  test('passes the transient flag through to importBook', async () => {
    const { appService, settings, importBook } = makeDeps();
    await ingestFile({ file: 'book.epub', books: [], transient: true }, { appService, settings });
    expect(importBook).toHaveBeenCalledWith('book.epub', [], {
      lookupIndex: undefined,
      transient: true,
      inPlace: false,
    });
  });

  test('does not mark in-place when no external library folders are configured', async () => {
    const { appService, settings, importBook } = makeDeps();
    await ingestFile({ file: '/Users/me/Books/sample.epub', books: [] }, { appService, settings });
    expect(importBook.mock.calls[0]?.[2]).toMatchObject({ inPlace: false });
  });

  test('marks an external library folder import in-place', async () => {
    const { appService, settings, importBook } = makeDeps({
      externalLibraryFolders: ['/Users/me/Library'],
    });
    await ingestFile(
      { file: '/Users/me/Library/sample.epub', books: [] },
      { appService, settings },
    );
    expect(importBook.mock.calls[0]?.[2]).toMatchObject({ inPlace: true });
  });

  test('does not mark in-place for a sibling directory', async () => {
    const { appService, settings, importBook } = makeDeps({
      externalLibraryFolders: ['/Users/me/Library'],
    });
    await ingestFile(
      { file: '/Users/me/LibraryOther/sample.epub', books: [] },
      { appService, settings },
    );
    expect(importBook.mock.calls[0]?.[2]).toMatchObject({ inPlace: false });
  });

  test('does not mark in-place for URL strings even if they happen to start with a slash', async () => {
    const { appService, settings, importBook } = makeDeps({
      externalLibraryFolders: ['/Users/me/Library'],
    });
    await ingestFile(
      { file: 'https://example.com/Books/sample.epub', books: [] },
      { appService, settings },
    );
    expect(importBook.mock.calls[0]?.[2]).toMatchObject({ inPlace: false });
  });

  test('byFilePath hit short-circuits importBook entirely on in-place re-import', async () => {
    const { appService, settings, importBook } = makeDeps({
      externalLibraryFolders: ['/Users/me/Library'],
      osPlatform: 'macos',
    });
    const sourcePath = '/Users/me/Library/sample.epub';
    const existing: Book = {
      hash: 'previously-hashed',
      format: 'EPUB',
      title: 'Existing',
      author: 'Author',
      filePath: sourcePath,
      createdAt: 1000,
      updatedAt: 2000,
      groupId: 'manual',
      groupName: 'Manual/Group',
    };
    const lookupIndex = {
      byHash: new Map(),
      byMetaKey: new Map(),
      byFilePath: new Map([[sourcePath.toLowerCase(), existing]]),
    } as unknown as Parameters<typeof ingestFile>[0]['lookupIndex'];
    const book = await ingestFile(
      {
        file: sourcePath,
        books: [existing],
        lookupIndex,
        groupId: '',
        groupName: undefined,
      },
      { appService, settings },
    );
    expect(book).toBe(existing);
    expect(importBook).not.toHaveBeenCalled();
    expect(existing.groupId).toBe('manual');
    expect(existing.groupName).toBe('Manual/Group');
  });
});
