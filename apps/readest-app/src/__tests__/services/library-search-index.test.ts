import { describe, expect, it } from 'vitest';

import { NodeDatabaseService } from '@/services/database/nodeDatabaseService';
import { migrate } from '@/services/database/migrate';
import { getMigrations } from '@/services/database/migrations';
import {
  beginSearchIndex,
  buildSearchIndexNodes,
  completeSearchIndex,
  isSearchIndexFresh,
  loadSearchIndexSections,
  readSearchIndexMeta,
  SEARCH_INDEX_VERSION,
  writeSearchIndexNodes,
  writeSearchIndexSection,
  writeSearchIndexSections,
  type SearchIndexMeta,
  type SearchIndexSection,
} from '@/services/librarySearchIndex';
import type { Book } from '@/types/book';

const makeBook = (hash: string, updatedAt = 1): Book => ({
  hash,
  format: 'MD',
  title: 't',
  author: 'a',
  createdAt: 1,
  updatedAt,
  primaryLanguage: 'en',
});

const makeMeta = (bookHash: string, overrides?: Partial<SearchIndexMeta>): SearchIndexMeta => ({
  updatedAt: 1,
  version: SEARCH_INDEX_VERSION,
  totalSections: 1,
  complete: true,
  navHash: '',
  bookHash,
  ...overrides,
});

const openDb = async () => {
  const db = await NodeDatabaseService.open(':memory:');
  await migrate(db, getMigrations('library-search'));
  return db;
};

describe('librarySearchIndex 索引新鲜度（B1）', () => {
  it('beginSearchIndex 写入 book.hash，readSearchIndexMeta 回读一致', async () => {
    const db = await openDb();
    const book = makeBook('hash-abc', 100);
    await beginSearchIndex(db, book, 2, 'nav-1');
    const meta = await readSearchIndexMeta(db);
    expect(meta).not.toBeNull();
    expect(meta!.bookHash).toBe('hash-abc');
  });

  it('阅读进度（updatedAt）变化但文件 hash 不变 → 索引仍新鲜，不触发重建', async () => {
    const db = await openDb();
    const book = makeBook('hash-abc', 100);
    await beginSearchIndex(db, book, 1, 'nav-1');
    await writeSearchIndexSection(db, 0, 's0', 'hello world');
    await completeSearchIndex(db, 1);
    const meta = await readSearchIndexMeta(db);
    expect(meta).not.toBeNull();
    // 模拟：读了几页后 updatedAt 被 updateBookProgress 更新
    const readBook = makeBook('hash-abc', 200);
    expect(isSearchIndexFresh(meta, readBook)).toBe(true);
  });

  it('文件 hash 变化（重导入新版本）→ 索引判脏，需重建', async () => {
    const db = await openDb();
    const book = makeBook('hash-old', 100);
    await beginSearchIndex(db, book, 1, 'nav-1');
    await writeSearchIndexSection(db, 0, 's0', 'hello world');
    await completeSearchIndex(db, 1);
    const meta = await readSearchIndexMeta(db);
    expect(isSearchIndexFresh(meta, makeBook('hash-new', 100))).toBe(false);
  });

  it('complete=0（构建中/中断）→ 判脏', async () => {
    const meta = makeMeta('hash-abc', { complete: false });
    expect(isSearchIndexFresh(meta, makeBook('hash-abc'))).toBe(false);
  });

  it('版本号不匹配 → 判脏（提取逻辑变更时强制重建）', async () => {
    const meta = makeMeta('hash-abc', { version: SEARCH_INDEX_VERSION - 1 });
    expect(isSearchIndexFresh(meta, makeBook('hash-abc'))).toBe(false);
  });

  it('nav_hash 不匹配由调用方独立判定，fresh 本身不依赖 navHash', async () => {
    const db = await openDb();
    const book = makeBook('hash-abc', 100);
    await beginSearchIndex(db, book, 1, 'nav-1');
    await writeSearchIndexSection(db, 0, 's0', 'hello world');
    await completeSearchIndex(db, 1);
    const meta = await readSearchIndexMeta(db);
    expect(isSearchIndexFresh(meta, book)).toBe(true);
  });

  it('写盘序列（begin→write→complete）后 meta 完整可读', async () => {
    const db = await openDb();
    const book = makeBook('hash-abc', 100);
    await beginSearchIndex(db, book, 2, 'nav-1');
    await writeSearchIndexSection(db, 0, 's0', 'hello world');
    await writeSearchIndexSection(db, 1, 's1', 'second chapter');
    await completeSearchIndex(db, 2);
    const meta = await readSearchIndexMeta(db);
    expect(meta!.totalSections).toBe(2);
    expect(meta!.complete).toBe(true);
    expect(meta!.navHash).toBe('nav-1');
    expect(meta!.bookHash).toBe('hash-abc');
  });
});

