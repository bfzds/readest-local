import { useCallback } from 'react';
import { Book } from '@/types/book';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useAppRouter } from '@/hooks/useAppRouter';
import { eventDispatcher } from '@/utils/event';
import { navigateToReader, showReaderWindow } from '@/utils/nav';
import { useSettingsStore } from '@/store/settingsStore';

/**
 * Shared "open this book" flow used both by per-item taps (`BookshelfItem`) and
 * the recently-read shelf. A stale in-place record is dropped instead of
 * bouncing the user into a broken reader.
 */
export const useOpenBook = () => {
  const _ = useTranslation();
  const router = useAppRouter();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();

  const openBook = useCallback(
    async (book: Book, cfi?: string, options?: { highlightSearchResult?: boolean }) => {
      // In-place books point at a file outside Books/<hash>/ that the user (or
      // another app) may have moved, renamed, or deleted between sessions. Probe
      // the source before navigating: if it's gone, drop the stale record
      // instead of opening the reader only to fail and bounce back.
      if (book.filePath && !book.deletedAt) {
        const available = await appService?.isBookAvailable(book);
        if (!available) {
          eventDispatcher.dispatch('toast', {
            message: _(
              'Book file no longer exists. Confirm deletion to remove it from the library.',
            ),
            type: 'info',
          });
          eventDispatcher.dispatch('delete-books', { ids: [book.hash] });
          return;
        }
      }
      const params = new URLSearchParams();
      if (cfi) params.set('cfi', cfi);
      if (cfi && options?.highlightSearchResult) params.set('highlight', 'search');
      const queryParams = params.size ? params.toString() : undefined;
      if (appService?.hasWindow && settings.openBookInNewWindow) {
        showReaderWindow(appService, [book.hash], queryParams);
      } else {
        setTimeout(() => {
          navigateToReader(router, [book.hash], queryParams);
        }, 0);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appService, router, settings.openBookInNewWindow],
  );

  return { openBook };
};
