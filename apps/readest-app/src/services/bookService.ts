import { SystemSettings } from '@/types/settings';
import { FileSystem, AppPlatform, BaseDir, DeleteAction, OsPlatform } from '@/types/system';
import {
  Book,
  BookConfig,
  BookContent,
  BookFormat,
  BookLookupIndex,
  BookVersionConflictReason,
  FIXED_LAYOUT_FORMATS,
  ImportBookOptions,
  IncomingVersionFacts,
} from '@/types/book';
import {
  getDir,
  getLocalBookFilename,
  getCoverFilename,
  getConfigFilename,
  getBookNavFilename,
  findTxtDedupMatch,
  INIT_BOOK_CONFIG,
  formatTitle,
  formatAuthors,
  getPrimaryLanguage,
  getMetadataHash,
  getMetadataHashInfo,
  getBookVersionIdentities,
  getBookVersionIndexKey,
} from '@/utils/book';
import type { BookNav } from '@/services/nav';
import { filterVirtualTocItems } from '@/services/virtualToc/apply';
import { partialMD5, md5 } from '@/utils/md5';
import { perfMark } from '@/utils/perf';
import { getCoverThumbnailUrl } from '@/utils/coverThumbnail';
import { getBaseFilename, getFilename } from '@/utils/path';
import { BookDoc, DocumentLoader } from '@/libs/document';
import { hasMediaOverlays } from '@/services/tts/mediaOverlay';
import { tryNativeParseEpub } from '@/utils/tauriEpubBridge';
import { tryNativeParseMobi } from '@/utils/tauriMobiBridge';
import { DEFAULT_BOOK_SEARCH_CONFIG, DEFAULT_FIXED_LAYOUT_VIEW_SETTINGS } from './constants';
import { isContentURI, isValidURL, makeSafeFilename } from '@/utils/misc';
import { deserializeConfig, serializeConfig, serializeRawConfig } from '@/utils/serializer';
import { ClosableFile } from '@/utils/file';
import { convertTxtToEpubWithFallback } from '@/utils/txt-worker';
import { parsePixivNovelFilename, type PixivNovelMetadata } from '@/utils/pixivNovel';
import { svg2png } from '@/utils/svg';
import { downscaleImageBlob } from '@/utils/image';
import { normalizeMetadataIsbn } from '@/utils/isbn';
import { BookFileNotFoundError } from './errors';
import { simplifyChineseText } from '@/utils/simplecc';
import {
  isBookFileContentSource,
  resolveBookContentSource,
  type BookFileContentSource,
} from './bookContent';
import { findIncomingVersionConflict } from './bookVersionService';

export function buildBookLookupIndex(books: Book[], osPlatform?: OsPlatform): BookLookupIndex {
  const byHash = new Map<string, Book>();
  const byMetaKey = new Map<string, Book[]>();
  const byFilePath = new Map<string, Book>();
  const byVersionKey = new Map<string, Book[]>();
  for (const book of books) {
    byHash.set(book.hash, book);
    if (book.metaHash && !book.deletedAt) {
      const key = `${book.metaHash}:${book.format}`;
      const list = byMetaKey.get(key);
      if (list) list.push(book);
      else byMetaKey.set(key, [book]);
    }
    // Cross-version matching: one slot per comparable title, so a renamed book
    // is still found by its import-time title (and vice versa).
    if (!book.deletedAt) {
      for (const identity of getBookVersionIdentities(book)) {
        const key = getBookVersionIndexKey(identity);
        const list = byVersionKey.get(key);
        if (list) {
          if (!list.includes(book)) list.push(book);
        } else byVersionKey.set(key, [book]);
      }
    }
    // In-place books carry the absolute source path on `filePath` (set by
    // importBook below). Indexing them here lets a re-import of the exact
    // same file short-circuit before touching disk or computing partialMD5.
    // Skip URL-backed entries (remote books) and tombstoned ones.
    if (book.filePath && !isValidURL(book.filePath) && !book.deletedAt) {
      const key = normalizeFilePathForIndex(book.filePath, osPlatform);
      if (key) byFilePath.set(key, book);
    }
  }
  return { byHash, byMetaKey, byFilePath, byVersionKey };
}

/**
 * Normalize an absolute file path into a stable map key for `byFilePath`.
 *
 * Mirrors the same rules `ingestService.shouldImportInPlace` uses to compare
 * paths against the user's in-place roots so both sides agree on whether a
 * given source file matches a previously-indexed book:
 *   - Backslashes are normalized to `/`.
 *   - Trailing slashes are stripped.
 *   - On case-insensitive filesystems (macOS / iOS / Windows) the key is
 *     lowercased. Linux / Android keep the original casing.
 *
 * Returns an empty string for non-string / falsy input so callers can do a
 * `if (key) map.set(key, …)` guard without an extra null check.
 */
export function normalizeFilePathForIndex(path: string, osPlatform?: OsPlatform): string {
  if (!path) return '';
  const caseInsensitive =
    osPlatform === 'macos' || osPlatform === 'ios' || osPlatform === 'windows';
  const n = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return caseInsensitive ? n.toLowerCase() : n;
}

export interface ScannedFileEntry {
  /** Absolute path, already joined with the folder root. */
  fullPath: string;
  /** File size in bytes. */
  size: number;
}

/**
 * From a folder scan, keep only entries that (a) match one of `extensions`
 * (lowercased, no leading dot), (b) are at least `minSizeBytes`, and (c) are
 * NOT already in the library. Membership is tested against `existingPaths`,
 * which the caller builds from `buildBookLookupIndex(...).byFilePath.keys()`
 * (those keys are already normalized by `normalizeFilePathForIndex`, so we
 * normalize each scanned path the same way before comparing). Pure — no I/O.
 */
