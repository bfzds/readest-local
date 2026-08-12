import { beforeEach, describe, expect, it, vi } from 'vitest';

import { saveEditedEpub } from '@/app/reader/editor/saveEditedEpub';
import { Book } from '@/types/book';

const mocks = vi.hoisted(() => ({
  setLibrary: vi.fn(),
  saveLibraryBooks: vi.fn(async () => {}),
  bookFixture: {
    hash: 'oldhash',
    metaHash: 'metahash',
    format: 'EPUB',
    title: 'Book',
    sourceTitle: 'Book',
  } as unknown as Book,
}));

vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: {
    getState: () => ({ library: [mocks.bookFixture], setLibrary: mocks.setLibrary }),
  },
}));

const makeAppService = () => {
  const files = new Map<string, string | Uint8Array>();
  return {
    files,
    saveLibraryBooks: mocks.saveLibraryBooks,
    createDir: vi.fn(async () => {}),
    writeFile: vi.fn(async (path: string, _base: string, content: File | string) => {
      files.set(
        path,
        typeof content === 'string' ? content : new Uint8Array(await content.arrayBuffer()),
      );
    }),
    readFile: vi.fn(async (path: string) => {
      const value = files.get(path);
      if (value == null) throw new Error('not found');
      return typeof value === 'string' ? value : new TextDecoder().decode(value);
    }),
    isDirectory: vi.fn(async (path: string) =>
      [...files.keys()].some((key) => key.startsWith(`${path}/`)),
    ),
    copyFile: vi.fn(async (src: string, _srcBase: string, dst: string) => {
      const value = files.get(src);
      if (value) files.set(dst, value);
    }),
    deleteDir: vi.fn(async () => {}),
  };
};

describe('saveEditedEpub', () => {
  let appService: ReturnType<typeof makeAppService>;

  beforeEach(() => {
    appService = makeAppService();
    appService.files.set(
      'oldhash/config.json',
      JSON.stringify({ progress: [3, 100], bookHash: 'oldhash' }),
    );
    vi.clearAllMocks();
  });

  it('writes the new epub, migrates config progress, and updates the library', async () => {
    const result = await saveEditedEpub({
      appService: appService as never,
      envConfig: {} as never,
      book: mocks.bookFixture,
      newEpub: new Blob(['epub'], { type: 'application/epub+zip' }),
    });

    expect(result.book.hash).not.toBe('oldhash');
    expect(appService.files.has(`${result.book.hash}/Book.epub`)).toBe(true);
    expect(appService.files.get(`${result.book.hash}/config.json`)).toContain('"progress":[3,100]');
    expect(appService.files.get(`${result.book.hash}/config.json`)).toContain(result.book.hash);
    expect(appService.deleteDir).toHaveBeenCalledWith('oldhash', 'Books', true);
    expect(mocks.setLibrary).toHaveBeenCalledTimes(1);
    expect(mocks.saveLibraryBooks).toHaveBeenCalledTimes(1);
    // 编辑保存是刻意的"同书换版本"：必须 replace 整份 library.json，
    // 否则 merge-floor 会把旧 hash 记录留在磁盘，形成两本书且旧书打不开。
    expect(mocks.saveLibraryBooks).toHaveBeenCalledWith(expect.any(Array), { replace: true });
  });

  it('throws and keeps the old directory when writing fails', async () => {
    appService.writeFile.mockRejectedValueOnce(new Error('disk full'));

    await expect(
      saveEditedEpub({
        appService: appService as never,
        envConfig: {} as never,
        book: mocks.bookFixture,
        newEpub: new Blob(['epub'], { type: 'application/epub+zip' }),
      }),
    ).rejects.toThrow('disk full');

    expect(appService.deleteDir).not.toHaveBeenCalledWith('oldhash', 'Books', true);
    expect(mocks.setLibrary).not.toHaveBeenCalled();
    expect(mocks.saveLibraryBooks).not.toHaveBeenCalled();
  });
});
