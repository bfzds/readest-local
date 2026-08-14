import type { Book } from '@/types/book';
import type { DatabaseRow, DatabaseService } from '@/types/database';
import type { AppService } from '@/types/system';
import { foldValue } from '@/utils/containsSearch';

/**
 * Per-book search index/cache: `<Books>/<hash>/search.db`, beside cover.png.
 * Holds the section text extracted by the search pipeline so subsequent
 * searches (any mode, any query) never open the book file, unzip it, or parse
 * section DOMs. The DB travels and dies with the book directory.
 *
 * Bump SEARCH_INDEX_VERSION whenever text extraction or folding changes so
 * stale caches rebuild on the next search.
 */
export const SEARCH_INDEX_VERSION = 1;

// Maximal folding (caseless + diacriticless) with the default locale: any
// occurrence under any stricter search config folds into an occurrence in
// this form, so a LIKE over the folded needle is a superset prefilter for
// contains/whole-words. The production matcher on the original text remains
// the final arbiter of matches and offsets.
const FOLD_OPTIONS = { matchCase: false, matchDiacritics: false };

type IndexAppService = Pick<AppService, 'openDatabase'>;

export interface SearchIndexMeta {
  // 索引构建时的快照时间戳（历史字段）。不再参与新鲜度判定——阅读进度的
  // updatedAt 与文件内容版本分离后，它会被阅读进度不断改写，不能作为内容
  // 版本信号（见 isSearchIndexFresh）。
  updatedAt: number;
  version: number;
  totalSections: number;
  complete: boolean;
  // Hash of the TOC the node tree was built from. The TOC can change without
  // the book file changing (nav.json enrichment via hydrateBookNav, future
  // manual TOC edits), so node freshness is tracked separately from
  // (updatedAt, version).
  navHash: string;
  // Partial MD5 of the book file the index was built from. Content freshness
  // is judged against `book.hash`, which only changes when the file is
  // re-imported as a new version — never on reading progress.
  bookHash: string;
}

export interface SearchIndexSection {
  idx: number;
  label: string;
  text: string;
}

interface MetaRow extends DatabaseRow {
  updated_at: number;
  version: number;
  total_sections: number;
  complete: number;
  nav_hash: string;
  book_hash: string;
}

interface SectionRow extends DatabaseRow {
  idx: number;
  label: string;
  text: string;
}

export const openLibrarySearchDb = (
  appService: IndexAppService,
  book: Book,
): Promise<DatabaseService> =>
  appService.openDatabase('library-search', `${book.hash}/search.db`, 'Books');

export const readSearchIndexMeta = async (db: DatabaseService): Promise<SearchIndexMeta | null> => {
  const rows = await db.select<MetaRow>(
    'SELECT updated_at, version, total_sections, complete, nav_hash, book_hash FROM search_meta WHERE id = 1',
  );
  const row = rows[0];
  if (!row) return null;
  return {
    updatedAt: row.updated_at,
    version: row.version,
    totalSections: row.total_sections,
    complete: row.complete === 1,
    navHash: row.nav_hash,
    bookHash: row.book_hash,
  };
};

// 内容新鲜度以 book.hash（文件 partialMD5）为准：只有重导入新版本时 hash 才
// 变化。此前用 updatedAt === book.updatedAt，而 updateBookProgress 每页进度
// 都把 updatedAt 写成 Date.now()，导致任何读过的书下次搜索必判脏、整本重建。
export const isSearchIndexFresh = (meta: SearchIndexMeta | null, book: Book): boolean =>
  !!meta && meta.complete && meta.version === SEARCH_INDEX_VERSION && meta.bookHash === book.hash;

export const beginSearchIndex = async (
  db: DatabaseService,
  book: Book,
  totalSections: number,
  navHash: string,
): Promise<void> => {
  // B7：清空三表合并为一次原子事务。双窗口并发重建同一 search.db 时，事务性
  // 的批量清空 + completeSearchIndex 的完整性校验，避免交错出半成品索引。
  await db.batch([
    'DELETE FROM search_sections',
    'DELETE FROM search_nodes',
    'DELETE FROM search_meta',
  ]);
  await db.execute(
    'INSERT INTO search_meta (id, updated_at, version, total_sections, complete, nav_hash, book_hash) VALUES (1, ?, ?, ?, 0, ?, ?)',
    [book.updatedAt, SEARCH_INDEX_VERSION, totalSections, navHash, book.hash],
  );
};

// DELETE+INSERT rather than UPDATE: Tantivy-era wasm builds have a known
// UPDATE regression (see reedy migration notes), and rebuilds always replace.
export const writeSearchIndexSection = async (
  db: DatabaseService,
  idx: number,
  label: string,
  text: string,
): Promise<void> => {
  const folded = foldValue(text, FOLD_OPTIONS);
  await db.execute('DELETE FROM search_sections WHERE idx = ?', [idx]);
  await db.execute('INSERT INTO search_sections (idx, label, text, folded) VALUES (?, ?, ?, ?)', [
    idx,
    label,
    text,
    folded === text ? null : folded,
  ]);
};

// Turso is WAL-only (PRAGMA journal_mode = DELETE is ignored) and implements
// no auto-checkpoint (see statisticsDb), so without an explicit checkpoint
// every indexed byte stays in search.db-wal and the main file never grows
// past its 4 KB header. Fold the WAL after the build burst so the data lives
// in search.db, which file-level copy or sync of the book directory sees.
export const checkpointSearchIndex = async (db: DatabaseService): Promise<void> => {
  await db.execute('PRAGMA wal_checkpoint(TRUNCATE)').then(
    () => {},
    () => {},
  );
};

