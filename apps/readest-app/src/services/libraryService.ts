import { FileSystem, SaveLibraryBooksOptions } from '@/types/system';
import { Book } from '@/types/book';
import { getLibraryFilename } from '@/utils/book';
import { safeLoadJSON, safeSaveJSON } from './persistence';

const COVER_CONCURRENCY = 20;

async function processInBatches<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(fn));
  }
}

// Merge-floor + LWW：以磁盘库为底（不因旧快照丢书），并对同 hash 行按
// updatedAt 做 last-writer-wins —— 磁盘记录较新时不覆盖，旧阅读窗口不能
// 碾压已持久化的新标题/进度/元数据；删除以 tombstone 形式保留优先。
export const mergeLibraryRows = (existing: Book[], incoming: Book[]): Book[] => {
  const merged = new Map<string, Book>();
  for (const book of existing) merged.set(book.hash, book);
  for (const book of incoming) {
    const onDisk = merged.get(book.hash);
    // 防复活：磁盘已软删，旧窗口陈旧 incoming（无 tombstone）不得覆盖回活。
    if (onDisk && onDisk.deletedAt && !book.deletedAt) continue;
    // LWW：双窗口同时改同一本书时，updatedAt 更新的记录保留。
    if (onDisk && !onDisk.deletedAt && !book.deletedAt) {
      if ((onDisk.updatedAt ?? 0) > (book.updatedAt ?? 0)) continue;
    }
    merged.set(book.hash, book);
  }
  return Array.from(merged.values());
};

export async function loadLibraryBooks(
  fs: FileSystem,
  generateCoverImageUrl: (book: Book) => Promise<string>,
): Promise<Book[]> {
  const libraryFilename = getLibraryFilename();

  if (!(await fs.exists('', 'Books'))) {
    await fs.createDir('', 'Books', true);
  }

  const books = await safeLoadJSON<Book[]>(fs, libraryFilename, 'Books', []);

  await processInBatches(books, COVER_CONCURRENCY, async (book) => {
    book.coverImageUrl = await generateCoverImageUrl(book);
    book.updatedAt ??= book.lastUpdated || Date.now();
  });

  return books;
}

export async function saveLibraryBooks(
  fs: FileSystem,
  books: Book[],
  options?: SaveLibraryBooksOptions,
): Promise<Book[]> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const incoming = books.map(({ coverImageUrl, ...rest }) => rest);

  // 返回实际写入的数据：replace 回写传入数组；routine save 返回 LWW 合并后
  // 的最终快照，供调用方以此为准提交内存（避免用未合并的旧快照覆盖新数据）。
  if (options?.replace) {
    await safeSaveJSON(fs, getLibraryFilename(), 'Books', incoming);
    return incoming;
  }

  // Merge-floor + LWW 合并（详见 mergeLibraryRows）：routine save 永不因旧
  // 快照丢书或碾压较新的磁盘数据；删除走显式 tombstone。
  const existing = await safeLoadJSON<Book[]>(fs, getLibraryFilename(), 'Books', []);
  const merged = mergeLibraryRows(existing, incoming);
  await safeSaveJSON(fs, getLibraryFilename(), 'Books', merged);
  return merged;
}
