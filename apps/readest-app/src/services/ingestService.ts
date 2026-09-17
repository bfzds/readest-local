import type { Book, BookLookupIndex, BookVersionConflictInfo } from '@/types/book';
import type { AppService, OsPlatform } from '@/types/system';
import type { SystemSettings } from '@/types/settings';
import { normalizeFilePathForIndex } from '@/services/bookService';
import { isContentURI, isValidURL } from '@/utils/misc';
import { parsePixivNovelFilename } from '@/utils/pixivNovel';

export interface IngestFileDeps {
  appService: AppService;
  settings: SystemSettings;
  /**
   * Pre-resolved absolute path to Readest's own `Books/` directory. When
   * provided, any source file already living under this prefix is excluded
   * from in-place import (it is, by definition, a hash copy we wrote). The
   * caller is expected to resolve it once per batch via
   * `appService.fs.getPrefix('Books')` instead of paying the async cost
   * per ingested file. Omit (or pass null) on contexts where the lookup is
   * unavailable — in-place decisions will then proceed without this guard.
   */
  appBooksPrefix?: string | null;
}

export interface IngestFileOptions {
  /** A file path (desktop/mobile) or a File object (web). */
  file: File | string;
  /** Current library, used by importBook for dedup. */
  books: Book[];
  /** Pre-built lookup index for O(1) dedup during batch imports. */
  lookupIndex?: BookLookupIndex;
  /** Collection to place the book in. */
  groupId?: string;
  groupName?: string;
  /** Tag parsed from a Send-to-Readest email subject (`#scifi`). */
  subjectTag?: string;
  /** Transient import (not stored long-term) — never uploaded. */
  transient?: boolean;
  /**
   * Opt out of automatic in-place import even when the source file lives under
   * the user's custom root directory. Forces the legacy behavior of copying
   * the file into Books/<hash>/. Defaults to false.
   */
  forceCopy?: boolean;
  /**
   * 临时章节识别规则（仅本次导入用，不写入全局设置）。与全局
   * settings.txtChapterPatterns 合并，且临时规则优先于全局。供"目录识别
   * 失败引导重切"场景使用。
   */
  chapterPatterns?: string[];
  /**
   * EPUB 导入疑似命中书库里的旧版本（见 ImportBookOptions.onVersionConflict）。
   * 原样转发给 importBook，不设则整个流程与加入该功能之前一致（无冲突识别）。
   */
  onVersionConflict?: (info: BookVersionConflictInfo) => void;
}

/**
 * Decide whether `file` should be imported in-place (read directly from its
 * source location) instead of copied into Books/<hash>/.
 *
 * Conditions (all must hold):
 *   - `file` is an absolute path string (not a File / blob / URL / content URI).
 *   - The path lives under one of the user's registered in-place roots
 *     (`settings.externalLibraryFolders`) — directories the user has
 *     explicitly told Readest to read in place. The Readest data location
 *     (`customRootDir`) is intentionally NOT an in-place trigger; that
 *     directory is Readest's own home and may freely contain hash copies.
 *   - The path is NOT inside Readest's own managed books directory
 *     (`appBooksPrefix`, e.g. `<AppData>/Books/`). Anything in that subtree
 *     is a hash copy under Readest's control, no point marking it in-place.
 *     We compare against the actual app data path rather than rejecting any
 *     `<root>/Books/` segment — users routinely have unrelated folders named
 *     `Books` inside their library roots (Baidu Netdisk's default layout,
 *     Calibre exports, etc.) and those must still go in-place.
 *   - Caller did not request `transient` (transient already opts out of
 *     copying via its own filePath path) or `forceCopy`.
 *
 * Returns false in any other case, including web (File objects), URLs, and
 * relative paths.
 *
 * Known limitation: symlinks are not resolved. A registered root of
 * `/Users/me/Library` will NOT match a file accessed through a sibling
 * symlink like `/Users/me/LibrarySymlink/sample.epub` even when both point
 * at the same on-disk directory. Adding best-effort realpath resolution
 * requires async I/O and a cross-platform `realpath` capability on
 * `FileSystem`, which is out of scope for this change.
 */