export const completeSearchIndex = async (
  db: DatabaseService,
  totalSections: number,
): Promise<void> => {
  // B7：置 complete 前校验已写 section 数。并发窗口交错写入部分 section 时数量
  // 不匹配，保持 complete=0 让 isSearchIndexFresh 判脏、下次搜索重建——防止把
  // 半成品索引当新鲜索引使用。
  const rows = await db.select<{ c: number }>('SELECT COUNT(*) AS c FROM search_sections');
  if ((rows[0]?.c ?? 0) !== totalSections) return;
  await db.execute('UPDATE search_meta SET complete = 1 WHERE id = 1');
  await checkpointSearchIndex(db);
};

export interface SearchIndexNode {
  nodeId: number;
  parentId: number | null;
  ord: number;
  depth: number;
  label: string;
  sectionStart: number;
  sectionEnd: number;
}

interface TocLikeItem {
  label: string;
  href: string;
  subitems?: TocLikeItem[];
}

// FNV-1a over the structural TOC content (labels, hrefs, nesting). Stable
// across runs; used to detect TOC changes that leave the book file untouched.
export const hashSearchToc = (toc: TocLikeItem[] | undefined): string => {
  let hash = 0x811c9dc5;
  const mix = (value: string) => {
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  const walk = (items: TocLikeItem[]) => {
    for (const item of items) {
      mix(item.label ?? '');
      mix('\u0001');
      mix(item.href ?? '');
      mix('\u0002');
      if (item.subitems?.length) {
        mix('[');
        walk(item.subitems);
        mix(']');
      }
    }
  };
  walk(toc ?? []);
  return hash.toString(16);
};

/**
 * Flatten a book TOC into pre-order node rows with section-level spans: a
 * node spans from its own resolved section to just before the next node at
 * the same or shallower depth. Unresolvable hrefs inherit the preceding
 * node's start so the tree stays contiguous.
 */
export const buildSearchIndexNodes = (
  toc: TocLikeItem[] | undefined,
  resolveSection: (href: string) => number | undefined,
  totalSections: number,
): SearchIndexNode[] => {
  if (!toc?.length || totalSections <= 0) return [];
  const nodes: SearchIndexNode[] = [];
  const walk = (items: TocLikeItem[], parentId: number | null, depth: number) => {
    for (const [ord, item] of items.entries()) {
      const nodeId = nodes.length;
      const resolved = resolveSection(item.href);
      const previousStart = nodes.at(-1)?.sectionStart ?? 0;
      const sectionStart = Math.min(
        Math.max(resolved ?? previousStart, previousStart),
        totalSections - 1,
      );
      nodes.push({
        nodeId,
        parentId,
        ord,
        depth,
        label: item.label ?? '',
        sectionStart,
        sectionEnd: totalSections - 1,
      });
      if (item.subitems?.length) walk(item.subitems, nodeId, depth + 1);
    }
  };
  walk(toc, null, 0);
  // SF1: 单调栈 O(n) 求每个节点右侧第一个 depth <= 自身的节点，用它决定
  // sectionEnd。原朴素双循环 O(n²)，2,000 章 TOC 约 200 万次比较。栈顶的
  // depth 一旦被当前节点（更浅或同级）"盖住"，其 sectionEnd 即由当前节点
  // 的 sectionStart-1 决定，与朴素扫描语义一致。
  const stack: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const currentDepth = nodes[i]!.depth;
    while (stack.length > 0 && nodes[stack[stack.length - 1]!]!.depth >= currentDepth) {
      const prev = stack.pop()!;
      nodes[prev]!.sectionEnd = Math.max(nodes[prev]!.sectionStart, nodes[i]!.sectionStart - 1);
    }
    stack.push(i);
  }
  return nodes;
};

export const writeSearchIndexNodes = async (
  db: DatabaseService,
  nodes: SearchIndexNode[],
): Promise<void> => {
  await db.execute('DELETE FROM search_nodes');
  for (const node of nodes) {
    await db.execute(
      'INSERT INTO search_nodes (node_id, parent_id, ord, depth, label, section_start, section_end) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        node.nodeId,
        node.parentId,
        node.ord,
        node.depth,
        node.label,
        node.sectionStart,
        node.sectionEnd,
      ],
    );
  }
};

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

// SF13: LIKE 预筛候选上限，防止单字中文查询命中全部 section 时全量载入+扫描。
// 结果上限（每本 500 / 全局 2000）本就会截断超限产出，故候选 LIMIT 不额外丢
// 匹配；>2000 节的书罕见。
const SEARCH_CANDIDATE_LIMIT = 2000;

export const loadSearchIndexSections = (db: DatabaseService): Promise<SearchIndexSection[]> =>
  db.select<SectionRow>('SELECT idx, label, text FROM search_sections ORDER BY idx');

/**
 * Superset prefilter for contains/whole-words: sections whose folded text
 * contains the folded needle. Sections skipped here cannot match under any
 * config; sections returned still go through the exact matcher.
 */
export const loadSearchIndexCandidates = (
  db: DatabaseService,
  query: string,
): Promise<SearchIndexSection[]> => {
  const folded = foldValue(query, FOLD_OPTIONS);
  if (!folded) return loadSearchIndexSections(db);
  return db.select<SectionRow>(
    `SELECT idx, label, text FROM search_sections WHERE COALESCE(folded, text) LIKE ? ESCAPE '\\' ORDER BY idx LIMIT ${SEARCH_CANDIDATE_LIMIT}`,
    [`%${escapeLike(folded)}%`],
  );
};