export function selectNewImportableFiles(
  entries: ScannedFileEntry[],
  opts: {
    extensions: string[];
    minSizeBytes: number;
    existingPaths: Set<string>;
    osPlatform?: OsPlatform;
  },
): ScannedFileEntry[] {
  const exts = new Set(opts.extensions.map((e) => e.toLowerCase()));
  return entries.filter((entry) => {
    const ext = entry.fullPath.split('.').pop()?.toLowerCase() ?? '';
    if (!exts.has(ext)) return false;
    if (opts.minSizeBytes > 0 && entry.size < opts.minSizeBytes) return false;
    const key = normalizeFilePathForIndex(entry.fullPath, opts.osPlatform);
    return !!key && !opts.existingPaths.has(key);
  });
}

/**
 * Turn the newly-found entries of one watched folder into importer inputs.
 *
 * `flatten` mirrors the Import-from-Folder dialog's "Folder Structure" choice
 * for that folder. In the default "Create groups from subfolders" mode every
 * file carries the watched folder as `basePath` — that hint is what makes
 * `importBooks` derive a group from the subfolder the file lives in. Without it
 * auto-imported books piled up in the library root while the same folder's
 * initial import stayed grouped (issue #5423). Flattened folders ("Import all
 * into library") omit the hint so their books keep landing in the root.
 */
export function toWatchedFolderImports(
  folder: string,
  entries: ScannedFileEntry[],
  flatten: boolean,
): Array<{ path: string; basePath?: string }> {
  return entries.map(({ fullPath }) =>
    flatten ? { path: fullPath } : { path: fullPath, basePath: folder },
  );
}

/**
 * Collect all known local source paths from the library into a normalized set.
 *
 * Unlike `buildBookLookupIndex(...).byFilePath`, this includes soft-deleted
 * books (`deletedAt` set) so that auto-import does not resurrect a book the
 * user intentionally removed from their library. `altFilePaths` is included
 * alongside `filePath`: several files in a watched folder can dedup into one
 * book (same bytes under two names, or two files sharing a metaHash), and a
 * path the importer folded away is just as "known" as the one it kept.
 *
 * URL-backed entries (remote books) are excluded — only on-disk paths matter.
 */
export function collectKnownSourcePaths(books: Book[], osPlatform?: OsPlatform): Set<string> {
  const paths = new Set<string>();
  for (const book of books) {
    for (const path of [book.filePath, ...(book.altFilePaths ?? [])]) {
      if (!path || isValidURL(path)) continue;
      const key = normalizeFilePathForIndex(path, osPlatform);
      if (key) paths.add(key);
    }
  }
  return paths;
}

/**
 * Move `book.filePath` into `book.altFilePaths` because `nextFilePath` is about
 * to take its place.
 *
 * The newest path always wins the `filePath` slot — that is what makes a rename
 * recoverable (the old name is gone from disk, the new one is where the bytes
 * are). Without this the displaced path would simply be forgotten, and the
 * auto-import scan would rediscover it as a "new" file on the next pass,
 * re-import it, displace the current path in turn, and ping-pong forever.
 *
 * Idempotent: entries are deduplicated by normalized key and `nextFilePath` is
 * never kept as its own alternative.
 */
function displaceSourcePath(book: Book, nextFilePath: string, osPlatform?: OsPlatform): void {
  const nextKey = normalizeFilePathForIndex(nextFilePath, osPlatform);
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const path of [book.filePath, ...(book.altFilePaths ?? [])]) {
    if (!path || isValidURL(path)) continue;
    const key = normalizeFilePathForIndex(path, osPlatform);
    if (!key || key === nextKey || seen.has(key)) continue;
    seen.add(key);
    paths.push(path);
  }
  book.altFilePaths = paths.length > 0 ? paths : undefined;
}

export interface CoverContext {
  fs: FileSystem;
  appPlatform: AppPlatform;
  localBooksDir: string;
}

export function getCoverImageUrl(ctx: CoverContext, book: Book): string {
  return ctx.fs.getURL(`${ctx.localBooksDir}/${getCoverFilename(book)}`);
}

export async function getCoverImageBlobUrl(ctx: CoverContext, book: Book): Promise<string> {
  return ctx.fs.getBlobURL(`${ctx.localBooksDir}/${getCoverFilename(book)}`, 'None');
}

export async function getCachedImageUrl(ctx: CoverContext, pathOrUrl: string): Promise<string> {
  const cachedKey = `img_${md5(pathOrUrl)}`;
  const cachePrefix = await ctx.fs.getPrefix('Cache');
  const cachedPath = `${cachePrefix}/${cachedKey}`;
  if (await ctx.fs.exists(cachedPath, 'None')) {
    return await ctx.fs.getImageURL(cachedPath);
  } else {
    const file = await ctx.fs.openFile(pathOrUrl, 'None');
    await ctx.fs.writeFile(cachedKey, 'Cache', await file.arrayBuffer());
    return await ctx.fs.getImageURL(cachedPath);
  }
}

export async function generateCoverImageUrl(ctx: CoverContext, book: Book): Promise<string> {
  return ctx.appPlatform === 'web'
    ? await getCoverImageBlobUrl(ctx, book)
    : getCoverImageUrl(ctx, book);
}

function imageToArrayBuffer(
  ctx: CoverContext,
  imageUrl?: string,
  imageFile?: string,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    if (!imageUrl && !imageFile) {
      reject(new Error('No image URL or file provided'));
      return;
    }
    if (ctx.appPlatform === 'web' && imageUrl && imageUrl.startsWith('blob:')) {
      fetch(imageUrl)
        .then((response) => response.arrayBuffer())
        .then(resolve)
        .catch(reject);
    } else if (ctx.appPlatform === 'tauri' && imageFile) {
      ctx.fs
        .openFile(imageFile, 'None')
        .then((file) => file.arrayBuffer())
        .then(resolve)
        .catch(reject);
    } else {
      reject(new Error('Unsupported platform or missing image data'));
    }
  });
}