function shouldImportInPlace(
  file: File | string,
  opts: Pick<IngestFileOptions, 'transient' | 'forceCopy'>,
  inPlaceRoots: string[],
  osPlatform: OsPlatform,
  appBooksPrefix: string | null,
): boolean {
  if (opts.transient || opts.forceCopy) return false;
  if (typeof file !== 'string') return false;
  if (inPlaceRoots.length === 0) return false;

  // Absolute path check that works for POSIX and Windows without pulling in
  // node:path (this code also runs in the renderer on web/mobile builds).
  const isWindowsDrive = /^[A-Za-z]:[\\/]/.test(file);
  const isAbs = file.startsWith('/') || isWindowsDrive || file.startsWith('\\\\');
  if (!isAbs) return false;

  // Reject anything that smells like a URL or content URI. Windows drive
  // letters (`C:\…`) match a "scheme:rest" shape too, so exclude them
  // explicitly — `isWindowsDrive` already vouched for those.
  if (!isWindowsDrive && /^[a-z][a-z0-9+.-]*:/i.test(file)) return false;

  // macOS (APFS/HFS+ default), iOS, and Windows ship case-insensitive
  // filesystems out of the box, so `/Users/me/Library` and
  // `/users/me/library` must compare equal there. Linux and Android are
  // case-sensitive and stay strict. We do not attempt unicode normalization
  // (NFC/NFD) — APFS handles that at the FS layer and `toLocaleLowerCase`
  // with the wrong locale would introduce its own bugs (e.g. Turkish `İ`).
  //
  // Defer the actual canonicalization to `normalizeFilePathForIndex` so the
  // path index (`BookLookupIndex.byFilePath`) and this in-place decision
  // agree on what counts as the same path — otherwise a re-import could
  // hit the in-place branch here but miss the fast-path dedup in
  // importBook (or vice versa).
  const norm = (p: string) => normalizeFilePathForIndex(p, osPlatform);
  const target = norm(file);

  // If the file already lives inside Readest's own managed books directory
  // we never want to "in-place" it: it is, by definition, a hash copy we
  // produced ourselves. Compare against the actual resolved app prefix so
  // unrelated user-owned folders that happen to be named `Books` (very
  // common in cloud-drive layouts like Baidu Netdisk's `Books/` root) are
  // left untouched and imported in-place when they fall under a registered
  // external root.
  if (appBooksPrefix) {
    const appBooks = norm(appBooksPrefix);
    if (appBooks && (target === appBooks || target.startsWith(appBooks + '/'))) {
      return false;
    }
  }

  for (const raw of inPlaceRoots) {
    if (!raw) continue;
    const root = norm(raw);
    if (!root) continue;
    // Guard against root-as-prefix-of-different-dir (`/foo` vs `/foobar`).
    if (target !== root && !target.startsWith(root + '/')) continue;
    return true;
  }
  return false;
}

/**
 * Channel-agnostic single-file ingestion. Every capture channel — local library
 * import, the /send page, the inbox drainer — calls this so a sent book behaves
 * exactly like a locally-imported one.
 *
 * Persistence (`updateBooks` / `saveLibraryBooks`) stays with
 * the caller on purpose: batch importers save once per batch, single-item
 * callers save per item. The shared logic that must NOT diverge — importing,
 * group/tag metadata — lives here.
 */
/**
 * 一个文件导入之后的三种结果。`imported` 之外的两条都是"没有新建记录"，但
 * 提示语不同——用户需要知道自己的书是被"认出来了"还是被"复活了"。
 */
export type IngestOutcome = 'imported' | 'already-in-library' | 'revived';

export interface IngestFileResult {
  book: Book;
  /**
   * True when the file was already in the library (byFilePath in-place hit —
   * the same on-disk file at the same path re-imported). Callers use it to
   * say "already in library" instead of a misleading "successfully imported".
   */
  existed: boolean;
  /**
   * 三态结果，供调用方选择提示语：`imported` 现有成功提示；
   * `already-in-library` 什么都不改，只提示「已在书库中」；`revived` 复活了
   * 一条墓碑记录，提示「已从书库恢复」。
   */
  outcome: IngestOutcome;
  /**
   * 仅 TXT：内置/自定义规则一条标题都没匹配上、章节由段落兜底切出时，
   * 携带原始 TXT File（file 字段是 File 对象时即其本身；路径字符串时是
   * 读回的内容）。调用方可据此弹出「目录识别失败」引导，让用户勾选
   * 标题行生成临时规则重切。
   */
  txtFallbackFile?: File;
}

