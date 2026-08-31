import { DocumentLoader, type BookDoc } from '@/libs/document';
import type {
  Book,
  LibrarySearchConfig,
  LibrarySearchMatch,
  LibrarySearchSectionResult,
  SearchExcerpt,
  SearchResultLocator,
} from '@/types/book';
import type { DatabaseService } from '@/types/database';
import type { AppService } from '@/types/system';
import type { ClosableFile } from '@/utils/file';
import { findContainsMatches } from '@/utils/containsSearch';
import { findFuzzyMatches, MAX_FUZZY_QUERY_LENGTH } from '@/utils/fuzzySearch';
import type { LibrarySearchWorkerMatch } from '@/utils/librarySearchWorkerProtocol';
import { findNearbyMatches } from '@/utils/nearbySearch';
import { createRejectFilter } from '@/utils/node';
import { compileSearchRegex, filterWholeWordMatches, findRegexMatches } from '@/utils/textSearch';
import { perfMark } from '@/utils/perf';
import { BookFileNotFoundError } from './errors';
import {
  beginSearchIndex,
  buildSearchIndexNodes,
  checkpointSearchIndex,
  completeSearchIndex,
  hashSearchToc,
  isSearchIndexFresh,
  loadSearchIndexCandidates,
  loadSearchIndexSections,
  openLibrarySearchDb,
  readSearchIndexMeta,
  writeSearchIndexNodes,
  writeSearchIndexSections,
  type SearchIndexSection,
} from './librarySearchIndex';
import { hydrateBookNav, isBookNavCacheCurrent, type BookNav } from './nav';
import { createLibrarySearchWorker } from './librarySearchWorker';
import { releaseSearchBuildLock, tryAcquireSearchBuildLock } from './searchIndexLock';
import * as CFI from 'foliate-js/epubcfi.js';
import { TOCProgress } from 'foliate-js/progress.js';

type LibrarySearchAppService = Pick<
  AppService,
  | 'databaseExists'
  | 'deleteDatabase'
  | 'getBookFileSize'
  | 'loadBookContent'
  | 'resolveNativeBookFilePath'
  | 'loadBookNav'
  | 'openDatabase'
  | 'createDir'
  | 'stats'
  | 'deleteDir'
>;

// The nav the reader shows (nav.json enrichment applied via hydrateBookNav),
// or null when no current cached nav exists for the book.
const loadCurrentNav = async (
  appService: LibrarySearchAppService,
  book: Book,
): Promise<BookNav | null> => {
  try {
    const nav = await appService.loadBookNav(book);
    return isBookNavCacheCurrent(nav) ? nav : null;
  } catch {
    return null;
  }
};

type SearchableBookDoc = BookDoc & {
  destroy?: () => void | Promise<void>;
  getTOCFragment?: (doc: Document, fragment: string) => Element | null;
};

export type LibrarySearchEvent =
  | { type: 'book-started'; book: Book; bookIndex: number; totalBooks: number }
  | {
      type: 'progress';
      book: Book;
      bookProgress: number;
      progress: number;
      sectionsCompleted: number;
      totalSections: number;
    }
  | { type: 'result'; book: Book; result: LibrarySearchSectionResult }
  | { type: 'book-completed'; book: Book; matchCount: number; truncated?: boolean }
  | { type: 'book-skipped'; book: Book; reason: 'unavailable' | 'index-building' }
  | { type: 'book-error'; book: Book; error: string; code?: string }
  | {
      type: 'completed';
      searchedBooks: number;
      skippedBooks: number;
      erroredBooks: number;
      matchCount: number;
      truncated?: boolean;
    };

export interface LibrarySearchOptions {
  config?: Partial<LibrarySearchConfig>;
  signal?: AbortSignal;
  session?: LibrarySearchSession;
  // Restrict matching to one section (reader "current chapter" scope). Index
  // population is never restricted: a live scan still writes every section.
  sectionIndex?: number;
}

const DEFAULT_CONFIG: LibrarySearchConfig = {
  scope: 'book',
  mode: 'contains',
  matchCase: false,
  matchDiacritics: false,
  nearbyWords: 10,
};

const CONTEXT_LENGTH = 50;
const CONTEXT_SCAN_CHUNK = 2048;
const MAX_BOOK_SEARCH_RESULTS = 500;
// 全局结果上限：每本最多 500 条已存在，但千本共搜可累积数十万条进 state/
// 渲染。超出后停止产出新结果（索引仍继续构建到完整），避免内存与渲染爆炸。
const MAX_TOTAL_SEARCH_RESULTS = 2000;
const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ');

const contextStart = (value: string) => {
  let end = Math.min(CONTEXT_LENGTH, value.length);
  const last = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  return value.slice(0, end);
};

const contextEnd = (value: string) => {
  let start = Math.max(0, value.length - CONTEXT_LENGTH);
  const first = value.charCodeAt(start);
  const previous = value.charCodeAt(start - 1);
  if (first >= 0xdc00 && first <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) start++;
  return value.slice(start);
};