export async function updateCoverImage(
  ctx: CoverContext,
  book: Book,
  imageUrl?: string,
  imageFile?: string,
): Promise<void> {
  if (imageUrl === '_blank') {
    await ctx.fs.removeFile(getCoverFilename(book), 'Books');
  } else if (imageUrl || imageFile) {
    const arrayBuffer = await imageToArrayBuffer(ctx, imageUrl, imageFile);
    await ctx.fs.writeFile(getCoverFilename(book), 'Books', arrayBuffer);
  }
  // 桌面端 coverImageUrl 是稳定路径（<hash>/cover.png），覆写同一文件后 URL
  // 不变，缩略缓存按 coverSrc 命中旧图。这里按稳定路径精确失效，配合
  // BookCover 依赖 updatedAt 重新走缓存，换封面后显示新图。
  getCoverThumbnailUrl.delete(getCoverImageUrl(ctx, book));
}

/**
 * Partial MD5 of the local cover.png, or null when the cover is absent. This is
 * the content-addressed cover-change signal for cross-device sync (issue
 * #4544): keeping `book.coverHash === computeCoverHash(book)` lets a peer
 * re-download the cover iff the synced hash differs from the local one. An
 * identical (re-extracted / re-imported) cover yields the same hash, so there
 * is no re-sync churn.
 */
export async function computeCoverHash(fs: FileSystem, book: Book): Promise<string | null> {
  if (!(await fs.exists(getCoverFilename(book), 'Books'))) return null;
  const coverFile = await fs.openFile(getCoverFilename(book), 'Books');
  return partialMD5(coverFile);
}

// --- Book Import ---

/**
 * Options consumed by bookService.importBook. Extends the user-facing
 * ImportBookOptions with the required AppService callbacks that are bound by
 * the AppService wrapper.
 */
export interface ImportBookInternalOptions extends ImportBookOptions {
  saveBookConfig: (book: Book, config: BookConfig) => Promise<void>;
  generateCoverImageUrl: (book: Book) => Promise<string>;
  /**
   * Used by the in-place fast path to normalize the source path the same way
   * `buildBookLookupIndex` does. Optional: when omitted the fast path falls
   * back to a case-sensitive comparison, which is still safe (it will simply
   * miss matches that differ only in casing on macOS / iOS / Windows and the
   * import will proceed down the slow path as before).
   */
  osPlatform?: OsPlatform;
}

/**
 * 弹窗要用的"新文件"事实（大小/修改时间/字数/章节数）。
 *
 * 全部来自导入时已经拿到的东西：源文件的大小与 mtime 现读一次（一次 `stats`），
 * 字数与章节数由原生解析器或 TXT 转换器顺带算出。任何一项取不到都留空——弹窗
 * 按"未记录"显示，判定与安全都不受影响（不变量 3：弹窗打开时不解析任何文件）。
 */
async function collectIncomingVersionFacts(
  fs: FileSystem,
  file: string | File,
  fileobj: File | undefined,
  parsed: { textLength?: number; sectionCount?: number } = {},
): Promise<IncomingVersionFacts | undefined> {
  let sizeBytes = fileobj?.size ?? 0;
  let mtime: number | undefined;
  if (typeof file === 'string' && !isValidURL(file)) {
    try {
      const info = await fs.stats(file, 'None');
      if (!sizeBytes) sizeBytes = info.size;
      mtime = info.mtime?.getTime();
    } catch {
      // 源文件读不到（已被移走、权限不足）——少一栏而已，不影响判定。
    }
  }
  if (!sizeBytes && mtime === undefined && parsed.textLength === undefined) return undefined;
  return {
    sizeBytes,
    mtime,
    textLength: parsed.textLength,
    sectionCount: parsed.sectionCount,
  };
}