export async function ingestFile(
  opts: IngestFileOptions,
  deps: IngestFileDeps,
): Promise<IngestFileResult | null> {
  const { appService, settings, appBooksPrefix } = deps;

  const inPlaceRoots = settings.externalLibraryFolders ?? [];
  const inPlace = shouldImportInPlace(
    opts.file,
    opts,
    inPlaceRoots,
    appService.osPlatform,
    appBooksPrefix ?? null,
  );

  // In-place re-import fast path. When the source file lives under one of
  // the user's registered external library folders and the byFilePath index
  // already knows about it, skip importBook entirely and return the existing
  // library entry verbatim. No fs.openFile, no native parser, no partialMD5,
  // no timestamp / cover / config writes — and crucially no downstream group
  // / tag / upload logic, so a re-scan can't silently rewrite library sort
  // order or clobber a manual GroupingModal assignment via a path-derived
  // group string.
  //
  // This is intentionally separate from importBook's byHash / byMetaKey
  // dedup: a byHash hit means a *different* source path resolves to a known
  // book (drop a copy from elsewhere, or revive a soft-deleted entry), which
  // correctly clears `deletedAt` and refreshes timestamps. A byFilePath hit
  // is the same on-disk file at the same path — there is nothing to refresh,
  // and refreshing would silently rewrite library sort order on every
  // re-scan. Soft-deleted books are excluded from `byFilePath` at index
  // build time so they fall through to byHash and get resurrected.
  //
  // Reject URLs, content URIs and PSE streams defensively. The byFilePath
  // index only carries real on-disk paths, but `inPlace` could in principle
  // be set on a non-path source by a buggy caller.
  if (
    inPlace &&
    !opts.transient &&
    opts.lookupIndex &&
    typeof opts.file === 'string' &&
    !isValidURL(opts.file) &&
    !isContentURI(opts.file)
  ) {
    const key = normalizeFilePathForIndex(opts.file, appService.osPlatform);
    const existing = key ? opts.lookupIndex.byFilePath.get(key) : undefined;
    if (existing) {
      // Re-import of an in-place Pixiv novel: the filename is the canonical
      // source for title/author, so refresh stale metadata from earlier
      // imports instead of returning the old entry verbatim.
      const pixivMeta = parsePixivNovelFilename(opts.file);
      if (pixivMeta?.title) {
        existing.title = pixivMeta.title;
        existing.sourceTitle = pixivMeta.title;
        if (pixivMeta.author) existing.author = pixivMeta.author;
      }
      return { book: existing, existed: true, outcome: 'already-in-library' };
    }
  }

  // TXT 段落兜底切分时 bookService 会回调原始 TXT File（见
  // ImportBookOptions.onTxtChapterFallback）；带回给调用方决定是否引导重切。
  let txtFallbackFile: File | undefined;
  // 同一个文件重导命中既有记录（存活/墓碑）时 importBook 会回调这里。捕获成
  // 局部变量再随结果返回，写法与 onTxtChapterFallback 一致。
  let dedupOutcome: IngestOutcome | undefined;

  const book = await appService.importBook(opts.file, opts.books, {
    lookupIndex: opts.lookupIndex,
    transient: opts.transient,
    inPlace,
    onTxtChapterFallback: (file) => {
      txtFallbackFile = file;
    },
    onDedupHit: (kind) => {
      dedupOutcome = kind;
    },
    // 转发而非替换：调用方（书库页）靠这个回调把冲突入队，落地弹窗。
    // 注意 onTxtChapterFallback 是"把回调换成捕获、由返回字段带回"的写法，
    // 这里不能照抄——那样调用方注册的回调永远不会被调用，弹窗永不出现。
    ...(opts.onVersionConflict ? { onVersionConflict: opts.onVersionConflict } : {}),
    // 章节识别规则：本次临时规则（opts.chapterPatterns，目录识别失败引导重切
    // 时带）优先，再叠加全局 settings.txtChapterPatterns。均非空才透传。
    ...(opts.chapterPatterns?.length || settings.txtChapterPatterns?.length
      ? {
          chapterPatterns: [
            ...(opts.chapterPatterns ?? []),
            ...(settings.txtChapterPatterns ?? []),
          ],
        }
      : {}),
  });
  if (!book) return null;

  // Tri-state: undefined leaves whatever group the existing
  // (deduped) book already had untouched; an explicit string —
  // including the empty string — replaces it. The empty-string case
  // is what library imports use to "demote" a book back to the root
  // when the user picks Import-from-Folder → flatten on a previously
  // grouped book.
  if (opts.groupId !== undefined) {
    book.groupId = opts.groupId;
    book.groupName = opts.groupName;
  }

  const tag = opts.subjectTag?.trim();
  if (tag) {
    const tags = book.tags ?? [];
    if (!tags.includes(tag)) {
      book.tags = [...tags, tag];
      book.updatedAt = Date.now();
      // Tags merge on the metadata clock (#5438); stamp it or a peer's older
      // stamped metadata edit would win the group and drop this tag.
      book.metadataUpdatedAt = book.updatedAt;
    }
  }

  return { book, existed: false, outcome: dedupOutcome ?? 'imported', txtFallbackFile };
}