const makeContext = (text: string, offset: number, direction: 'before' | 'after') => {
  if (direction === 'before') {
    let cursor = offset;
    let normalized = '';
    while (cursor > 0 && normalized.trimStart().length < CONTEXT_LENGTH) {
      let start = Math.max(0, cursor - CONTEXT_SCAN_CHUNK);
      const first = text.charCodeAt(start);
      const previous = text.charCodeAt(start - 1);
      if (
        start > 0 &&
        first >= 0xdc00 &&
        first <= 0xdfff &&
        previous >= 0xd800 &&
        previous <= 0xdbff
      ) {
        start--;
      }
      normalized = normalizeWhitespace(text.slice(start, cursor) + normalized);
      cursor = start;
    }
    const value = normalized.trimStart();
    return `${cursor > 0 || value.length >= CONTEXT_LENGTH ? '…' : ''}${contextEnd(value)}`;
  }
  let cursor = offset;
  let normalized = '';
  while (cursor < text.length && normalized.trimEnd().length < CONTEXT_LENGTH) {
    let end = Math.min(text.length, cursor + CONTEXT_SCAN_CHUNK);
    const last = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      end++;
    }
    normalized = normalizeWhitespace(normalized + text.slice(cursor, end));
    cursor = end;
  }
  const value = normalized.trimEnd();
  return `${contextStart(value)}${cursor < text.length || value.length >= CONTEXT_LENGTH ? '…' : ''}`;
};

