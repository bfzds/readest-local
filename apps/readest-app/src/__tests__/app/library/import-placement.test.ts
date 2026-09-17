import { describe, expect, it } from 'vitest';
import { Book } from '@/types/book';
import { findTxtDedupMatch } from '@/utils/book';
import { demoteBookToRoot, shouldDemoteDedupHitToRoot } from '@/app/library/utils/importPlacement';

const makeBook = (overrides: Partial<Book> = {}): Book => ({
  hash: 'hash-1',
  format: 'EPUB',
  title: 'Test Book',
  author: 'Some Author',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const fullCtx = {
  topLevelImport: true,
  noFolderDerivedGroup: true,
  userInitiated: true,
  dedupHit: true,
};

describe('shouldDemoteDedupHitToRoot', () => {
  it('顶层手动导入的去重命中书带旧分组 → 降组', () => {
    const book = makeBook({ groupId: 'g1', groupName: '小说' });
    expect(shouldDemoteDedupHitToRoot(book, fullCtx)).toBe(true);
  });

  it('书在其作者匹配组内 → 保留分组', () => {
    const book = makeBook({ author: '天蚕土豆', groupId: 'g1', groupName: '天蚕土豆' });
    expect(shouldDemoteDedupHitToRoot(book, fullCtx)).toBe(false);
  });

  it('无分组的新书/未命中分组 → 不降组', () => {
    const book = makeBook();
    expect(shouldDemoteDedupHitToRoot(book, fullCtx)).toBe(false);
  });

  it.each([
    ['非顶层导入（指定了目标分组）', { ...fullCtx, topLevelImport: false }],
    ['目录结构推导出了分组', { ...fullCtx, noFolderDerivedGroup: false }],
    ['静默重扫（watched-folder）', { ...fullCtx, userInitiated: false }],
    ['非去重命中（真新导入）', { ...fullCtx, dedupHit: false }],
  ])('%s → 不降组', (_name, ctx) => {
    const book = makeBook({ groupId: 'g1', groupName: '小说' });
    expect(shouldDemoteDedupHitToRoot(book, ctx)).toBe(false);
  });
});

describe('demoteBookToRoot', () => {
  it('清空分组并盖双时钟', () => {
    const book = makeBook({ groupId: 'g1', groupName: '小说' });
    demoteBookToRoot(book, 12345);
    expect(book.groupId).toBe('');
    expect(book.groupName).toBeUndefined();
    expect(book.updatedAt).toBe(12345);
    expect(book.metadataUpdatedAt).toBe(12345);
  });
});

describe('findTxtDedupMatch', () => {
  it('按 sourceHash 命中未删除的 TXT 转换产物', () => {
    const books = [
      makeBook({ hash: 'a', sourceHash: 'txt-a' }),
      makeBook({ hash: 'b', sourceHash: 'txt-b' }),
    ];
    expect(findTxtDedupMatch(books, 'txt-b')?.hash).toBe('b');
    expect(findTxtDedupMatch(books, 'txt-none')).toBeUndefined();
  });

  it('soft-deleted 条目不参与匹配（重导走完整路径复活）', () => {
    const books = [makeBook({ hash: 'a', sourceHash: 'txt-a', deletedAt: 999 })];
    expect(findTxtDedupMatch(books, 'txt-a')).toBeUndefined();
  });
});
