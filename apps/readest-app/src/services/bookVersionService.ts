import {
  Book,
  BookConfig,
  BookNote,
  BookVersionConflictChoice,
  BookVersionConflictInfo,
} from '@/types/book';
import { AppService } from '@/types/system';
import { getConfigFilename } from '@/utils/book';
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

/**
 * Turn the dialog's per-item choices into the replacements to perform.
 *
 * When several conflicts point at the SAME old record — one import batch holding
 * two releases of a book the library already has — only the first may replace it;
 * the rest fall back to "keep", because the old record can only be folded once
 * (replaceBookVersion would otherwise run against a row that is already gone).
 * Returned in dialog order so the caller can report what it skipped.
 */
export function selectVersionReplacements(
  conflicts: BookVersionConflictInfo[],
  choices: BookVersionConflictChoice[],
): { replacements: BookVersionConflictInfo[]; skipped: BookVersionConflictInfo[] } {
  const replacements: BookVersionConflictInfo[] = [];
  const skipped: BookVersionConflictInfo[] = [];
  const claimed = new Set<string>();
  conflicts.forEach((conflict, index) => {
    const chosen = choices[index] === 'replace';
    if (!chosen || claimed.has(conflict.existing.hash)) {
      skipped.push(conflict);
      return;
    }
    claimed.add(conflict.existing.hash);
    replacements.push(conflict);
  });
  return { replacements, skipped };
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
