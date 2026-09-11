import { describe, expect, test, vi } from 'vitest';
import { saveBookNav } from '@/services/bookService';
import { BOOK_NAV_VERSION, type BookNav } from '@/services/nav';
import type { Book } from '@/types/book';
import type { BaseDir, FileSystem } from '@/types/system';
import type { TOCItem } from '@/libs/document';

function makeBook(): Book {
  return {
    hash: 'bookhash',
    format: 'EPUB',
    title: 'sample',
    author: 'Author',
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    downloadedAt: 1,
  };
}

function makeFs(): FileSystem {
  return {
    resolvePath: vi.fn(),
    getURL: vi.fn(),
    getBlobURL: vi.fn(),
    getImageURL: vi.fn(),
    openFile: vi.fn(),
    copyFile: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(async () => undefined),
    removeFile: vi.fn(),
    readDir: vi.fn(async () => []),
    createDir: vi.fn(),
    removeDir: vi.fn(),
    exists: vi.fn(),
    stats: vi.fn(),
    getPrefix: vi.fn(),
  };
}

const collectItems = (items: TOCItem[]): TOCItem[] =>
  items.flatMap((item) => [item, ...(item.subitems?.length ? collectItems(item.subitems) : [])]);

describe('saveBookNav — nav.json 只承载真实目录', () => {
  // 虚拟目录条目是用户数据（存 config.json 的 virtualToc），绝不进 nav.json。
  // nav 管线会把条目重新编号成非负 id，虚拟条目一旦写进缓存，strip 判据随之
  // 失效，之后每次打开都会残留并叠加——所以写盘前必须过滤。
  test('写盘前丢弃 CFI-href 与负 id 的虚拟条目（含 subitems 递归）', async () => {
    const fs = makeFs();
    const nav: BookNav = {
      version: BOOK_NAV_VERSION,
      toc: [
        {
          id: 0,
          label: '第一部分',
          href: 'OEBPS/part1.html',
          subitems: [
            { id: 1, label: '第一章', href: 'OEBPS/ch1.html' },
            { id: 2, label: '嵌套虚拟', href: 'epubcfi(/6/4!/4/2)' },
          ],
        },
        { id: 3, label: '顶层虚拟', href: 'epubcfi(/6/6!/4/2)' },
        { id: -1, label: '负id虚拟', href: 'OEBPS/ch1.html' },
      ] as TOCItem[],
      sections: {},
    };

    await saveBookNav(fs, makeBook(), nav);

    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    const [path, base, content] = vi.mocked(fs.writeFile).mock.calls[0] as unknown as [
      string,
      BaseDir,
      string,
    ];
    expect(path).toBe('bookhash/nav.json');
    expect(base).toBe('Books');
    const written = JSON.parse(content) as BookNav;
    expect(collectItems(written.toc).map((item) => item.label)).toEqual(['第一部分', '第一章']);
  });

  test('入参 nav 不被原地修改', async () => {
    const fs = makeFs();
    const nav: BookNav = {
      version: BOOK_NAV_VERSION,
      toc: [
        { id: 0, label: '真实条目', href: 'OEBPS/ch1.html' },
        { id: 3, label: '历史虚拟', href: 'epubcfi(/6/4!/4/2)' },
      ] as TOCItem[],
      sections: {},
    };

    await saveBookNav(fs, makeBook(), nav);

    expect(nav.toc).toHaveLength(2);
  });

  test('干净 nav 原样写盘', async () => {
    const fs = makeFs();
    const nav: BookNav = {
      version: BOOK_NAV_VERSION,
      toc: [
        {
          id: 0,
          label: '第一部分',
          href: 'OEBPS/part1.html',
          subitems: [{ id: 1, label: '第一章', href: 'OEBPS/ch1.html' }],
        },
      ] as TOCItem[],
      sections: {},
    };

    await saveBookNav(fs, makeBook(), nav);

    const [, , content] = vi.mocked(fs.writeFile).mock.calls[0] as unknown as [
      string,
      BaseDir,
      string,
    ];
    const written = JSON.parse(content) as BookNav;
    expect(written.version).toBe(BOOK_NAV_VERSION);
    expect(written.toc).toEqual(nav.toc);
    expect(written.sections).toEqual({});
  });
});
