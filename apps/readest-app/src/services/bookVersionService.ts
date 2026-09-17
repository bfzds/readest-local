import {
  Book,
  BookConfig,
  BookFormat,
  BookLookupIndex,
  BookNote,
  BookVersionConflictChoice,
  BookVersionConflictInfo,
  BookVersionConflictReason,
} from '@/types/book';
import { AppService } from '@/types/system';
import {
  findBookVersionCandidates,
  getBookVersionIdentities,
  getBookVersionIndexKey,
  getConfigFilename,
  hasStoredExplicitIdentity,
  isSameBookVersion,
} from '@/utils/book';
import { serializeRawConfig } from '@/utils/serializer';
import { StatisticsDb } from '@/services/statistics/statisticsDb';

/**
 * Fold an old release of a book into a freshly imported one.
 *
 * Called after the user confirms "用新版替换" on a version conflict (see
 * `ImportBookOptions.onVersionConflict`). By then both files are already on
 * disk as two separate library entries — this makes the new one take over the
 * old one's identity:
 *
 *   1. the old `config.json` (reading location, page progress, bookmarks,
 *      annotations, view settings, virtual TOC) is rewritten under the new
 *      hash — that is what "preserve reading progress" means here;
 *   2. the user-facing fields living on the BOOK ROW rather than in the config
 *      (progress bar, group, tags, reading status, shelf order) move onto the
 *      new row;
 *   3. the old row is dropped from library.json and its managed directory is
 *      deleted;
 *   4. reading statistics are re-keyed to the new hash.
 *
 * Ordering is the safety property: nothing destructive happens until the new
 * config is on disk, so a failure at any point leaves a working library
 * (worst case: the two releases stay separate, and the user can retry).
 *
 * The saved reading POSITION is carried over verbatim — including a CFI that
 * may no longer resolve inside the new file. Repositioning is the reader's
 * business: FoliateViewer falls back to the stored page fraction when the
 * location cannot be resolved.
 */
export interface ReplaceBookVersionResult {
  /** The surviving record (new hash, old book's user data). */
  book: Book;
  /**
   * The full library after the old row was dropped, exactly as persisted. The
   * caller adopts this verbatim for its in-memory store — recomputing the same
   * array from a second snapshot could disagree with what reached disk.
   */
  library: Book[];
}

export async function replaceBookVersion(
  appService: AppService,
  args: { oldBook: Book; newBook: Book; books: Book[] },
): Promise<ReplaceBookVersionResult> {
  const { oldBook, newBook, books } = args;
  if (oldBook.hash === newBook.hash) return { book: newBook, library: books };

  // Resolve both rows from the CURRENT library, and refuse to work from a stale
  // snapshot. The caller passes records captured when the dialog opened; by the
  // time the user answers, the old row may already have been folded into another
  // new file (the dialog can list two conflicts pointing at the same old book)
  // or deleted outright. Migrating from that stale object would graft the old
  // progress/group/tags onto a second book as well; doing nothing at all would
  // silently skip the replacement. Failing loudly keeps both records intact —
  // nothing below has run yet.
  const currentOld = books.find((b) => b.hash === oldBook.hash);
  const currentNew = books.find((b) => b.hash === newBook.hash);
  if (!currentOld || !currentNew) {
    throw new Error(
      `replaceBookVersion: book ${currentOld ? newBook.hash : oldBook.hash} is no longer in the library`,
    );
  }

  // 1. Carry the old config to the new directory.
  const oldConfig = await readConfig(appService, currentOld);
  const mergedConfig: Partial<BookConfig> = { ...oldConfig };
  mergedConfig.bookHash = currentNew.hash;
  mergedConfig.metaHash = currentNew.metaHash;
  // Notes are synced/queried by book hash; leaving the old value behind would
  // strand them on the previous file's identity.
  mergedConfig.booknotes = oldConfig.booknotes?.map((note) =>
    rewriteNoteHash(note, currentNew.hash),
  );
  await appService.writeFile(
    getConfigFilename(currentNew),
    'Books',
    serializeRawConfig(mergedConfig),
  );

  // 2. Move the row-level user data onto the new record.
  const merged = mergeBookRows(currentNew, currentOld);

  // 3. Commit the library: replace the new row, drop the old one. `replace:
  // true` is the only way to actually REMOVE a row — the default save is a
  // read-merge-write against library.json that would otherwise carry the old
  // record back onto disk (same reasoning as saveEditedEpub).
  const nextLibrary = [
    ...books.filter((b) => b.hash !== currentOld.hash && b.hash !== currentNew.hash),
    merged,
  ];
  await appService.saveLibraryBooks(nextLibrary, { replace: true });

  // 4. Delete the old directory outright. `Books/<oldHash>/` holds only what we
  // manage (the stored file, cover, config, nav cache, search index) — an
  // in-place book's real source file lives at the user's own path and is never
  // touched. `deleteBook('both')` would be the wrong tool: it stops after the
  // book file and cover, leaving an orphaned config.json behind.
  try {
    if (await appService.isDirectory(currentOld.hash, 'Books')) {
      await appService.deleteDir(currentOld.hash, 'Books', true);
    }
  } catch (error) {
    // The old directory is now unreferenced, not lost data — the new copy holds
    // everything that mattered. Report and keep going.
    console.warn('replaceBookVersion: failed to remove the old book directory', error);
  }

  // 5. Re-key reading statistics. Best-effort and only when the database is
  // already open: opening it here would create a statistics.db on devices that
  // never recorded any.
  try {
    await StatisticsDb.peekOpen()?.renameBookHash(currentOld.hash, currentNew.hash);
  } catch (error) {
    console.warn('replaceBookVersion: failed to re-key reading statistics', error);
  }

  return { book: merged, library: nextLibrary };
}