export async function importBook(
  fs: FileSystem,
  // file might be:
  // 1.1 absolute path for local file on Desktop
  // 1.2 /private/var inbox file path on iOS
  // 2. remote url
  // 3. content provider uri
  // 4. File object from browsers
  file: string | File,
  books: Book[],
  options: ImportBookInternalOptions,
): Promise<Book | null> {
  const {
    saveBookConfig: saveBookConfigFn,
    generateCoverImageUrl: generateCoverImageUrlFn,
    saveBook = true,
    saveCover = true,
    overwrite = false,
    transient = false,
    inPlace = false,
    lookupIndex,
    osPlatform,
  } = options;

  const t0 = perfMark('importBook', 'start');

  let loadedBook: BookDoc | undefined;
  let fileobj: File | undefined;
  let pixivMeta: PixivNovelMetadata | null = null;
  // 仅 TXT 导入：原始 TXT 的 partialMD5，写入 book.sourceHash 供重导短路。
  let txtSourceHash: string | undefined;
  try {
    let format: BookFormat;
    let filename: string;
    // When the Rust EPUB parser succeeds it gives us the partialMD5 for free,
    // so we can short-circuit the JS hashing pass below.
    let nativeHash: string | undefined;
    let usedNativeParser = false;

    if (transient && typeof file !== 'string') {
      throw new Error('Transient import is only supported for file paths');
    }

    try {
      const sourcePath = typeof file === 'string' ? file : file.name;
      filename = typeof file === 'string' ? getFilename(file) : file.name;
      const isTxt = /\.txt$/i.test(filename);
      // Materialize the file into webview memory only when the JS path needs it
      // (TXT conversion, or the native-parser fallback below). Desktop EPUB/MOBI
      // imports go through the Rust parser, which reads the file natively —
      // loading the whole file here (hundreds of MB for large books) just to
      // hand it back to copyFile or discard it is a wasted memory spike.
      if (typeof file !== 'string' || isTxt) {
        if (typeof file === 'string') {
          fileobj = await fs.openFile(file, 'None');
        } else {
          // A File object (web) is the content itself — nothing to open.
          fileobj = file;
        }
        if (isTxt && fileobj) {
          const originalTxtFile = fileobj;
          // TXT 先查重后转换：原始 TXT 的 partialMD5 只读文件首尾少数块，
          // 代价可忽略；而转换管线（章节正则、段落兜底、EPUB 打包）对大
          // 文件动辄数秒，且此前它在查重之前执行——同一 TXT 重复拖入每
          // 次都要重转一遍才知道"已存在"。首导记录的 sourceHash 命中即
          // 直接短路：转换与解析全部跳过。语义与下面的 byHash 去重分支完全
          // 一致——存活记录原样返回（不改任何字段），墓碑记录复活。
          txtSourceHash = await partialMD5(originalTxtFile);
          if (!transient && !overwrite) {
            const existingTxtBook = findTxtDedupMatch(books, txtSourceHash);
            if (
              existingTxtBook &&
              // 书文件缺失（如被手动清理）时不能短路——完整路径会重新落盘。
              (await fs.exists(getLocalBookFilename(existingTxtBook), 'Books'))
            ) {
              const wasDeleted = !!existingTxtBook.deletedAt;
              const revived: Book = wasDeleted
                ? {
                    ...existingTxtBook,
                    deletedAt: null,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                  }
                : existingTxtBook;
              if (wasDeleted) {
                // 返回副本给调用方提交，原对象经 books/索引槽位替换对同批
                // 后续文件可见。
                const bi = books.findIndex((b) => b.hash === revived.hash);
                if (bi >= 0) books[bi] = revived;
                if (lookupIndex) lookupIndex.byHash.set(revived.hash, revived);
              }
              options.onDedupHit?.(wasDeleted ? 'revived' : 'already-in-library');
              perfMark('importBook', 'txtDedupSkip', t0);
              perfMark('importBook', 'total', t0);
              return revived;
            }
          }
          // TXT→EPUB 转换走已有 worker 链路（120s 超时 + 失败回退主线程）。
          // 此前主线程同步 convert 无超时：病态章节正则在引擎上灾难性回溯
          // 会永久冻结 UI，只能杀进程。
          const { file: convertedFile, usedFallback } = await convertTxtToEpubWithFallback({
            file: fileobj,
            chapterPatterns: options.chapterPatterns,
          });
          fileobj = convertedFile;
          // 规则一条标题都没匹配上、章节由段落兜底切出时通知调用方（书库
          // 据此弹「目录识别失败」引导）。回调先记下原始 TXT，导入结果返回
          // 后由调用方决定是否引导——这里只负责汇报，不改变导入结果。
          if (usedFallback) {
            options.onTxtChapterFallback?.(originalTxtFile);
          }
        }
      }
      if (fileobj && fileobj.size === 0) {
        throw new Error('Invalid or empty book file');
      }
      // Q1 fast path: when running under Tauri with a real file
      // path, let Rust contribute the mechanical parts of the
      // import work — partialMD5 over the file, the downscaled
      // cover, and (for EPUB) the raw OPF bytes. Metadata
      // extraction itself runs through foliate-js so the import
      // path produces the same `Book.metadata` shape the reader
      // path does (`refines` chains / ONIX5 / language maps / EPUB
      // `belongs-to-collection` for EPUB; PalmDB UID identifier
      // for MOBI), without any `DocumentLoader.open()` overhead —
      // the importer never reads sections / toc / fixed-layout
      // detection, so spending CPU on a zip central-directory
      // scan, nav/ncx inflate, or PDB record-table walk would be
      // pure waste here.
      //
      // Both bridges are no-ops on web / non-eligible paths, so
      // the cost when neither matches is just two cheap regex
      // tests.
      let nativeBookDoc: BookDoc | undefined;
      let nativeFormat: BookFormat | undefined;
      if (typeof file === 'string' && !isTxt) {
        const nativeEpub = await tryNativeParseEpub(file);
        if (nativeEpub) {
          nativeBookDoc = nativeEpub.bookDoc;
          nativeFormat = 'EPUB' as BookFormat;
          nativeHash = nativeEpub.partialMd5;
        } else {
          // MOBI's native parse still needs the file in webview memory (foliate
          // reads the PDB header for the full metadata shape), so materialize
          // it only here — EPUB native parse above never touches it.
          if (!fileobj) fileobj = await fs.openFile(file, 'None');
          const nativeMobi = await tryNativeParseMobi(file, fileobj);
          if (nativeMobi) {
            nativeBookDoc = nativeMobi.bookDoc;
            nativeFormat = nativeMobi.format;
            nativeHash = nativeMobi.partialMd5;
          }
        }
      }
      if (nativeBookDoc && nativeFormat) {
        loadedBook = nativeBookDoc;
        format = nativeFormat;
        usedNativeParser = true;
      } else {
        if (!fileobj) {
          if (typeof file === 'string') {
            fileobj = await fs.openFile(file, 'None');
          } else {
            fileobj = file;
          }
        }
        ({ book: loadedBook, format } = await new DocumentLoader(fileobj).open());
      }
      if (!loadedBook) {
        throw new Error('Unsupported or corrupted book file');
      }
      normalizeMetadataIsbn(loadedBook.metadata);
      const metadataTitle = formatTitle(loadedBook.metadata.title);
      pixivMeta = parsePixivNovelFilename(sourcePath);
      const looksLikeChapterTitle =
        /^(?:第\s*[0-9一二三四五六七八九十百千万零]*\s*[章话回節卷部]|[上下中]册|[上下中]部|Chapter\s*\d+)\s*$/i.test(
          metadataTitle?.trim() ?? '',
        );
      if (
        !metadataTitle ||
        !metadataTitle.trim() ||
        metadataTitle === filename ||
        (pixivMeta && looksLikeChapterTitle)
      ) {
        loadedBook.metadata.title = pixivMeta?.title || getBaseFilename(filename);
      }
      if (pixivMeta?.author && !formatAuthors(loadedBook.metadata.author, 'ja')) {
        loadedBook.metadata.author = pixivMeta.author;
      }
    } catch (error) {
      throw new Error(`Failed to open the book file: ${(error as Error).message || error}`);
    }
    perfMark('importBook', 'parse', t0);

    const hash = usedNativeParser ? nativeHash! : await partialMD5(fileobj!);
    perfMark('importBook', 'hash', t0);

    // PDF metadata is often generic boilerplate (e.g. every PowerPoint export
    // is titled "PowerPoint Presentation" by the same author), so metadata
    // alone wrongly collapses distinct files into one book (issue #5411).
    // Salt the hash with the original filename so only same-named PDFs dedupe.
    const filenameSalt = format === 'PDF' ? getBaseFilename(filename) : undefined;
    const metaHashInfo = getMetadataHashInfo(loadedBook.metadata, filenameSalt);
    const metaHash = metaHashInfo?.metaHash;
    let existingBook = lookupIndex
      ? lookupIndex.byHash.get(hash)
      : books.find((b) => b.hash === hash);
    // B-6 复核：路径索引延迟到最终提交点。提前 set 会在 cover URL 生成等
    // 后续异步失败时留下"索引指向草稿/新路径"的脏态。
    let pendingFilePathKey: string | undefined;
    let pendingFilePathBook: Book | null = null;

    // 同一个文件重导：命中既有记录就到此为止，绝不再往下走复制/落盘。
    //
    // 存活 → **什么都不改**：不复制文件、不新建记录、不刷新时间戳。此前这条
    // 路径会顺手抬 createdAt/updatedAt 并重写元数据，于是"把同一本书再拖一次"
    // 就悄悄改了书库排序与同步时钟。唯一例外是书文件确实丢了（用户手工清理过
    // Books/）——那种情况继续往下走，让完整路径把它重新落盘。
    //
    // 墓碑 → **复活**：删过的书拖回来必须能回到书库，否则删掉的书永远拿不回来。
    // 这是导入路径上唯一会改动既有记录的地方，且只动 deletedAt 与行时钟。
    //
    // `overwrite` 是显式的"重新导入这一本"，不受此短路约束；in-place 的同一份
    // 文件出现在**新路径**上时也继续走完整路径，好让 `altFilePaths` 记住它，
    // 否则受监视文件夹的重扫会把这个已知重复一遍遍当新文件解析。
    const filePathUnchanged =
      !inPlace || typeof file !== 'string' || existingBook?.filePath === file;
    if (existingBook && !transient && !overwrite && filePathUnchanged) {
      const wasDeleted = !!existingBook.deletedAt;
      if (wasDeleted || (await isBookAvailable(fs, existingBook))) {
        const revived: Book = wasDeleted
          ? { ...existingBook, deletedAt: null, createdAt: Date.now(), updatedAt: Date.now() }
          : existingBook;
        if (wasDeleted) {
          // B-6：数组与索引槽位都换成复活后的副本，同批后续文件才看得见它。
          const bi = books.findIndex((b) => b.hash === hash);
          if (bi >= 0) books[bi] = revived;
          lookupIndex?.byHash.set(hash, revived);
        }
        options.onDedupHit?.(wasDeleted ? 'revived' : 'already-in-library');
        perfMark('importBook', 'total', t0);
        return revived;
      }
    }

    if (existingBook) {
      // B-6：已存在书的所有字段更新都写在副本上，成功后再提交 ——
      // 中途抛错不污染调用方传入的 library 数组 / lookupIndex 的原对象。
      existingBook = { ...existingBook };
      if (!transient) {
        existingBook.deletedAt = null;
      }
      existingBook.createdAt = Date.now();
      existingBook.updatedAt = Date.now();
    }

    const primaryLanguage = getPrimaryLanguage(loadedBook.metadata.language);
    // metaHash was computed above from the original metadata; only display fields
    // are simplified so re-importing the same file still dedupes by original title.
    // The simplification must land BEFORE the matching blocks below: they compare
    // the incoming title/author against stored (already simplified) book fields.
    const simplifiedTitle = await simplifyChineseText(formatTitle(loadedBook.metadata.title));
    const simplifiedAuthor = await simplifyChineseText(
      formatAuthors(loadedBook.metadata.author, primaryLanguage),
    );
    loadedBook.metadata.title = simplifiedTitle;
    loadedBook.metadata.author = simplifiedAuthor;

    // 冲突探针：库里可能已有这本书的旧版本。判定只有一处产出（见
    // bookVersionService.findIncomingVersionConflict），这里只把结果交给调用
    // 方；导入路径本身既不折叠也不删除任何既有记录（不变量 1）。
    //
    // `existingBook` 存在时不报——那条路径是"同一个文件重导"或显式覆盖，用户
    // 已经看见这本书了，再问一次没有意义。批内两本互为新旧版本的情况由批后
    // 二次探测补上（findBatchVersionConflicts）。
    const reportVersionConflict = !!options.onVersionConflict && !transient && !existingBook;
    let versionConflict: { candidates: Book[]; reason: BookVersionConflictReason } | undefined;
    if (reportVersionConflict) {
      versionConflict =
        findIncomingVersionConflict({
          books,
          lookupIndex,
          incoming: {
            hash,
            format,
            metaHash,
            metaHashIsIdentity: !!metaHashInfo?.hasExplicitIdentity,
            title: simplifiedTitle,
            author: simplifiedAuthor,
            // PDF 的元数据是样板文字（#5411），退到"同名同作者"会把一堆不相关
            // 的导出物凑成冲突；它的书号是文件名字盐，所以"同名 PDF"仍然被
            // 第一层（书号一致）认出来。TXT 走转换后的 EPUB，同样被覆盖。
            allowLooseMatch: format === 'EPUB',
          },
        }) ?? undefined;
    }

    const book: Book = {
      hash,
      format,
      metaHash,
      sourceHash: txtSourceHash,
      title: formatTitle(loadedBook.metadata.title),
      sourceTitle: formatTitle(loadedBook.metadata.title),
      primaryLanguage,
      author: formatAuthors(loadedBook.metadata.author, primaryLanguage),
      // Cached here because the library list never opens the book: it is a
      // property of the file, so it is re-derived on every (re)import rather
      // than synced as user data.
      hasNarration: hasMediaOverlays(loadedBook) || undefined,
      metadata: loadedBook.metadata,
      createdAt: existingBook ? existingBook.createdAt : Date.now(),
      uploadedAt: existingBook ? existingBook.uploadedAt : null,
      deletedAt: transient ? Date.now() : null,
      downloadedAt: Date.now(),
      updatedAt: Date.now(),
    };
    // update series info from metadata
    if (book.metadata?.belongsTo?.series) {
      const belongsTo = book.metadata.belongsTo.series;
      const series = Array.isArray(belongsTo) ? belongsTo[0] : belongsTo;
      if (series) {
        book.metadata.series = formatTitle(series.name);
        book.metadata.seriesIndex = parseFloat(series.position || '0');
        if (series.total) book.metadata.seriesTotal = parseInt(series.total, 10);
      }
    }
    // update book metadata when reimporting the same book
    if (existingBook) {
      // Same file hash: preserve user edits
      existingBook.format = book.format;
      existingBook.metaHash = metaHash;
      // A re-import of the same file can carry the canonical title in its
      // filename (Pixiv novel downloads), so refresh stale titles instead of
      // keeping whatever the previous import persisted.
      if (pixivMeta?.title) {
        existingBook.title = book.title;
        existingBook.sourceTitle = book.sourceTitle;
      } else {
        existingBook.title = existingBook.title.trim() ? existingBook.title.trim() : book.title;
        existingBook.sourceTitle = existingBook.sourceTitle ?? book.sourceTitle;
      }
      existingBook.author = pixivMeta?.title ? book.author : (existingBook.author ?? book.author);
      existingBook.primaryLanguage = existingBook.primaryLanguage ?? book.primaryLanguage;
      existingBook.metadata = book.metadata;
      existingBook.sourceHash = book.sourceHash ?? existingBook.sourceHash;
      existingBook.downloadedAt = Date.now();
    }

    // Idempotent create (recursive): a plain createDir defaults to
    // non-recursive and throws if the dir already exists, and the check-then-
    // create above races two concurrent imports of the same book — on Windows
    // the loser fails with "Cannot create a file when that file already exists"
    // (READEST-H). create_dir_all is a no-op when the dir exists.
    await fs.createDir(getDir(book), 'Books', true);
    const bookFilename = getLocalBookFilename(book);
    const willWriteBookFile =
      saveBook &&
      !transient &&
      !inPlace &&
      (typeof file === 'string' || !!fileobj) &&
      (!(await fs.exists(bookFilename, 'Books')) || overwrite);
    if (willWriteBookFile && (typeof file === 'string' || fileobj)) {
      if (/\.txt$/i.test(filename)) {
        // TXT always goes through the JS converter, so fileobj is present.
        await fs.writeFile(bookFilename, 'Books', fileobj!);
      } else if (typeof file === 'string' && isContentURI(file)) {
        await fs.copyFile(file, 'None', bookFilename, 'Books');
      } else if (typeof file === 'string' && !isValidURL(file)) {
        try {
          // try to copy the file directly first in case of large files to avoid memory issues
          // on desktop when reading recursively from selected directory the direct copy will fail
          // due to permission issues, then fallback to read and write files
          await fs.copyFile(file, 'None', bookFilename, 'Books');
        } catch {
          // The native-parser path skips reading the file into webview memory;
          // only materialize it here if the direct copy actually failed.
          const fallback = fileobj ?? (await fs.openFile(file, 'None'));
          await fs.writeFile(bookFilename, 'Books', await fallback.arrayBuffer());
        }
      } else {
        // A File object (web) or a URL-backed source; fileobj is the file.
        await fs.writeFile(bookFilename, 'Books', fileobj!);
      }
    }
    perfMark('importBook', 'copy', t0);
    if (saveCover && (!(await fs.exists(getCoverFilename(book), 'Books')) || overwrite)) {
      let cover = await loadedBook.getCover();
      if (cover?.type === 'image/svg+xml') {
        try {
          console.log('Converting SVG cover to PNG...');
          cover = await svg2png(cover);
        } catch {}
      }
      if (cover) {
        // High-resolution covers can be megabytes; cap the stored cover's
        // longest side so library covers stay small. Best-effort — any decode
        // failure keeps the original bytes.
        const resized = await downscaleImageBlob(cover);
        const coverBytes = await resized.arrayBuffer();
        await fs.writeFile(getCoverFilename(book), 'Books', coverBytes);
      }
    }
    perfMark('importBook', 'cover', t0);
    // Maintain coverHash === partialMD5(cover.png) so cross-device cover sync
    // can detect changes (issue #4544). Read from disk regardless of whether we
    // just wrote it — a hash-match reimport may reuse an existing cover.
    const coverHash = await computeCoverHash(fs, book);
    book.coverHash = coverHash;
    if (existingBook) existingBook.coverHash = coverHash;
    // Never overwrite the config file only when it's not existed
    if (!existingBook) {
      await saveBookConfigFn(book, INIT_BOOK_CONFIG);
      books.push(book);
      if (lookupIndex) {
        lookupIndex.byHash.set(book.hash, book);
        if (book.metaHash) {
          const key = `${book.metaHash}:${book.format}`;
          const list = lookupIndex.byMetaKey.get(key);
          if (list) list.push(book);
          else lookupIndex.byMetaKey.set(key, [book]);
        }
        // Keep the version index current for the rest of the batch: the next
        // file may be another release of the book we just added. Skipped when
        // the caller assembled a partial index (the linear fallback inside
        // findIncomingVersionConflict stays correct, just slower).
        const versionIndex = lookupIndex.byVersionKey as Map<string, Book[]> | undefined;
        if (versionIndex) {
          for (const identity of getBookVersionIdentities(book)) {
            const key = getBookVersionIndexKey(identity);
            const list = versionIndex.get(key);
            if (list) {
              if (!list.includes(book)) list.push(book);
            } else versionIndex.set(key, [book]);
          }
        }
      }
    }

    // update file links with url or path or content uri
    if (typeof file === 'string') {
      if (isValidURL(file)) {
        book.url = file;
        if (existingBook) existingBook.url = file;
      } else if (transient || inPlace) {
        // transient: source file is loaded directly, never persisted in Books/.
        // inPlace: source file is inside the user's library root and we read it
        // there directly instead of duplicating it under Books/<hash>/.
        book.filePath = file;
        if (existingBook) {
          // A second on-disk file just deduped into a book we already have.
          // Keep the path it is losing so the auto-import scan knows both
          // files are accounted for (transient previews are never persisted,
          // so there is nothing to remember for them).
          if (inPlace && !transient) {
            displaceSourcePath(existingBook, file, osPlatform);
          }
          existingBook.filePath = file;
        }
      }
    }
    // Now that `filePath` is set, record the path-index entry as a pending commit
    // (only applied after every write, cover and cover-URL step succeeds). A
    // failure between here and the commit point must not leave `byFilePath`
    // pointing at a draft or a path that never persisted. Only persistent
    // in-place imports go into the index — transient previews are short-lived
    // and never persisted to the library so indexing them would just leak
    // references.
    if (inPlace && !transient && typeof file === 'string') {
      const indexedBook = existingBook || book;
      if (indexedBook.filePath && lookupIndex) {
        const key = normalizeFilePathForIndex(indexedBook.filePath, osPlatform);
        if (key) {
          pendingFilePathKey = key;
          pendingFilePathBook = indexedBook;
        }
      }
    }
    book.coverImageUrl = await generateCoverImageUrlFn(book);

    // B-5 / B-6：此时目标书文件与 config 已全部落盘成功，才执行提交：
    // 把现有书的副本同步进数组与索引，后续批次不会再拿到过时对象。
    // 导入路径不删除任何记录——合并与否由用户在弹窗里决定（不变量 1）。
    if (existingBook) {
      const bi = books.findIndex((b) => b.hash === existingBook!.hash);
      if (bi >= 0) books[bi] = existingBook!;
      if (lookupIndex) {
        lookupIndex.byHash.set(existingBook.hash, existingBook);
        for (const list of lookupIndex.byMetaKey.values()) {
          const i = list.findIndex((b) => b.hash === existingBook!.hash);
          if (i >= 0) list[i] = existingBook!;
        }
      }
    }

    // B-6 复核：全部文件/封面/配置/cover URL 落盘并提交数组与三个主索引后，
    // 最后统一提交路径索引（此前任何一步失败都不会污染 byFilePath）。
    if (pendingFilePathKey && pendingFilePathBook && lookupIndex) {
      lookupIndex.byFilePath.set(pendingFilePathKey, pendingFilePathBook);
    }
    perfMark('importBook', 'total', t0);
    // B-6：existingBook 是副本；调用方将以该对象更新 store，原对象未被动过。
    const importedBook = existingBook || book;
    // Report last, with the record that actually persisted: the caller shows the
    // two sides in the confirmation dialog, then hands them to
    // replaceBookVersion() (replace) or discardImportedBook() (undo).
    if (versionConflict) {
      options.onVersionConflict?.({
        incoming: importedBook,
        candidates: versionConflict.candidates,
        reason: versionConflict.reason,
        incomingFacts: await collectIncomingVersionFacts(fs, file, fileobj),
      });
    }
    return importedBook;
  } catch (error) {
    console.error('Error importing book:', error);
    throw error;
  } finally {
    // Release the parsed document (a PDF leaks its pdf.js worker otherwise,
    // ~60 MB per imported file — #5387) and the opened file handle.
    try {
      await loadedBook?.destroy?.();
    } catch (error) {
      console.warn('Error destroying book document:', error);
    }
    const f = fileobj as ClosableFile | undefined;
    if (f?.close) {
      try {
        await f.close();
      } catch {}
    }
  }
}

