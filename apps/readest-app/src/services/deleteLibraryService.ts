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

  await appService.saveLibraryBooks([], { replace: true });
};