export interface VersionConflictPlan {
  /** 要把旧记录折进新版的（按弹窗顺序）。 */
  replacements: BookVersionConflictInfo[];
  /** 要丢弃本次导入那一本的。 */
  discards: BookVersionConflictInfo[];
  /**
   * 用户选了"替换"却没法执行的：同一批里两条冲突指向同一条旧记录，旧记录只能
   * 被折一次，后面那些保持原样——调用方据此说明"你选的替换没生效"。
   */
  skipped: BookVersionConflictInfo[];
}

/**
 * Turn the dialog's per-item choices into the work to perform.
 *
 * When several conflicts point at the SAME old record — one import batch holding
 * two releases of a book the library already has — only the first may replace it;
 * the rest fall back to "keep", because the old record can only be folded once
 * (replaceBookVersion would otherwise run against a row that is already gone).
 * Returned in dialog order so the caller can report what it skipped.
 *
 * `discard` needs no such arbitration: it only touches the record this batch
 * just created, and two conflicts never share an incoming record.
 */
export function planVersionConflictResolution(
  conflicts: BookVersionConflictInfo[],
  choices: BookVersionConflictChoice[],
): VersionConflictPlan {
  const replacements: BookVersionConflictInfo[] = [];
  const discards: BookVersionConflictInfo[] = [];
  const skipped: BookVersionConflictInfo[] = [];
  const claimed = new Set<string>();
  conflicts.forEach((conflict, index) => {
    const choice = choices[index];
    if (choice === 'discard') {
      discards.push(conflict);
      return;
    }
    const target = conflict.candidates[0];
    if (choice !== 'replace' || !target) {
      if (choice === 'replace') skipped.push(conflict);
      return;
    }
    if (claimed.has(target.hash)) {
      skipped.push(conflict);
      return;
    }
    claimed.add(target.hash);
    replacements.push(conflict);
  });
  return { replacements, discards, skipped };
}

async function readConfig(appService: AppService, book: Book): Promise<Partial<BookConfig>> {
  try {
    const raw = await appService.readFile(getConfigFilename(book), 'Books', 'text');
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    return JSON.parse(text) as Partial<BookConfig>;
  } catch {
    // No config (or a corrupt one) — nothing to preserve; the reader will start
    // from the default config rather than fail the replace.
    return {};
  }
}

function rewriteNoteHash(note: BookNote, hash: string): BookNote {
  return note.bookHash === hash ? note : { ...note, bookHash: hash };
}

/**
 * Move the old release's user data onto the new row. Everything the reader
 * derives from the file (title, author, metadata, hasNarration, coverHash,
 * format, hash) stays as the new import computed it — a replacement exists to
 * take the NEW release — while every user-owned field crosses over.
 *
 * `readingStatus` carries its own LWW clock, so the fresher side wins exactly
 * as the library sync resolves it: a page turn bumps the old row's `updatedAt`,
 * and trusting the row clock alone would resurrect a stale status.
 */
