import { describe, test, expect } from 'vitest';
import { Book } from '@/types/book';
import {
  buildAuthorGroupedToastSpec,
  collectGroupNames,
  findAuthorGroupMatch,
  normalizeAuthorKey,
  AuthorGroupedImport,
} from '@/app/library/utils/authorGrouping';
import {
  findGroupRenameCollision,
  getGroupNewBookCounts,
  NEW_BOOK_BADGE_WINDOW_MS,
  renameGroupInLibrary,
  renamePersistentGroupNames,
} from '@/app/library/utils/libraryUtils';
import { md5Fingerprint } from '@/utils/md5';

const makeBook = (overrides: Partial<Book> & { hash: string }): Book =>
  ({
    format: 'EPUB',
    title: 't',
    author: 'a',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }) as Book;

const formatLine = (group: string, titles: string[]) =>
  `Moved into group "${group}": ${titles.join(', ')}`;

describe('normalizeAuthorKey', () => {
  test('trims, collapses whitespace and lowercases', () => {
    expect(normalizeAuthorKey('  J.K.   Rowling ')).toBe('j.k. rowling');
    expect(normalizeAuthorKey('鬼畜奏')).toBe('鬼畜奏');
  });
});

describe('collectGroupNames', () => {
  test('collects full paths and ancestor prefixes, skipping ungrouped/deleted', () => {
    const books = [
      makeBook({ hash: '1', groupName: '鲁迅/杂文' }),
      makeBook({ hash: '2', groupName: '东野圭吾' }),
      makeBook({ hash: '3', groupName: '已删除', deletedAt: 1 }),
    ];
    const names = collectGroupNames(books, ['手动空组']);
    expect(names.sort()).toEqual(['东野圭吾', '手动空组', '鲁迅', '鲁迅/杂文'].sort());
  });

  test('ignores empty and ungrouped placeholder names', () => {
    expect(collectGroupNames([], [''])).toEqual([]);
  });
});

describe('findAuthorGroupMatch', () => {
  const groups = ['鲁迅/杂文', '东野圭吾', 'J.K. Rowling'];

  test('matches case-insensitively against an existing group', () => {
    expect(findAuthorGroupMatch('j.k. rowling', groups)).toBe('J.K. Rowling');
  });

  test('prefers the shortest (top-level) group among nested candidates', () => {
    expect(findAuthorGroupMatch('鲁迅', ['鲁迅/杂文', '鲁迅'])).toBe('鲁迅');
  });

  test('returns null when no group matches or author is blank', () => {
    expect(findAuthorGroupMatch('村上春树', groups)).toBeNull();
    expect(findAuthorGroupMatch('   ', groups)).toBeNull();
  });
});

describe('buildAuthorGroupedToastSpec', () => {
  const entry = (hash: string, title: string, groupName: string): AuthorGroupedImport => ({
    hash,
    title,
    groupId: md5Fingerprint(groupName),
    groupName,
  });

  test('appends per-group destination lines to the base message', () => {
    const spec = buildAuthorGroupedToastSpec(
      'Successfully imported 3 book(s)',
      [
        entry('h1', '书甲', '鬼畜奏'),
        entry('h2', '书乙', '鬼畜奏'),
        entry('h3', '书丙', '东野圭吾'),
      ],
      formatLine,
    );
    expect(spec.message).toBe(
      'Successfully imported 3 book(s)\n' +
        'Moved into group "鬼畜奏": 书甲, 书乙\n' +
        'Moved into group "东野圭吾": 书丙',
    );
  });

  test('deduplicates group ids preserving first-appearance order', () => {
    const spec = buildAuthorGroupedToastSpec(
      '',
      [entry('h1', '书甲', 'A组'), entry('h2', '书乙', 'B组'), entry('h3', '书丙', 'A组')],
      formatLine,
    );
    expect(spec.groupIds).toEqual([md5Fingerprint('A组'), md5Fingerprint('B组')]);
  });

  test('empty base message produces destination lines only', () => {
    const spec = buildAuthorGroupedToastSpec('', [entry('h1', '书甲', 'A组')], formatLine);
    expect(spec.message).toBe('Moved into group "A组": 书甲');
  });
});