// 保持文件可独立运行（vitest 无需额外全局）
describe('librarySearchIndex DB 生命周期', () => {
  it('openDb 使用独立 in-memory 库，互不干扰', async () => {
    const dbA = await openDb();
    const dbB = await openDb();
    const book = makeBook('h-1', 100);
    await beginSearchIndex(dbA, book, 1, 'n');
    await completeSearchIndex(dbA, 1);
    expect(await readSearchIndexMeta(dbB)).toBeNull();
  });
});

describe('completeSearchIndex 完整性校验（B7）', () => {
  it('只写了部分 section 时不置 complete（防并发交错出半成品索引）', async () => {
    const db = await openDb();
    const book = makeBook('hash-abc', 100);
    await beginSearchIndex(db, book, 2, 'nav-1');
    await writeSearchIndexSection(db, 0, 's0', 'hello');
    await completeSearchIndex(db, 2); // 只写了 1/2 节
    const meta = await readSearchIndexMeta(db);
    expect(meta!.complete).toBe(false);
  });

  it('section 写满时置 complete', async () => {
    const db = await openDb();
    const book = makeBook('hash-abc', 100);
    await beginSearchIndex(db, book, 2, 'nav-1');
    await writeSearchIndexSection(db, 0, 's0', 'hello');
    await writeSearchIndexSection(db, 1, 's1', 'world');
    await completeSearchIndex(db, 2);
    const meta = await readSearchIndexMeta(db);
    expect(meta!.complete).toBe(true);
  });
});

describe('writeSearchIndexSections 批量写（SF2）', () => {
  it('批量写入后 loadSearchIndexSections 回读一致（含单引号/折叠文本）', async () => {
    const db = await openDb();
    const book = makeBook('hash-abc', 100);
    await beginSearchIndex(db, book, 3, 'nav-1');
    const sections: SearchIndexSection[] = [
      { idx: 0, label: "It's a title", text: "don't panic" },
      { idx: 1, label: 's1', text: 'HELLO WORLD' },
      { idx: 2, label: 's2', text: 'hello world' },
    ];
    await writeSearchIndexSections(db, sections);
    const rows = await loadSearchIndexSections(db);
    expect(rows).toEqual([
      { idx: 0, label: "It's a title", text: "don't panic" },
      { idx: 1, label: 's1', text: 'HELLO WORLD' },
      { idx: 2, label: 's2', text: 'hello world' },
    ]);
  });

  it('批量写入覆盖同 idx 旧内容（DELETE+INSERT 语义）', async () => {
    const db = await openDb();
    const book = makeBook('hash-abc', 100);
    await beginSearchIndex(db, book, 2, 'nav-1');
    await writeSearchIndexSection(db, 0, 'old', 'old text');
    await writeSearchIndexSections(db, [
      { idx: 0, label: 'new', text: 'new text' },
      { idx: 1, label: 's1', text: 'second' },
    ]);
    const rows = await loadSearchIndexSections(db);
    expect(rows).toEqual([
      { idx: 0, label: 'new', text: 'new text' },
      { idx: 1, label: 's1', text: 'second' },
    ]);
  });

  it('空数组为 no-op', async () => {
    const db = await openDb();
    const book = makeBook('hash-abc', 100);
    await beginSearchIndex(db, book, 1, 'nav-1');
    await expect(writeSearchIndexSections(db, [])).resolves.toBeUndefined();
  });
});