export function mergeBookRows(newBook: Book, oldBook: Book): Book {
  const merged: Book = {
    ...newBook,
    createdAt: Math.min(newBook.createdAt, oldBook.createdAt),
    progress: pickFresherProgress(newBook, oldBook),
  };

  // Freshness rule for the per-field clocks below: the fresher stamp wins, and a
  // TIE goes to the OLD record. Ties are not a corner case — a legacy row can
  // carry a status with no timestamp at all (the field is newer than the data),
  // and the incoming record never carries one, so "new wins the tie" would drop
  // a reading status the user still had. (libraryUtils' pickFresher* helpers
  // encode the same direction; they are test-only and not on any live merge
  // path, which happens server-side off the *_updated_at columns.)
  const oldStatusMs = oldBook.readingStatusUpdatedAt ?? 0;
  const newStatusMs = newBook.readingStatusUpdatedAt ?? 0;
  if (oldStatusMs >= newStatusMs) {
    merged.readingStatus = oldBook.readingStatus;
    merged.readingStatusUpdatedAt = oldBook.readingStatusUpdatedAt;
  }

  // A user-edited title is user data, exactly like tags and grouping: the
  // library's rename path writes `title` and leaves `sourceTitle` at its
  // import-time value, so the two differing means the user renamed this book.
  // Taking the new file's title then would silently revert their edit — and the
  // timestamp below must move with it, or the surviving row would claim "user
  // edited this at time T" while displaying the file's title, and a peer with an
  // older stamp would lose the tie-break on row `updatedAt` at random.
  const renamedByUser = !!oldBook.title && oldBook.title !== oldBook.sourceTitle;
  if (renamedByUser) merged.title = oldBook.title;

  // Tags are user data even though sync merges them with the metadata group:
  // the new import only ever adds a subject tag, so a plain union loses nothing.
  const tags = [...(oldBook.tags ?? []), ...(newBook.tags ?? [])].filter(
    (tag, index, all) => all.indexOf(tag) === index,
  );
  if (tags.length > 0) merged.tags = tags;
  merged.metadataUpdatedAt = renamedByUser
    ? Math.max(Date.now(), oldBook.metadataUpdatedAt ?? 0, newBook.metadataUpdatedAt ?? 0)
    : undefined;

  // Grouping and manual shelf order are pure user intent with no clock of their
  // own: the old row is the one the user has been living with, so it wins.
  if (oldBook.groupId !== undefined) {
    merged.groupId = oldBook.groupId;
    merged.groupName = oldBook.groupName;
  }
  if (oldBook.shelfIndex !== undefined) merged.shelfIndex = oldBook.shelfIndex;

  // The replace is an edit of BOTH records, so it must be visible to sync as
  // one: stamp the row clock (the removed old row is only communicated to peers
  // by its absence from the next push).
  merged.updatedAt = Math.max(Date.now(), newBook.updatedAt, oldBook.updatedAt);
  return merged;
}

/**
 * Keep the further-along reading progress, measured as a fraction of the book.
 * Page numbers are not comparable across releases (the new file paginates
 * differently), so the ratio decides — but the surviving tuple stays exactly as
 * stored, since the reader and the library both treat it as this book's
 * pagination.
 */
function pickFresherProgress(a: Book, b: Book): Book['progress'] {
  const fraction = (book: Book) =>
    book.progress && book.progress[1] > 0 ? book.progress[0] / book.progress[1] : -1;
  if (fraction(a) >= fraction(b)) return a.progress;
  return b.progress;
}

// --- 冲突判定（唯一的候选产出点） ---

/**
 * 「导入的这本和库里哪本可能是同一本书」的判定输入。
 */
export interface VersionProbeInput {
  hash: string;
  format: BookFormat;
  metaHash?: string;
  /** `metaHash` 是否含显式身份（标识符或文件名盐），即它是不是一个"书号"。 */
  metaHashIsIdentity: boolean;
  title?: string;
  sourceTitle?: string;
  author?: string;
  /**
   * 是否允许退到"同名同作者"这种宽匹配。仅 EPUB（含 TXT 转换产物）为 true：
   * PDF 的元数据是样板文字（#5411），按标题匹配会把一堆不相关的 PPT 导出物
   * 凑成冲突，因此 PDF 只认书号一致那一条路径。
   */
  allowLooseMatch: boolean;
}