// --- Book Content & Config ---

export async function isBookAvailable(fs: FileSystem, book: Book): Promise<boolean> {
  return (await resolveBookContentSource(fs, book)).kind !== 'missing';
}

export async function getBookFileSize(fs: FileSystem, book: Book): Promise<number | null> {
  const source = await resolveBookContentSource(fs, book);
  if (source.kind !== 'managed' && source.kind !== 'external') {
    return null;
  }
  const file = await fs.openFile(source.path, source.base);
  const size = file.size;
  const f = file as ClosableFile;
  if (f && f.close) {
    await f.close();
  }
  return size;
}

async function openBookFileContent(
  fs: FileSystem,
  book: Book,
): Promise<{
  source: BookFileContentSource;
  file: File;
}> {
  const source = await resolveBookContentSource(fs, book);
  if (!isBookFileContentSource(source)) {
    throw new BookFileNotFoundError();
  }
  return { source, file: await fs.openFile(source.path, source.base) };
}

export async function loadBookContent(fs: FileSystem, book: Book): Promise<BookContent> {
  const { file } = await openBookFileContent(fs, book);
  return { book, file };
}

/**
 * Best-effort resolution of an absolute, on-disk filesystem path for a book.
 *
 * Returns null when the book is not stored on disk (e.g. in-memory blob,
 * remote URL) or the path cannot be resolved. The returned path is
 * suitable for handing to native (Rust) commands that read the file
 * directly via std::fs.
 */