describe('writeSearchIndexNodes 批量写', () => {
  const readNodes = (db: NodeDatabaseService) =>
    db.select<{
      node_id: number;
      parent_id: number | null;
      ord: number;
      depth: number;
      label: string;
      section_start: number;
      section_end: number;
    }>(
      'SELECT node_id, parent_id, ord, depth, label, section_start, section_end FROM search_nodes ORDER BY node_id',
    );

  it('批量写入后回读一致（含单引号 label 转义）', async () => {
    const db = await openDb();
    const book = makeBook('hash-abc', 100);
    await beginSearchIndex(db, book, 5, 'nav-1');
    await writeSearchIndexNodes(db, [
      {
        nodeId: 0,
        parentId: null,
        ord: 0,
        depth: 0,
        label: "It's a chapter",
        sectionStart: 0,
        sectionEnd: 2,
      },
      { nodeId: 1, parentId: 0, ord: 0, depth: 1, label: 'A1', sectionStart: 0, sectionEnd: 0 },
      { nodeId: 2, parentId: 0, ord: 1, depth: 1, label: 'A2', sectionStart: 1, sectionEnd: 1 },
      { nodeId: 3, parentId: null, ord: 1, depth: 0, label: 'B', sectionStart: 2, sectionEnd: 4 },
    ]);
    const rows = await readNodes(db);
    expect(rows).toEqual([
      {
        node_id: 0,
        parent_id: null,
        ord: 0,
        depth: 0,
        label: "It's a chapter",
        section_start: 0,
        section_end: 2,
      },
      { node_id: 1, parent_id: 0, ord: 0, depth: 1, label: 'A1', section_start: 0, section_end: 0 },
      { node_id: 2, parent_id: 0, ord: 1, depth: 1, label: 'A2', section_start: 1, section_end: 1 },
      {
        node_id: 3,
        parent_id: null,
        ord: 1,
        depth: 0,
        label: 'B',
        section_start: 2,
        section_end: 4,
      },
    ]);
  });

  it('重写覆盖旧内容（先 DELETE）', async () => {
    const db = await openDb();
    const book = makeBook('hash-abc', 100);
    await beginSearchIndex(db, book, 2, 'nav-1');
    await writeSearchIndexNodes(db, [
      { nodeId: 0, parentId: null, ord: 0, depth: 0, label: 'old', sectionStart: 0, sectionEnd: 1 },
    ]);
    await writeSearchIndexNodes(db, [
      { nodeId: 0, parentId: null, ord: 0, depth: 0, label: 'new', sectionStart: 0, sectionEnd: 1 },
      { nodeId: 1, parentId: 0, ord: 1, depth: 1, label: 'c', sectionStart: 1, sectionEnd: 1 },
    ]);
    const rows = await readNodes(db);
    expect(rows).toEqual([
      {
        node_id: 0,
        parent_id: null,
        ord: 0,
        depth: 0,
        label: 'new',
        section_start: 0,
        section_end: 1,
      },
      { node_id: 1, parent_id: 0, ord: 1, depth: 1, label: 'c', section_start: 1, section_end: 1 },
    ]);
  });
});

describe('buildSearchIndexNodes 的 sectionEnd 计算（SF1 等价性）', () => {
  const resolveSection = (href: string) => ({ a: 0, a1: 1, a2: 2, b: 3, b1: 4 })[href] ?? undefined;
  const toc = [
    {
      label: 'A',
      href: 'a',
      subitems: [
        { label: 'A1', href: 'a1' },
        { label: 'A2', href: 'a2' },
      ],
    },
    { label: 'B', href: 'b', subitems: [{ label: 'B1', href: 'b1' }] },
  ];
  const nodes = buildSearchIndexNodes(toc, resolveSection, 5);
  const byLabel = Object.fromEntries(nodes.map((n) => [n.label, n]));

  it('每个节点 sectionEnd 由右侧第一个同/更浅深度节点决定（单遍栈与朴素双循环等价）', () => {
    expect(byLabel['A']!.sectionEnd).toBe(2); // 右侧第一个 depth<=0 = B(start 3)
    expect(byLabel['A1']!.sectionEnd).toBe(1); // 右侧第一个 depth<=1 = A2(start 2)
    expect(byLabel['A2']!.sectionEnd).toBe(2); // 右侧第一个 depth<=1 = B(start 3)
    expect(byLabel['B']!.sectionEnd).toBe(4); // 无更浅 → total-1
    expect(byLabel['B1']!.sectionEnd).toBe(4); // 最后一个 → total-1
  });

  it('节点按前序排列，parentId 指向上级', () => {
    expect(nodes.map((n) => n.label)).toEqual(['A', 'A1', 'A2', 'B', 'B1']);
    expect(byLabel['A1']!.parentId).toBe(byLabel['A']!.nodeId);
    expect(byLabel['B1']!.parentId).toBe(byLabel['B']!.nodeId);
    expect(byLabel['A']!.parentId).toBeNull();
  });
});