export interface VersionProbeResult {
  /** 存活候选，按阅读进度降序；`[0]` 是替换目标。 */
  candidates: Book[];
  reason: BookVersionConflictReason;
}

const progressFraction = (book: Book): number =>
  book.progress && book.progress[1] > 0 ? book.progress[0] / book.progress[1] : -1;

/**
 * 按阅读进度降序排候选，进度相同（或都没有进度）时保持书库顺序——同一份书库
 * 状态必须每次给出同一个"替换目标"，否则用户看到的 [0] 会随批次抖动。
 */
const byProgressDesc = (library: Book[], list: Book[]): Book[] => {
  const order = new Map(library.map((book, index) => [book.hash, index]));
  return [...list].sort(
    (a, b) =>
      progressFraction(b) - progressFraction(a) ||
      (order.get(a.hash) ?? 0) - (order.get(b.hash) ?? 0),
  );
};

const isLiveCandidate = (book: Book, incomingHash: string): boolean =>
  !book.deletedAt && book.hash !== incomingHash;

/**
 * 同名同作者的宽匹配。探 `lookupIndex.byVersionKey` 时命中集合可能含重复，
 * 最后按书库顺序归一，保证结果与线性扫描完全一致（调用方只看到一份顺序）。
 */
function findLooseCandidates(args: {
  books: Book[];
  lookupIndex?: BookLookupIndex;
  incoming: VersionProbeInput;
}): Book[] {
  const { books, lookupIndex, incoming } = args;
  const identities = getBookVersionIdentities(incoming);
  if (identities.length === 0) return [];
  const index = lookupIndex?.byVersionKey;
  if (!index) {
    return findBookVersionCandidates(books, incoming).filter((book) =>
      isLiveCandidate(book, incoming.hash),
    );
  }
  const matches = new Set<Book>();
  for (const identity of identities) {
    for (const book of index.get(getBookVersionIndexKey(identity)) ?? []) {
      if (!isLiveCandidate(book, incoming.hash)) continue;
      const sameVersion = getBookVersionIdentities(book).some((stored) =>
        identities.some((probe) => isSameBookVersion(stored, probe)),
      );
      if (sameVersion) matches.add(book);
    }
  }
  if (matches.size === 0) return [];
  return books.filter((book) => matches.has(book));
}

/**
 * 判定一次导入是否命中书库里的旧版本。**候选判定只有这一处产出**，导入路径与
 * 批后二次探测都调它，弹窗只消费结果。
 *
 * 两层，先强后弱：
 *   1. 书号一致（`metaHash` + 格式）——PDF 的"书号"是文件名字盐，所以这一层
 *      恰好就是「同名 PDF」；任何格式都参与。
 *   2. 同名同作者——只有 `allowLooseMatch` 的格式才走，用于"换源重下"这类
 *      书号变了但确实是同一本书的情况。
 *
 * 同 hash 的重导不进候选：那是"同一个文件"，走 `onDedupHit` 那条不打扰的路。
 * 墓碑记录同样不算候选（用户已经删过它）。
 */
export function findIncomingVersionConflict(args: {
  books: Book[];
  lookupIndex?: BookLookupIndex;
  incoming: VersionProbeInput;
}): VersionProbeResult | null {
  const { books, lookupIndex, incoming } = args;

  if (incoming.metaHash && incoming.metaHashIsIdentity) {
    const key = `${incoming.metaHash}:${incoming.format}`;
    const pool =
      lookupIndex?.byMetaKey.get(key) ??
      books.filter(
        (book) => book.metaHash === incoming.metaHash && book.format === incoming.format,
      );
    const identityCandidates = pool.filter((book) => isLiveCandidate(book, incoming.hash));
    if (identityCandidates.length > 0) {
      return {
        candidates: byProgressDesc(books, identityCandidates),
        reason: 'same-identifier',
      };
    }
  }

  if (!incoming.allowLooseMatch) return null;
  const loose = findLooseCandidates({ books, lookupIndex, incoming });
  if (loose.length === 0) return null;
  const candidates = byProgressDesc(books, loose);
  // 判定依据只看"导入的这本有没有书号"，以及库里那条有没有 metaHash 可比。
  // 不去反推库里那条的 metaHash 里装的是不是真身份：那要看它的 metadata，
  // 而 PDF 的文件名盐根本不落在记录上（见 hasStoredExplicitIdentity）。
  const reason: BookVersionConflictReason = !incoming.metaHashIsIdentity
    ? 'incoming-without-identifier'
    : candidates.every((candidate) => !candidate.metaHash)
      ? 'same-title-author'
      : 'identifier-differs';
  return { candidates, reason };
}