export async function resolveNativeBookFilePath(
  fs: FileSystem,
  resolveFilePath: (path: string, base: BaseDir) => Promise<string>,
  book: Book,
): Promise<string | null> {
  try {
    const source = await resolveBookContentSource(fs, book);
    if (source.kind !== 'managed' && source.kind !== 'external') return null;
    const fp = await resolveFilePath(source.path, source.base);
    if (!fp) return null;
    return fp.startsWith('file://') ? decodeURI(fp.slice('file://'.length)) : fp;
  } catch {
    return null;
  }
}

export async function loadBookConfig(
  fs: FileSystem,
  book: Book,
  settings: SystemSettings,
): Promise<BookConfig> {
  const globalViewSettings = {
    ...settings.globalViewSettings,
    ...(FIXED_LAYOUT_FORMATS.has(book.format) ? DEFAULT_FIXED_LAYOUT_VIEW_SETTINGS : {}),
  };
  try {
    let str = '{}';
    if (await fs.exists(getConfigFilename(book), 'Books')) {
      str = (await fs.readFile(getConfigFilename(book), 'Books', 'text')) as string;
    }
    return deserializeConfig(str, globalViewSettings, DEFAULT_BOOK_SEARCH_CONFIG);
  } catch {
    return deserializeConfig('{}', globalViewSettings, DEFAULT_BOOK_SEARCH_CONFIG);
  }
}