const findNodeOffset = (cumulative: number[], offset: number, bias: 'left' | 'right') => {
  let low = 0;
  let high = cumulative.length - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (cumulative[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  if (bias === 'left') {
    while (low > 0 && cumulative[low] === offset) low--;
  }
  return { index: low, offset: offset - cumulative[low]! };
};

const makeExcerpt = (text: string, start: number, end: number): SearchExcerpt => {
  return {
    pre: makeContext(text, start, 'before'),
    match: text.slice(start, end),
    post: makeContext(text, end, 'after'),
  };
};

const makeFuzzyExcerpt = (
  text: string,
  start: number,
  end: number,
  runs: Array<{ start: number; end: number }>,
): SearchExcerpt => {
  const segments: NonNullable<SearchExcerpt['segments']> = [];
  let cursor = start;
  for (const run of runs) {
    if (run.start > cursor) {
      segments.push({ text: text.slice(cursor, run.start), emphasized: false });
    }
    segments.push({ text: text.slice(run.start, run.end), emphasized: true });
    cursor = run.end;
  }
  return {
    pre: makeContext(text, start, 'before'),
    match: text.slice(start, end),
    post: makeContext(text, end, 'after'),
    segments,
  };
};

// foliate's text-walker reads NodeFilter at module scope, which only exists
// in browsers; the reader and library pages import this service statically,
// so Next.js would evaluate that global while collecting page data on the
// server. Load the walker lazily instead — every caller of
// prepareSearchSection awaits loadTextWalker() first.
type TextWalker = typeof import('foliate-js/text-walker.js')['textWalker'];
let textWalker: TextWalker | null = null;
const loadTextWalker = async (): Promise<TextWalker> =>
  (textWalker ??= (await import('foliate-js/text-walker.js')).textWalker);

interface PreparedSearchSection {
  key: string;
  text: string;
  cumulative: number[];
  makeRange: (...args: number[]) => Range;
}

const prepareSearchSection = (
  key: string,
  doc: Document,
  acceptNode: (node: Node) => number,
): PreparedSearchSection => {
  let prepared: PreparedSearchSection | null = null;
  if (!textWalker) throw new Error('text walker not loaded');
  Array.from(
    textWalker(
      doc,
      (strings: string[], makeRange: (...args: number[]) => Range) => {
        const text = strings.join('');
        const cumulative = [0];
        for (const value of strings) cumulative.push(cumulative.at(-1)! + value.length);
        prepared = { key, text, cumulative, makeRange };
        return [];
      },
      acceptNode,
    ),
  );
  if (!prepared) throw new Error('Unable to prepare book section for search');
  return prepared;
};

const createTOCProgress = async (book: SearchableBookDoc) => {
  if (!book.splitTOCHref || !book.getTOCFragment) return null;
  const progress = new TOCProgress();
  await progress.init({
    toc: book.toc ?? [],
    ids: book.sections.map(({ id }) => id),
    splitHref: book.splitTOCHref.bind(book),
    getFragment: book.getTOCFragment.bind(book),
  });
  return progress;
};

const closeBook = async (book: SearchableBookDoc | null, file: File | null) => {
  try {
    await book?.destroy?.();
  } finally {
    const closableFile = file as ClosableFile | null;
    if (closableFile?.close) await closableFile.close();
  }
};

const makeAcceptNode = (book: Book) =>
  createRejectFilter({
    tags: book.primaryLanguage?.startsWith('ja') ? ['rt'] : [],
    attributes: ['cfi-inert'],
  });

interface CachedSearchBook {
  file: File;
  bookDoc: SearchableBookDoc;
}

const MAX_CACHED_BOOKS = 10;
const MAX_OPEN_INDEX_DBS = 16;
// SF2：节写入攒批大小。每 100 节一次 batch，500 节从 ~1,000 次 execute IPC
// 往返降到 ~5 次；批次过大单条 SQL 字符串过长，适中即可。
const SECTION_WRITE_BATCH_SIZE = 100;
// 一次投递给搜索 worker 的节数上限：整书节数 ~2000 时往返从逐节 2000 次
// 降到 ~20 次，同时避免单消息过大（每节文本 ~50KB 结构化克隆）。
const SEARCH_WORKER_BATCH_SIZE = 100;

export const createLibrarySearchSession = (appService: LibrarySearchAppService) => {
  const documents = new Map<string, { bookHash: string; pending: Promise<CachedSearchBook> }>();
  // One handle per search.db within the session: OPFS permits a single access
  // handle per file per origin, so concurrent opens of the same DB would throw.
  const indexDbs = new Map<string, Promise<DatabaseService | null>>();
  // Memoized per session: the hash of each book's current cached nav toc
  // (null when no current nav exists), used to detect stale node trees
  // without re-reading nav.json on every query.
  const navHashes = new Map<string, Promise<string | null>>();
  const searchWorker = createLibrarySearchWorker();

  const dispose = ({ pending }: { pending: Promise<CachedSearchBook> }) => {
    void pending.then(
      ({ bookDoc, file }) => closeBook(bookDoc, file),
      () => {},
    );
  };

  const open = (book: Book) => {
    const existing = documents.get(book.hash);
    // 缓存按内容版本（book.hash）判失效。进度更新会改写 book.updatedAt，把它
    // 当版本键会让"读过的书"在下次搜索时重新解析整本（B1 同根因）。
    if (existing?.bookHash === book.hash) {
      documents.delete(book.hash);
      documents.set(book.hash, existing);
      return existing.pending;
    }
    if (existing) dispose(existing);

    const pending = (async () => {
      const [content, nativeFilePath] = await Promise.all([
        appService.loadBookContent(book),
        appService.resolveNativeBookFilePath(book),
      ]);
      try {
        const bookDoc = (
          await new DocumentLoader(content.file, {
            nativeFilePath: nativeFilePath ?? undefined,
          }).open()
        ).book as SearchableBookDoc;
        return { file: content.file, bookDoc };
      } catch (error) {
        await closeBook(null, content.file);
        throw error;
      }
    })();
    const entry = { bookHash: book.hash, pending };
    documents.set(book.hash, entry);
    void pending.catch(() => {
      if (documents.get(book.hash) === entry) documents.delete(book.hash);
    });

    if (documents.size > MAX_CACHED_BOOKS) {
      const oldestHash = documents.keys().next().value!;
      const oldest = documents.get(oldestHash)!;
      documents.delete(oldestHash);
      dispose(oldest);
    }
    return pending;
  };

  // B14：长驻 session（库页搜索 UI 保持打开）期间 turso 无 auto-checkpoint，
  // search.db-wal 只会在 close() 时折叠。惰性定期 checkpoint 打开的库，防止
  // -wal 侧车文件无限增长、书目录的文件级拷贝/同步漏数据。幂等、不阻塞。
  let lastWalCheckpointAt = 0;
  const WAL_CHECKPOINT_INTERVAL_MS = 30_000;
  const checkpointOpenDbs = () => {
    const dbs = [...indexDbs.values()];
    void Promise.all(
      dbs.map((pending) => pending.then((db) => db && checkpointSearchIndex(db)).catch(() => {})),
    );
  };

  const getIndexDb = (book: Book): Promise<DatabaseService | null> => {
    if (Date.now() - lastWalCheckpointAt >= WAL_CHECKPOINT_INTERVAL_MS) {
      lastWalCheckpointAt = Date.now();
      checkpointOpenDbs();
    }
    const existing = indexDbs.get(book.hash);
    if (existing) {
      indexDbs.delete(book.hash);
      indexDbs.set(book.hash, existing);
      return existing;
    }
    const pending = openLibrarySearchDb(appService, book).catch(() => null);
    indexDbs.set(book.hash, pending);
    while (indexDbs.size > MAX_OPEN_INDEX_DBS) {
      const oldestHash = indexDbs.keys().next().value!;
      const oldest = indexDbs.get(oldestHash)!;
      indexDbs.delete(oldestHash);
      void oldest.then((db) => db?.close()).catch(() => {});
    }
    return pending;
  };

  const getNavHash = (book: Book): Promise<string | null> => {
    const existing = navHashes.get(book.hash);
    if (existing) return existing;
    const pending = loadCurrentNav(appService, book).then((nav) =>
      nav ? hashSearchToc(nav.toc) : null,
    );
    navHashes.set(book.hash, pending);
    return pending;
  };

  const dropIndexDb = (book: Book) => {
    const pending = indexDbs.get(book.hash);
    if (!pending) return;
    indexDbs.delete(book.hash);
    void pending.then((db) => db?.close()).catch(() => {});
  };

  return {
    open,
    getIndexDb,
    dropIndexDb,
    getNavHash,
    searchWorker,
    async close() {
      const cachedBooks = [...documents.values()];
      const cachedDbs = [...indexDbs.values()];
      documents.clear();
      indexDbs.clear();
      searchWorker.close();
      await Promise.all([
        ...cachedBooks.map(({ pending }) =>
          pending.then(
            ({ bookDoc, file }) => closeBook(bookDoc, file),
            () => {},
          ),
        ),
        // Checkpoint before close so aborted or failed builds don't leave
        // their writes stranded in the wal (completeSearchIndex handles the
        // successful-build case).
        ...cachedDbs.map((pending) =>
          pending
            .then(async (db) => {
              if (!db) return;
              await checkpointSearchIndex(db);
              await db.close();
            })
            .catch(() => {}),
        ),
      ]);
    },
  };
};

export type LibrarySearchSession = ReturnType<typeof createLibrarySearchSession>;

interface SectionMatchOutcome {
  matches: LibrarySearchWorkerMatch[];
  truncated: boolean;
}

const toSubitems = (
  mode: LibrarySearchConfig['mode'],
  sectionIndex: number,
  text: string,
  matches: LibrarySearchWorkerMatch[],
): LibrarySearchMatch[] =>
  matches.map((match) => {
    const locator: SearchResultLocator = {
      section: sectionIndex,
      start: match.start,
      end: match.end,
      ...(match.runs.length ? { runs: match.runs } : {}),
    };
    if (!match.runs.length) {
      return { locator, excerpt: makeExcerpt(text, match.start, match.end) };
    }
    const excerpt = makeFuzzyExcerpt(text, match.start, match.end, match.runs);
    if (mode === 'nearby-words' && excerpt.segments) {
      excerpt.match = normalizeWhitespace(excerpt.match);
      excerpt.segments = excerpt.segments
        .map((segment) => ({ ...segment, text: normalizeWhitespace(segment.text) }))
        .filter(({ text: segmentText }) => segmentText.length > 0);
    }
    return { locator, excerpt };
  });

export async function* searchLibraryBooks(
  appService: LibrarySearchAppService,
  books: Book[],
  query: string,
  options: LibrarySearchOptions = {},
): AsyncGenerator<LibrarySearchEvent> {
  const config: LibrarySearchConfig = { ...DEFAULT_CONFIG, ...options.config, scope: 'book' };
  const { signal } = options;
  let searchedBooks = 0;
  let skippedBooks = 0;
  let erroredBooks = 0;
  let totalMatches = 0;
  let truncated = false;
  let sliceStarted = performance.now();

  if (books.length === 0) {
    yield {
      type: 'completed',
      searchedBooks: 0,
      skippedBooks: 0,
      erroredBooks: 0,
      matchCount: 0,
    };
    return;
  }

  if (config.mode === 'nearby-words' && query.trim().split(/\s+/).filter(Boolean).length < 2) {
    yield {
      type: 'book-error',
      book: books[0]!,
      error: 'Nearby words search needs at least two words',
      code: 'NEARBY_NEEDS_TWO_WORDS',
    };
    return;
  }
  if (
    config.mode === 'fuzzy' &&
    Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(query.trim()))
      .length > MAX_FUZZY_QUERY_LENGTH
  ) {
    yield {
      type: 'book-error',
      book: books[0]!,
      error: `Fuzzy search query cannot exceed ${MAX_FUZZY_QUERY_LENGTH} characters`,
      code: 'FUZZY_QUERY_TOO_LONG',
    };
    return;
  }
  let searchRegex: RegExp | null = null;
  if (config.mode === 'regex') {
    try {
      searchRegex = compileSearchRegex(query, config.matchCase);
    } catch (error) {
      yield {
        type: 'book-error',
        book: books[0]!,
        error: error instanceof Error ? error.message : String(error),
        code: 'INVALID_REGEX',
      };
      return;
    }
  }

  const usesSearchWorker = config.mode === 'fuzzy' || config.mode === 'nearby-words';

  // 每本书的匹配统计：被 matchSectionsBatch（函数顶层）与书循环共用，
  // 故提升到顶层，每次书循环开头重置。
  let bookMatches = 0;
  let bookTruncated = false;

  const matchSectionText = async (
    book: Book,
    sectionIndex: number,
    text: string,
    locale: string,
    limit: number,
  ): Promise<SectionMatchOutcome> => {
    if (usesSearchWorker) {
      const payload = {
        sectionKey: `${book.hash}:${sectionIndex}`,
        text,
        query,
        mode: config.mode as 'fuzzy' | 'nearby-words',
        fuzzyOptions: {
          matchCase: config.matchCase,
          matchDiacritics: config.matchDiacritics,
        },
        nearbyOptions: {
          locale,
          matchCase: config.matchCase,
          matchDiacritics: config.matchDiacritics,
          nearbyWords: config.nearbyWords ?? DEFAULT_CONFIG.nearbyWords!,
        },
        limit,
      };
      if (options.session) {
        return await options.session.searchWorker.search(payload, signal);
      }
      const state: { truncated?: boolean } = {};
      const matches =
        config.mode === 'fuzzy'
          ? findFuzzyMatches(text, query, payload.fuzzyOptions, limit, state)
          : findNearbyMatches(text, query, payload.nearbyOptions, undefined, limit, state);
      return { matches, truncated: Boolean(state.truncated) };
    }

    let spans: Array<{ start: number; end: number }>;
    if (config.mode === 'regex') {
      spans = findRegexMatches(text, searchRegex!, limit);
    } else {
      spans = [];
      for (const match of findContainsMatches(text, query, config, locale)) {
        spans.push(match);
        // Whole-words filters after collection, so don't stop at the raw cap.
        if (config.mode !== 'whole-words' && spans.length >= limit) break;
      }
      if (config.mode === 'whole-words') {
        spans = filterWholeWordMatches(text, spans, locale).slice(0, limit);
      }
    }
    return {
      matches: spans.map(({ start, end }) => ({ start, end, runs: [] })),
      truncated: spans.length >= limit,
    };
  };

  // fuzzy/nearby（worker 模式）整批一次投递，替代逐节 postMessage 往返。
  // 预算分两层：worker 端 `budget` 共享预算是第一层限制（批内递减、用尽即停），
  // service 端逐 section 合并前重算 remaining 做最终硬截断；任何 worker 超发
  // 都不能让单本/全库结果越界。节内 truncated 只代表该节端点，不中断后续节。
  const matchSectionsBatch = async (
    book: Book,
    batch: Array<{ sectionIndex: number; text: string; locale: string }>,
  ): Promise<SectionMatchOutcome[]> => {
    if (!usesSearchWorker) {
      const outcomes: SectionMatchOutcome[] = [];
      for (const section of batch) {
        const remaining = Math.min(
          MAX_BOOK_SEARCH_RESULTS - bookMatches,
          MAX_TOTAL_SEARCH_RESULTS - totalMatches,
        );
        outcomes.push(
          remaining <= 0
            ? { matches: [], truncated: true }
            : await matchSectionText(
                book,
                section.sectionIndex,
                section.text,
                section.locale,
                remaining,
              ),
        );
      }
      return outcomes;
    }
    const remaining = Math.min(
      MAX_BOOK_SEARCH_RESULTS - bookMatches,
      MAX_TOTAL_SEARCH_RESULTS - totalMatches,
    );
    if (remaining <= 0) return batch.map(() => ({ matches: [], truncated: true }));
    const sharedPayload = {
      query,
      mode: config.mode as 'fuzzy' | 'nearby-words',
      fuzzyOptions: {
        matchCase: config.matchCase,
        matchDiacritics: config.matchDiacritics,
      },
      nearbyOptions: {
        locale: batch[0]!.locale,
        matchCase: config.matchCase,
        matchDiacritics: config.matchDiacritics,
        nearbyWords: config.nearbyWords ?? DEFAULT_CONFIG.nearbyWords!,
      },
    };
    // 节间 locale 不一致（live 提取路径按文档 lang 逐节取）或无 session 时
    // 退化为逐节跑同一算法库（结果与 worker 一致），保持 nearby 分词语义。
    const singleLocale = new Set(batch.map((section) => section.locale)).size === 1;
    if (!singleLocale || !options.session) {
      const outcomes: SectionMatchOutcome[] = [];
      // P-4：主线程 fallback 也用共享预算递减，预算用尽即停。
      let budgetLeft = remaining;
      for (const section of batch) {
        if (signal?.aborted) return [];
        if (budgetLeft <= 0) break;
        const state: { truncated?: boolean } = {};
        const matches =
          config.mode === 'fuzzy'
            ? findFuzzyMatches(section.text, query, sharedPayload.fuzzyOptions, budgetLeft, state)
            : findNearbyMatches(
                section.text,
                query,
                sharedPayload.nearbyOptions,
                undefined,
                budgetLeft,
                state,
              );
        outcomes.push({ matches, truncated: Boolean(state.truncated) });
        budgetLeft -= matches.length;
      }
      return outcomes;
    }
    const articles = batch.map((section) => ({
      sectionKey: `${book.hash}:${section.sectionIndex}`,
      text: section.text,
      limit: remaining,
    }));
    const sections = await options.session.searchWorker.searchBatch(
      articles,
      sharedPayload,
      signal,
      remaining,
    );
    return sections.map((result) => ({ matches: result.matches, truncated: result.truncated }));
  };

  const yieldSlice = async () => {
    if (performance.now() - sliceStarted >= 8) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStarted = performance.now();
    }
  };

  for (const [bookIndex, book] of books.entries()) {
    if (signal?.aborted) return;
    let file: File | null = null;
    let bookDoc: SearchableBookDoc | null = null;
    let indexDb: DatabaseService | null = null;
    const ownsIndexDb = !options.session;
    // SF3：跨窗口互斥。拿到锁的窗口独占重建，拿不到的跳过本书（另一窗口
    // 在重建同一 search.db），避免双窗口各做一遍完整重建。
    let buildLockHeld = false;
    try {
      yield { type: 'book-started', book, bookIndex, totalBooks: books.length };
      const locale = book.primaryLanguage || 'en';

      // Opening (and thereby creating) a search.db is not free, so probe
      // cheaply first: a book with neither a local file nor an existing index
      // is skipped without touching the database layer at all.
      const localSize = await appService.getBookFileSize(book).catch(() => null);
      if (localSize == null) {
        const hasIndex = await appService
          .databaseExists(`${book.hash}/search.db`, 'Books')
          .catch(() => false);
        if (!hasIndex) {
          skippedBooks++;
          yield { type: 'book-skipped', book, reason: 'unavailable' };
          continue;
        }
      }

      indexDb = options.session
        ? await options.session.getIndexDb(book)
        : await openLibrarySearchDb(appService, book).catch(() => null);
      const meta = indexDb ? await readSearchIndexMeta(indexDb).catch(() => null) : null;

      // Node trees follow the nav the reader shows (hydrateBookNav), which
      // can change without touching the book file — manual TOC edits or
      // recomputed nav.json enrichment. A nav hash mismatch invalidates the
      // index like a book update does; with no current nav the TOC can only
      // change with the file, so the stored tree stands.
      const currentNavHash = options.session
        ? await options.session.getNavHash(book)
        : await loadCurrentNav(appService, book).then((nav) =>
            nav ? hashSearchToc(nav.toc) : null,
          );
      const nodesFresh = currentNavHash == null || currentNavHash === meta?.navHash;

      bookMatches = 0;
      bookTruncated = false;

      if (indexDb && isSearchIndexFresh(meta, book) && nodesFresh) {
        // Indexed path: search cached text; the book file is never opened.
        perfMark('search', 'bookFresh.hit');
        const usePrefilter = config.mode === 'contains' || config.mode === 'whole-words';
        let sections: SearchIndexSection[] = usePrefilter
          ? await loadSearchIndexCandidates(indexDb, query)
          : await loadSearchIndexSections(indexDb);
        if (options.sectionIndex != null) {
          sections = sections.filter((section) => section.idx === options.sectionIndex);
        }
        if (signal?.aborted) return;
        const totalSections = meta!.totalSections;
        for (let offset = 0; offset < sections.length; offset += SEARCH_WORKER_BATCH_SIZE) {
          if (signal?.aborted) return;
          // 批次起点快速退出检查；真正的逐 section 预算在内层循环合并前重算。
          const batchRemaining = Math.min(
            MAX_BOOK_SEARCH_RESULTS - bookMatches,
            MAX_TOTAL_SEARCH_RESULTS - totalMatches,
          );
          if (batchRemaining <= 0) {
            bookTruncated = true;
            break;
          }
          const batch = sections.slice(offset, offset + SEARCH_WORKER_BATCH_SIZE);
          const outcomes = await matchSectionsBatch(
            book,
            batch.map((section) => ({
              sectionIndex: section.idx,
              text: section.text,
              locale,
            })),
          );
          for (let i = 0; i < batch.length; i++) {
            if (signal?.aborted) return;
            const section = batch[i]!;
            const outcome = outcomes[i]!;
            // Task1：每节合并前重算剩余预算 —— worker 共享预算是第一层限制，
            // service 逐 section 重算是最终硬边界；预算耗尽才中断循环。
            const remaining = Math.min(
              MAX_BOOK_SEARCH_RESULTS - bookMatches,
              MAX_TOTAL_SEARCH_RESULTS - totalMatches,
            );
            if (remaining <= 0) {
              bookTruncated = true;
              break;
            }
            // 节内 truncated 表示该节还有更多匹配未采（独立于预算耗尽）。
            // 末节恰填满预算且无下一节时会漏掉 remaining<=0 触发，必须在此
            // 消费 outcome.truncated 保住"可能还有更多"的最终标记。仅置位，
            // 不 break：后续节仍可继续填满预算。
            if (outcome.truncated) bookTruncated = true;
            const capped = outcome.matches.slice(0, remaining);
            if (capped.length) {
              const subitems = toSubitems(config.mode, section.idx, section.text, capped);
              bookMatches += subitems.length;
              totalMatches += subitems.length;
              yield {
                type: 'result',
                book,
                result: { index: section.idx, label: section.label, subitems },
              };
            }
            await yieldSlice();
          }
          if (bookTruncated) break;
        }
        yield {
          type: 'progress',
          book,
          bookProgress: 1,
          progress: (bookIndex + 1) / books.length,
          sectionsCompleted: totalSections,
          totalSections,
        };
      } else if (localSize == null) {
        // A stale or incomplete index and no local file to rescan from: the
        // db is a useless artifact that would cost a full database open on
        // every future search, so delete it and skip.
        if (indexDb) {
          if (options.session) options.session.dropIndexDb(book);
          else {
            await indexDb.close().catch(() => {});
            indexDb = null;
          }
          await appService.deleteDatabase(`${book.hash}/search.db`, 'Books').catch(() => {});
        }
        skippedBooks++;
        yield { type: 'book-skipped', book, reason: 'unavailable' };
        continue;
      } else {
        // Live path: extract text section by section, persist it to the
        // per-book index, and match the same extracted text.
        // SF3：重建前抢跨窗口锁。拿不到说明另一窗口正在重建同一本书，
        // 本次跳过这本书（不重复建索引），后续搜索等它建完即命中。
        buildLockHeld = await tryAcquireSearchBuildLock(appService, book.hash);
        if (!buildLockHeld) {
          skippedBooks++;
          yield { type: 'book-skipped', book, reason: 'index-building' };
          continue;
        }
        // 埋点：重建全流程（open→extract→write→match）计时，供验证 B1 后
        // "读过的书不应重建"是否成立。
        const rebuildT0 = perfMark('search', 'bookFresh.rebuild.start');
        if (options.session) {
          const cached = await options.session.open(book);
          file = cached.file;
          bookDoc = cached.bookDoc;
        } else {
          const [content, nativeFilePath] = await Promise.all([
            appService.loadBookContent(book),
            appService.resolveNativeBookFilePath(book),
          ]);
          file = content.file;
          bookDoc = (
            await new DocumentLoader(file, { nativeFilePath: nativeFilePath ?? undefined }).open()
          ).book as SearchableBookDoc;
        }
        if (signal?.aborted) return;
        perfMark('search', 'index.open', rebuildT0);

        const nav = await loadCurrentNav(appService, book);
        if (nav) {
          try {
            hydrateBookNav(bookDoc, nav);
          } catch {
            // Keep the raw toc when hydration fails.
          }
        }
        const usedNavHash = nav ? hashSearchToc(nav.toc) : '';
        await loadTextWalker();
        const acceptNode = makeAcceptNode(book);
        const tocProgress = await createTOCProgress(bookDoc);
        const totalSections = bookDoc.sections.length;
        if (indexDb) {
          await beginSearchIndex(indexDb, book, totalSections, usedNavHash).catch(() => {
            indexDb = null;
          });
        }
        let indexComplete = true;
        if (indexDb) {
          const doc = bookDoc;
          const idToIndex = new Map(
            doc.sections.map((section, index) => [String(section.id), index]),
          );
          const resolveSection = (href: string) => {
            const id = doc.splitTOCHref?.(href)?.[0];
            return id == null ? undefined : idToIndex.get(String(id));
          };
          const nodes = buildSearchIndexNodes(doc.toc, resolveSection, totalSections);
          await writeSearchIndexNodes(indexDb, nodes).catch(() => {
            indexComplete = false;
          });
        }

        // SF2：批量写节。逐节提取（document creation 是主要开销）不变，但
        // 写库攒批，每 100 节一次 batch，替代逐节 2 次 execute 的 IPC 往返。
        const sectionWriteBatch: SearchIndexSection[] = [];
        const flushSectionBatch = async () => {
          if (sectionWriteBatch.length === 0) return;
          const batch = sectionWriteBatch.splice(0);
          await writeSearchIndexSections(indexDb!, batch).catch(() => {
            indexComplete = false;
          });
        };
        // fuzzy/nearby 匹配同样攒批，与写库共用同一提取循环（P-4）。yield
        // 必须留在 generator 主函数体，故这里只计算并返回待 yield 的结果项。
        const liveMatchBatch: Array<{
          sectionIndex: number;
          text: string;
          locale: string;
          label: string;
        }> = [];
        const consumeMatchBatch = async (): Promise<
          Array<{ index: number; label: string; subitems: LibrarySearchMatch[] }>
        > => {
          if (liveMatchBatch.length === 0) return [];
          const batch = liveMatchBatch.splice(0);
          const outcomes = await matchSectionsBatch(book, batch);
          if (signal?.aborted) return [];
          const items: Array<{
            index: number;
            label: string;
            subitems: LibrarySearchMatch[];
          }> = [];
          for (let i = 0; i < batch.length; i++) {
            if (signal?.aborted) return [];
            const section = batch[i]!;
            const outcome = outcomes[i]!;
            if (outcome.truncated) bookTruncated = true;
            // Task5：live 汇总同样按当前剩余预算硬截断。
            const remainingNow = Math.min(
              MAX_BOOK_SEARCH_RESULTS - bookMatches,
              MAX_TOTAL_SEARCH_RESULTS - totalMatches,
            );
            const capped = remainingNow > 0 ? outcome.matches.slice(0, remainingNow) : [];
            if (capped.length) {
              const subitems = toSubitems(config.mode, section.sectionIndex, section.text, capped);
              bookMatches += subitems.length;
              totalMatches += subitems.length;
              items.push({
                index: section.sectionIndex,
                label: section.label,
                subitems,
              });
            }
            if (
              bookMatches >= MAX_BOOK_SEARCH_RESULTS ||
              totalMatches >= MAX_TOTAL_SEARCH_RESULTS
            ) {
              bookTruncated = true;
              break;
            }
          }
          return items;
        };
        try {
          for (const [sectionIndex, section] of bookDoc.sections.entries()) {
            if (signal?.aborted) return;
            if (typeof section.createDocument === 'function') {
              const doc = await section.createDocument();
              if (signal?.aborted) return;
              if (doc) {
                const prepared = prepareSearchSection(
                  `${book.hash}:${sectionIndex}`,
                  doc,
                  acceptNode,
                );
                const sectionLocale = doc.body?.lang || doc.documentElement?.lang || locale;
                const label = tocProgress?.getProgress(sectionIndex, null)?.label ?? '';
                if (indexDb) {
                  sectionWriteBatch.push({ idx: sectionIndex, label, text: prepared.text });
                  if (sectionWriteBatch.length >= SECTION_WRITE_BATCH_SIZE) {
                    await flushSectionBatch();
                  }
                }
                const remaining = Math.min(
                  MAX_BOOK_SEARCH_RESULTS - bookMatches,
                  MAX_TOTAL_SEARCH_RESULTS - totalMatches,
                );
                if (options.sectionIndex != null && options.sectionIndex !== sectionIndex) {
                  // Scoped search: this section is only extracted for the index.
                } else if (remaining <= 0) {
                  bookTruncated = true;
                } else {
                  liveMatchBatch.push({
                    sectionIndex,
                    text: prepared.text,
                    locale: sectionLocale,
                    label,
                  });
                  if (liveMatchBatch.length >= SEARCH_WORKER_BATCH_SIZE) {
                    for (const item of await consumeMatchBatch()) {
                      yield { type: 'result', book, result: item };
                    }
                  }
                }
              }
            }
            if (signal?.aborted) return;
            const sectionsCompleted = sectionIndex + 1;
            const bookProgress = totalSections ? sectionsCompleted / totalSections : 1;
            yield {
              type: 'progress',
              book,
              bookProgress,
              progress: (bookIndex + bookProgress) / books.length,
              sectionsCompleted,
              totalSections,
            };
            // Keep indexing the remaining sections even after the result cap so
            // the cache ends complete; only the matcher work is skipped.
            await yieldSlice();
          }
          await flushSectionBatch();
          for (const item of await consumeMatchBatch()) {
            yield { type: 'result', book, result: item };
          }
        } catch (error) {
          // 提取中途出错（createDocument 等）：先 flush 已攒批再抛出，保住
          // 错误前已匹配的结果，维持"结果先于错误"的流式顺序。
          if (indexDb) await flushSectionBatch().catch(() => {});
          for (const item of await consumeMatchBatch()) {
            yield { type: 'result', book, result: item };
          }
          throw error;
        }

        if (indexDb && indexComplete) {
          await completeSearchIndex(indexDb, totalSections).catch(() => {});
        }
        perfMark('search', 'index.build', rebuildT0);
      }

      searchedBooks++;
      if (bookTruncated) truncated = true;
      yield {
        type: 'book-completed',
        book,
        matchCount: bookMatches,
        ...(bookTruncated ? { truncated: true } : {}),
      };
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof BookFileNotFoundError) {
        skippedBooks++;
        yield { type: 'book-skipped', book, reason: 'unavailable' };
        continue;
      }
      erroredBooks++;
      yield {
        type: 'book-error',
        book,
        error: error instanceof Error ? error.message : String(error),
        ...((error as { code?: string })?.code ? { code: (error as { code: string }).code } : {}),
      };
    } finally {
      if (buildLockHeld) {
        await releaseSearchBuildLock(appService, book.hash).catch(() => {});
      }
      if (!options.session) await closeBook(bookDoc, file);
      if (ownsIndexDb && indexDb) {
        await checkpointSearchIndex(indexDb);
        await indexDb.close().catch(() => {});
      }
    }
  }

  if (!signal?.aborted) {
    yield {
      type: 'completed',
      searchedBooks,
      skippedBooks,
      erroredBooks,
      matchCount: totalMatches,
      truncated,
    };
  }
}