describe('getGroupNewBookCounts', () => {
  const now = 1_000_000_000;

  test('counts never-opened books imported within the window', () => {
    const books = [
      makeBook({ hash: '1', groupName: 'A', createdAt: now - 1000 }),
      makeBook({ hash: '2', groupName: 'A', createdAt: now - 1000 }),
    ];
    const counts = getGroupNewBookCounts(books, {}, now);
    expect(counts.get(md5Fingerprint('A'))).toBe(2);
  });

  test('skips books outside the window, opened books, and deleted books', () => {
    const books = [
      makeBook({ hash: '1', groupName: 'A', createdAt: now - NEW_BOOK_BADGE_WINDOW_MS - 1 }),
      makeBook({ hash: '2', groupName: 'A', createdAt: now - 1000, progress: [3, 10] }),
      makeBook({ hash: '3', groupName: 'A', createdAt: now - 1000, deletedAt: 1 }),
      makeBook({ hash: '4', groupName: undefined, createdAt: now - 1000 }),
    ];
    const counts = getGroupNewBookCounts(books, {}, now);
    expect(counts.size).toBe(0);
  });

  test('clears a group once visited but keeps counting later imports', () => {
    const groupName = 'A';
    const gid = md5Fingerprint(groupName);
    const visitAt = now - 500;
    const books = [
      makeBook({ hash: '1', groupName, createdAt: now - 1000 }),
      makeBook({ hash: '2', groupName, createdAt: now - 100 }),
    ];
    const counts = getGroupNewBookCounts(books, { [gid]: visitAt }, now);
    expect(counts.get(gid)).toBe(1);
  });

  test('rolls child-group counts up to ancestor groups', () => {
    const books = [makeBook({ hash: '1', groupName: 'A/B', createdAt: now - 1000 })];
    const counts = getGroupNewBookCounts(books, {}, now);
    expect(counts.get(md5Fingerprint('A/B'))).toBe(1);
    expect(counts.get(md5Fingerprint('A'))).toBe(1);
  });
});

describe('renameGroupInLibrary', () => {
  test('renames the group and its nested children, restamping both clocks', () => {
    const books = [
      makeBook({ hash: '1', groupName: '旧名', groupId: md5Fingerprint('旧名') }),
      makeBook({ hash: '2', groupName: '旧名/子组', groupId: md5Fingerprint('旧名/子组') }),
      makeBook({ hash: '3', groupName: '别的组' }),
    ];
    const { updated, changed } = renameGroupInLibrary(books, '旧名', '新名');
    expect(changed).toBe(true);
    expect(updated[0]!.groupName).toBe('新名');
    expect(updated[0]!.groupId).toBe(md5Fingerprint('新名'));
    expect(updated[1]!.groupName).toBe('新名/子组');
    expect(updated[1]!.groupId).toBe(md5Fingerprint('新名/子组'));
    expect(updated[2]!.groupName).toBe('别的组');
    expect(updated[0]!.metadataUpdatedAt).toBe(updated[0]!.updatedAt);
  });

  test('no-op for blank or identical names', () => {
    const books = [makeBook({ hash: '1', groupName: 'A' })];
    expect(renameGroupInLibrary(books, 'A', 'A').changed).toBe(false);
    expect(renameGroupInLibrary(books, 'A', '  ').changed).toBe(false);
  });

  test('group with no books reports changed=false (empty group)', () => {
    const books = [makeBook({ hash: '1', groupName: 'B' })];
    const { updated, changed } = renameGroupInLibrary(books, 'A', 'C');
    expect(changed).toBe(false);
    expect(updated).toBe(books);
  });
});

describe('renamePersistentGroupNames', () => {
  test('maps the group and child paths to the new prefix', () => {
    const { relabeled, changed } = renamePersistentGroupNames(
      ['旧名', '旧名/空子组', '别的'],
      '旧名',
      '新名',
    );
    expect(changed).toBe(true);
    expect(relabeled.get('旧名')).toBe('新名');
    expect(relabeled.get('旧名/空子组')).toBe('新名/空子组');
    expect(relabeled.has('别的')).toBe(false);
  });

  test('no-op for blank or identical names', () => {
    expect(renamePersistentGroupNames(['A'], 'A', 'A').changed).toBe(false);
    expect(renamePersistentGroupNames(['A'], 'A', '').changed).toBe(false);
    expect(renamePersistentGroupNames(['B'], 'A', 'C').changed).toBe(false);
  });
});

describe('findGroupRenameCollision', () => {
  const existing = ['东野圭吾', '东野圭吾/推理', '鲁迅', '鲁迅/杂文', '鲁迅/杂文/随笔'];

  test('blocks when the target name already exists', () => {
    expect(findGroupRenameCollision(existing, '鲁迅', '东野圭吾')).toBe('东野圭吾');
  });

  test('blocks when a nested target path already exists', () => {
    // "鲁迅/杂文" 改名 "东野圭吾/推理" 会并进已有的组——同样算冲突。
    expect(findGroupRenameCollision(existing, '鲁迅', '东野圭吾/推理')).toBe('东野圭吾/推理');
    expect(findGroupRenameCollision(existing, '鲁迅', '东野圭吾')).not.toBeNull();
  });

  test('renaming within the renamed subtree is allowed', () => {
    // 目标就是被改名子树自身（如改前缀大小写后的路径）不构成冲突。
    expect(findGroupRenameCollision(existing, '鲁迅', '鲁迅 ')).toBeNull();
  });

  test('no collision when the target name is fresh', () => {
    expect(findGroupRenameCollision(existing, '鲁迅', '村上春树')).toBeNull();
  });

  test('blank or identical target never collides', () => {
    expect(findGroupRenameCollision(existing, '鲁迅', '')).toBeNull();
    expect(findGroupRenameCollision(existing, '鲁迅', '鲁迅')).toBeNull();
  });
});