export async function saveBookConfig(
  fs: FileSystem,
  book: Book,
  config: BookConfig,
  settings?: SystemSettings,
): Promise<void> {
  let serializedConfig: string;
  if (settings) {
    const globalViewSettings = {
      ...settings.globalViewSettings,
      ...(FIXED_LAYOUT_FORMATS.has(book.format) ? DEFAULT_FIXED_LAYOUT_VIEW_SETTINGS : {}),
    };
    serializedConfig = serializeConfig(config, globalViewSettings, DEFAULT_BOOK_SEARCH_CONFIG);
  } else {
    serializedConfig = serializeRawConfig(config);
  }
  await fs.writeFile(getConfigFilename(book), 'Books', serializedConfig);
}

export async function loadBookNav(fs: FileSystem, book: Book): Promise<BookNav | null> {
  try {
    const path = getBookNavFilename(book);
    if (!(await fs.exists(path, 'Books'))) return null;
    const str = (await fs.readFile(path, 'Books', 'text')) as string;
    const parsed = JSON.parse(str) as BookNav;
    if (!parsed || typeof parsed.version !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveBookNav(fs: FileSystem, book: Book, nav: BookNav): Promise<void> {
  // 结构不变量：nav.json 只承载真实目录。虚拟目录条目是用户数据（存 config.json
  // 的 virtualToc），一旦写进 nav.json 就会被 nav 管线重编号成非负 id，strip 的
  // id 判据随之失效，之后每次打开都会残留叠加。过滤内建于写盘，不依赖调用方
  // 先剥的顺序；入参 nav 不被改动。
  const toc = filterVirtualTocItems(nav.toc ?? []);
  await fs.writeFile(getBookNavFilename(book), 'Books', JSON.stringify({ ...nav, toc }));
}

export async function deleteBook(
  fs: FileSystem,
  book: Book,
  deleteAction: DeleteAction,
): Promise<void> {
  if (deleteAction === 'local' || deleteAction === 'both' || deleteAction === 'purge') {
    const source = await resolveBookContentSource(fs, book);
    if (source.kind === 'managed' && deleteAction !== 'purge') {
      if (await fs.exists(source.path, source.base)) {
        await fs.removeFile(source.path, source.base);
      }
    }

    if (deleteAction === 'purge') {
      const dir = getDir(book);
      if (await fs.exists(dir, 'Books')) {
        await fs.removeDir(dir, 'Books', true);
      }
    }

    if (deleteAction === 'both' && (await fs.exists(getCoverFilename(book), 'Books'))) {
      await fs.removeFile(getCoverFilename(book), 'Books');
    }
    if (deleteAction === 'local' || deleteAction === 'purge') {
      book.downloadedAt = null;
    } else {
      book.deletedAt = Date.now();
      book.downloadedAt = null;
      book.coverDownloadedAt = null;
    }
  }
}

export async function fetchBookDetails(fs: FileSystem, book: Book): Promise<BookDoc['metadata']> {
  const fp = getLocalBookFilename(book);
  if (!(await fs.exists(fp, 'Books'))) {
    throw new BookFileNotFoundError();
  }
  const { file } = await loadBookContent(fs, book);
  let bookDoc: BookDoc | undefined;
  try {
    bookDoc = (await new DocumentLoader(file).open()).book;
    return bookDoc.metadata;
  } finally {
    try {
      await bookDoc?.destroy?.();
    } catch {}
    const f = file as ClosableFile;
    if (f && f.close) {
      await f.close();
    }
  }
}

/**
 * Refresh metadata for a single book by re-opening and re-parsing its file.
 * Updates series info, language, and other metadata fields without modifying
 * user-edited titles or reading progress.
 * Returns true if the metadata was successfully refreshed.
 */
export async function refreshBookMetadata(fs: FileSystem, book: Book): Promise<boolean> {
  const { file } = await loadBookContent(fs, book);
  let bookDoc: BookDoc | undefined;
  try {
    ({ book: bookDoc } = await new DocumentLoader(file).open());
    if (!bookDoc) return false;

    book.metadata = bookDoc.metadata;
    // PDF metaHash is salted with the original import filename (issue #5411),
    // which is lost after import — keep the value stamped at import time.
    if (book.format !== 'PDF' || !book.metaHash) {
      book.metaHash = getMetadataHash(bookDoc.metadata);
    }
    const primaryLanguage = getPrimaryLanguage(bookDoc.metadata.language);
    if (primaryLanguage) {
      book.primaryLanguage = primaryLanguage;
    }

    // Update series info from metadata
    if (book.metadata?.belongsTo?.series) {
      const belongsTo = book.metadata.belongsTo.series;
      const series = Array.isArray(belongsTo) ? belongsTo[0] : belongsTo;
      if (series) {
        book.metadata.series = formatTitle(series.name);
        book.metadata.seriesIndex = parseFloat(series.position || '0');
        if (series.total) book.metadata.seriesTotal = parseInt(series.total, 10);
      }
    }

    return true;
  } finally {
    try {
      await bookDoc?.destroy?.();
    } catch {}
    const f = file as ClosableFile;
    if (f && f.close) {
      await f.close();
    }
  }
}

export async function exportBook(
  fs: FileSystem,
  book: Book,
  resolveFilePath: (path: string, base: BaseDir) => Promise<string>,
  copyFile: (srcPath: string, srcBase: BaseDir, dstPath: string, dstBase: BaseDir) => Promise<void>,
  saveFile: (
    filename: string,
    content: ArrayBuffer,
    options?: { filePath?: string; mimeType?: string },
  ) => Promise<boolean>,
): Promise<boolean> {
  const { source, file } = await openBookFileContent(fs, book);
  const content = await file.arrayBuffer();
  const filename = `${makeSafeFilename(book.title)}.${book.format.toLowerCase()}`;
  const mimeType = file.type || 'application/octet-stream';
  if (source.kind === 'url') {
    return await saveFile(filename, content, { mimeType });
  }
  let filePath = await resolveFilePath(source.path, source.base);
  if (getFilename(filePath) !== filename) {
    await copyFile(source.path, source.base, filename, 'Temp');
    filePath = await resolveFilePath(filename, 'Temp');
  }
  return await saveFile(filename, content, { filePath, mimeType });
}