/**
 * 批后二次探测：一次拖入多个版本时，批内两本互为新旧版本，但导入那一刻的探针
 * 看不见对方（对方还没入库）。整批结束后在最终书库上把本次新建的记录两两互查，
 * 命中补进冲突队列。
 *
 * 只有"本次新建"的记录参与，且只在批内配对（后入库的那本作为 `incoming`，
 * 先入库的作为候选），所以每对最多报一次，也不会重复导入时刻已经报过的冲突。
 */
export function findBatchVersionConflicts(args: {
  /** 本次真正新建的记录 hash（去重命中的不算）。 */
  importedHashes: Iterable<string>;
  library: Book[];
}): BookVersionConflictInfo[] {
  const { importedHashes, library } = args;
  const imported = new Set(importedHashes);
  const books = library.filter((book) => !book.deletedAt);
  // 书库顺序就是入库顺序，所以"前面那些"正好是本批更早进来的版本。第 j 本只
  // 和它前面的比：一对只会被报一次，方向也固定为"后进来的那本是新版"，不会
  // 因为遍历方向不同给出两个互为镜像的冲突。
  const fresh = books.filter((book) => imported.has(book.hash));
  const conflicts: BookVersionConflictInfo[] = [];
  for (let index = 1; index < fresh.length; index++) {
    const incoming = fresh[index]!;
    const earlier = new Set(fresh.slice(0, index).map((book) => book.hash));
    const probe = findIncomingVersionConflict({
      books,
      incoming: {
        hash: incoming.hash,
        format: incoming.format,
        metaHash: incoming.metaHash,
        metaHashIsIdentity: hasStoredExplicitIdentity(incoming),
        title: incoming.title,
        sourceTitle: incoming.sourceTitle,
        author: incoming.author,
        allowLooseMatch: incoming.format === 'EPUB',
      },
    });
    if (!probe) continue;
    const candidates = probe.candidates.filter((candidate) => earlier.has(candidate.hash));
    if (candidates.length === 0) continue;
    conflicts.push({ incoming, candidates, reason: probe.reason });
  }
  return conflicts;
}

// --- 撤销导入 ---

/**
 * 撤销一次刚完成的导入：把这条记录丢开，书库其余部分保持原样。
 *
 * 用墓碑而不是真删。两件事都依赖记录还在：受监视文件夹重扫的"已知路径"集合
 * 包含软删记录（`collectKnownSourcePaths`），真删会让同一个文件被反复当作新文件
 * 扫出来、反复弹窗；而保留 `filePath` 之后，用户再拖同一个文件进来还能走
 * `onDedupHit` 的复活路径把它拿回来。
 *
 * 目录按 `purge` 删——in-place 导入的源文件在用户自己的目录里，purge 不碰它。
 * 写盘必须 `{ replace: true }`：默认的 read-merge-write 会把刚删掉的记录从
 * library.json 带回内存快照里。
 */
export async function discardImportedBook(
  appService: AppService,
  args: { book: Book; books: Book[] },
): Promise<{ library: Book[] }> {
  const { book, books } = args;
  try {
    await appService.deleteBook({ ...book }, 'purge');
  } catch (error) {
    // 目录没清干净不影响"这本书被撤销"这件事：记录已是墓碑，书架不再显示它，
    // 残留的 Books/<hash>/ 下次删除同一本书时会再被清一次。
    console.warn('discardImportedBook: failed to remove the book directory', error);
  }
  const tombstone: Book = {
    ...book,
    deletedAt: Date.now(),
    downloadedAt: null,
    coverDownloadedAt: null,
  };
  const nextLibrary = [...books.filter((item) => item.hash !== book.hash), tombstone];
  await appService.saveLibraryBooks(nextLibrary, { replace: true });
  return { library: nextLibrary };
}