/**
 * Resolve a text-offset locator to a CFI by re-extracting the section with the
 * same walker/filter the index was built with. Called lazily when the user
 * opens a search result — searching itself never materializes Ranges.
 * Falls back to the section CFI when the section text has drifted.
 */
export interface ResolvedSearchResultCfi {
  cfi: string;
  // nearby-words: one CFI per matched word run (>= 2); absent otherwise
  cfis?: string[];
}

export const resolveSearchResultCfis = async (
  session: LibrarySearchSession,
  book: Book,
  locators: SearchResultLocator[],
): Promise<Array<ResolvedSearchResultCfi | null>> => {
  const resolved: Array<ResolvedSearchResultCfi | null> = new Array(locators.length).fill(null);
  let bookDoc: SearchableBookDoc;
  try {
    ({ bookDoc } = await session.open(book));
    await loadTextWalker();
  } catch {
    return resolved;
  }
  const bySection = new Map<number, number[]>();
  locators.forEach((locator, position) => {
    const group = bySection.get(locator.section);
    if (group) group.push(position);
    else bySection.set(locator.section, [position]);
  });
  for (const [sectionIndex, positions] of bySection) {
    try {
      const section = bookDoc.sections?.[sectionIndex];
      const baseCFI = section?.cfi ?? CFI.fake.fromIndex(sectionIndex);
      const doc =
        section && typeof section.createDocument === 'function'
          ? await section.createDocument()
          : null;
      if (!doc) {
        for (const position of positions) resolved[position] = { cfi: baseCFI };
        continue;
      }
      const prepared = prepareSearchSection('resolve', doc, makeAcceptNode(book));
      const rangeCfi = (start: number, end: number): string | null => {
        if (end > prepared.text.length || start >= end) return null;
        const from = findNodeOffset(prepared.cumulative, start, 'right');
        const to = findNodeOffset(prepared.cumulative, end, 'left');
        const range = prepared.makeRange(from.index, from.offset, to.index, to.offset);
        return CFI.joinIndir(baseCFI, CFI.fromRange(range));
      };
      for (const position of positions) {
        const locator = locators[position]!;
        const cfi = rangeCfi(locator.start, locator.end) ?? baseCFI;
        const runCfis = locator.runs
          ?.map((run) => rangeCfi(run.start, run.end))
          .filter((value): value is string => value != null);
        resolved[position] = runCfis && runCfis.length >= 2 ? { cfi, cfis: runCfis } : { cfi };
      }
    } catch {
      // Leave this section's entries null.
    }
  }
  return resolved;
};

export const resolveSearchResultCfi = async (
  session: LibrarySearchSession,
  book: Book,
  locator: SearchResultLocator,
): Promise<string | null> =>
  (await resolveSearchResultCfis(session, book, [locator]))[0]?.cfi ?? null;
