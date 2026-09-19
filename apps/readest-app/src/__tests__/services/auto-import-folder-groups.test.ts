import { describe, it, expect } from 'vitest';

import { selectNewImportableFiles, toWatchedFolderImports } from '@/services/bookService';
import { getFolderImportGroupName } from '@/utils/path';
import type { WatchedFolderMode } from '@/types/settings';

/**
 * Issue #5423: a watched folder imported with "Create groups from subfolders"
 * grouped its books on the initial import, but every later auto-import dropped
 * the new books into the library root. The group hint lives on each importer
 * input (`basePath`), so these tests pin the mapping from a folder scan to that
 * hint, and from the hint to the group name the importer derives.
 */
const WATCHED = '/lib/watched';
const SCANNED = [
  { fullPath: '/lib/watched/SciFi/dune.epub', size: 2048 },
  { fullPath: '/lib/watched/Poetry/odes.epub', size: 2048 },
  { fullPath: '/lib/watched/loose.epub', size: 2048 },
];

/** Same derivation `importBooks` runs per file, applied to the built inputs. */
const groupNames = (files: Array<{ path: string; basePath?: string }>) =>
  files.map((file) => (file.basePath ? getFolderImportGroupName(file.path, file.basePath) : ''));

describe('auto-import: grouping of newly-found books', () => {
  const scanFolder = (folder: string, entries: typeof SCANNED, mode: WatchedFolderMode) => {
    const fresh = selectNewImportableFiles(entries, {
      extensions: ['epub'],
      minSizeBytes: 0,
      existingPaths: new Set<string>(),
      osPlatform: 'linux',
    });
    return toWatchedFolderImports(folder, fresh, mode);
  };

  it('mirrors subfolders as groups, like the initial import did', () => {
    const files = scanFolder(WATCHED, SCANNED, 'mirror');

    expect(files.every((file) => file.basePath === WATCHED)).toBe(true);
    // The watched folder itself is the top-level group, each subfolder nests
    // under it, and a book sitting loose in the root belongs to the folder's
    // own group — exactly what a manual folder import produces.
    expect(groupNames(files)).toEqual(['watched/SciFi', 'watched/Poetry', 'watched']);
  });

  it('keeps books in the library root for a flattened folder', () => {
    const files = scanFolder(WATCHED, SCANNED, 'flat');

    expect(files.every((file) => file.basePath === undefined)).toBe(true);
    expect(groupNames(files)).toEqual(['', '', '']);
  });

  // 按作者分组同样要靠 basePath：它既是推导组名的输入，也是 `processFile`
  // 反查这个文件夹用了哪条规则的线索。
  it('keeps the folder hint for author grouping and trims to the author level', () => {
    const files = scanFolder(
      'C:\\Downloads\\Pixiv',
      [
        { fullPath: 'C:\\Downloads\\Pixiv\\2025-01-01\\AuthorA\\novel.epub', size: 2048 },
        { fullPath: 'C:\\Downloads\\Pixiv\\2025-01-01\\novel.epub', size: 2048 },
      ],
      'author',
    );

    expect(files.every((file) => file.basePath === 'C:\\Downloads\\Pixiv')).toBe(true);
    expect(
      files.map((file) => getFolderImportGroupName(file.path, file.basePath!, { mode: 'author' })),
    ).toEqual(['Pixiv/AuthorA', 'Pixiv']);
  });

  it('tags every input with the folder it was scanned from', () => {
    const files = scanFolder(WATCHED, SCANNED, 'mirror');

    expect(files.every((file) => file.watchedFolder === WATCHED)).toBe(true);
  });

  it('derives the same groups from Windows paths', () => {
    const folder = 'C:\\Users\\me\\Books';
    const files = scanFolder(
      folder,
      [
        { fullPath: 'C:\\Users\\me\\Books\\SciFi\\dune.epub', size: 2048 },
        { fullPath: 'C:\\Users\\me\\Books\\loose.epub', size: 2048 },
      ],
      'mirror',
    );

    expect(groupNames(files)).toEqual(['Books/SciFi', 'Books']);
  });
});
