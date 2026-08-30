import { AppService } from '@/types/system';

/**
 * Wipe the user's whole library on this device. All rows are hard removals:
 * books, covers, config.json (progress, bookmarks, annotations), nav.json and
 * the TTS cache.
 */
export const deleteAllBooks = async (appService: AppService): Promise<void> => {
  const books = await appService.loadLibraryBooks();
  for (const book of books) {
    try {
      // 'purge' erases the whole Books/<hash>/ dir; its
      // `source.kind === 'managed'` guard is why this must go through
      // deleteBook: books imported in place keep their original file at the
      // user-controlled path (see the in-place delete regression).
      await appService.deleteBook(book, 'purge');
    } catch (error) {
      // One unreadable book must not strand the rest of the library.
      console.error('Failed to purge book:', book.hash, error);
    }
  }

  // B-7：整库删除也把 tombstone 持久化到 library.json（不再 `[]` replace 直接
  // 清空）——否则旧阅读窗口的节流/待保存 routine save 会拿着内存旧数组把
  // 这些书重新写回磁盘（复活）。书架按 `!deletedAt` 过滤，tombstone 只在
  // 下一次启动/其他地方仍持旧数组时充当“已删”护栏。
  const now = Date.now();
  await appService.saveLibraryBooks(
    books.map((book) => ({ ...book, deletedAt: now })),
    { replace: true },
  );
};
