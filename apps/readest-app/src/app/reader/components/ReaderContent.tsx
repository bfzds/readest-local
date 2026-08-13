'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { Book } from '@/types/book';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useSidebarStore } from '@/store/sidebarStore';
import { useGamepad } from '@/hooks/useGamepad';
import { useTranslation } from '@/hooks/useTranslation';
import { SystemSettings } from '@/types/settings';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { UnlistenFn, emitTo, listen } from '@tauri-apps/api/event';
import { tauriHandleOnCloseWindow } from '@/utils/window';
import { isTauriAppPlatform } from '@/services/environment';
import { uniqueId } from '@/utils/misc';
import { throttle } from '@/utils/throttle';
import { eventDispatcher } from '@/utils/event';
import {
  closeReaderWindowOrGoToLibrary,
  ensureMainLibraryWindow,
  navigateToLibrary,
} from '@/utils/nav';
import { BOOK_IDS_SEPARATOR } from '@/services/constants';
import { BookDetailModal } from '@/components/metadata';

import useBooksManager from '../hooks/useBooksManager';
import useBookShortcuts from '../hooks/useBookShortcuts';
import Spinner from '@/components/Spinner';
import SideBar from './sidebar/SideBar';
import Notebook from './notebook/Notebook';
import BooksGrid from './BooksGrid';
import SettingsDialog from '@/components/settings/SettingsDialog';

const ReaderContent: React.FC<{ ids?: string; settings: SystemSettings }> = ({ ids, settings }) => {
  const _ = useTranslation();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { envConfig, appService } = useEnv();
  const { bookKeys, dismissBook } = useBooksManager();
  const { sideBarBookKey, setSideBarBookKey } = useSidebarStore();
  const { saveSettings } = useSettingsStore();
  const { getConfig, getBookData, saveConfig } = useBookDataStore();
  const { getView, setBookKeys, getViewSettings } = useReaderStore();
  const { initViewState, getViewState, clearViewState } = useReaderStore();
  const { isSettingsDialogOpen, settingsDialogBookKey } = useSettingsStore();
  const [showDetailsBook, setShowDetailsBook] = useState<Book | null>(null);
  const isInitiating = useRef(false);
  const [loading, setLoading] = useState(false);
  const [errorLoading, setErrorLoading] = useState(false);

  useBookShortcuts({ sideBarBookKey, bookKeys });
  useGamepad();

  useEffect(() => {
    if (isInitiating.current) return;
    isInitiating.current = true;

    const pathname = window.location.pathname;
    const bookIds = ids || searchParams?.get('ids') || pathname.split('/reader/')[1] || '';
    const initialIds = bookIds.split(BOOK_IDS_SEPARATOR).filter(Boolean);
    const initialId = initialIds[0];
    if (!initialId) return;
    const initialBookKey = `${initialId}-${uniqueId()}`;
    setBookKeys([initialBookKey]);
    console.log('Initialize books', [initialBookKey]);
    if (!getViewState(initialBookKey)) {
      initViewState(envConfig, initialId, initialBookKey, true).catch((error) => {
        console.log('Error initializing book', initialBookKey, error);
        setErrorLoading(true);
        eventDispatcher.dispatch('toast', {
          message: _('Unable to open book'),
          callback: async () => {
            const service = await envConfig.getAppService();
            await closeReaderWindowOrGoToLibrary(service, router);
          },
          timeout: 2000,
          type: 'error',
        });
      });
      setSideBarBookKey(initialBookKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleShowBookDetails = (event: CustomEvent) => {
      setShowDetailsBook(event.detail as Book);
      return true;
    };
    eventDispatcher.onSync('show-book-details', handleShowBookDetails);

    return () => {
      eventDispatcher.offSync('show-book-details', handleShowBookDetails);
    };
  }, []);

  useEffect(() => {
    if (bookKeys && bookKeys.length > 0) {
      const settings = useSettingsStore.getState().settings;
      const lastOpenBooks = bookKeys.map((key) => key.split('-')[0]!);
      if (settings.lastOpenBooks?.toString() !== lastOpenBooks.toString()) {
        settings.lastOpenBooks = lastOpenBooks;
        saveSettings(envConfig, settings);
      }
    }

    let unlistenOnCloseWindow: Promise<UnlistenFn>;
    if (appService?.hasWindow) {
      unlistenOnCloseWindow = tauriHandleOnCloseWindow(handleCloseBooks).catch((error) => {
        console.info('Failed to register close-window listener:', error);
        return () => {};
      });
    }
    window.addEventListener('beforeunload', handleCloseBooks);
    eventDispatcher.on('beforereload', handleCloseBooks);
    eventDispatcher.on('close-reader', handleCloseReaderToLibrary);
    eventDispatcher.on('quit-app', handleCloseBooks);
    return () => {
      window.removeEventListener('beforeunload', handleCloseBooks);
      eventDispatcher.off('beforereload', handleCloseBooks);
      eventDispatcher.off('close-reader', handleCloseReaderToLibrary);
      eventDispatcher.off('quit-app', handleCloseBooks);
      unlistenOnCloseWindow?.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKeys, appService?.hasWindow]);

  // Safety net: if a reader window ever finds itself with no books open (e.g.
  // a close raced the store update), close the window instead of leaving a
  // blank reader page behind. Only fires after this window has had books, so
  // the initial empty state before initViewState populates bookKeys is ignored.
  const hadBooksRef = useRef(false);
  const closedEmptyReaderRef = useRef(false);
  useEffect(() => {
    if (bookKeys && bookKeys.length > 0) {
      hadBooksRef.current = true;
      return;
    }
    if (hadBooksRef.current && !closedEmptyReaderRef.current && appService?.hasWindow) {
      const currentWindow = getCurrentWindow();
      if (currentWindow.label.startsWith('reader')) {
        closedEmptyReaderRef.current = true;
        void closeReaderWindowOrGoToLibrary(appService, router);
      }
    }
  }, [bookKeys, appService, router]);

  // Heartbeat for the main window's reader-window watchdog: a crashed webview
  // (blank window) stops emitting, so the watchdog can destroy it instead of
  // leaving it as a permanent blank window.
  useEffect(() => {
    if (!appService?.hasWindow) return;
    const currentWindow = getCurrentWindow();
    if (!currentWindow.label.startsWith('reader')) return;
    const heartbeat = () => {
      emitTo('main', 'reader-window-alive', { label: currentWindow.label }).catch(() => {});
    };
    heartbeat();
    const timer = setInterval(heartbeat, 3000);
    return () => clearInterval(timer);
  }, [appService?.hasWindow]);

  // Plan A window reuse: the library routes a newly-opened book to this window
  // via a cross-window `open-book` event. Forward it to the existing
  // open-book-in-reader flow, which swaps the current book in-place (no reload).
  useEffect(() => {
    if (!appService?.hasWindow) return;
    const unlisten = listen<{ bookHash?: string; cfi?: string }>('open-book', (event) => {
      const { bookHash, cfi } = event.payload;
      if (bookHash) {
        eventDispatcher.dispatch('open-book-in-reader', { bookHash, cfi });
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [appService?.hasWindow]);

  const saveBookConfig = async (bookKey: string) => {
    const config = getConfig(bookKey);
    const { book } = getBookData(bookKey) || {};
    const { isPrimary } = getViewState(bookKey) || {};
    if (isPrimary && book && config) {
      const settings = useSettingsStore.getState().settings;
      await saveConfig(envConfig, bookKey, config, settings);
    }
  };

  const saveConfigAndCloseBook = async (bookKey: string, keepTTSAlive = false) => {
    console.log('Closing book', bookKey);

    try {
      getView(bookKey)?.close();
      getView(bookKey)?.remove();
    } catch {
      console.info('Error closing book', bookKey);
    }
    // Closes that keep the webview alive (back to library, Android back, pane
    // dismiss) let a live TTS session continue in the background;
    // webview-destroying closes (quit, window close, reload) hard-stop so the
    // media session and Android foreground service tear down with the page.
    eventDispatcher.dispatch(keepTTSAlive ? 'tts-close-book' : 'tts-stop', {
      bookKey,
    });
    await saveBookConfig(bookKey);
    clearViewState(bookKey);
  };

  const navigateBackToLibrary = () => {
    navigateToLibrary(router, '', undefined, true);
  };

  const saveSettingsAndGoToLibrary = () => {
    saveSettings(envConfig, settings);
    navigateBackToLibrary();
  };

  const handleCloseReaderToLibrary = () => {
    return handleCloseBooks(true);
  };

  // Also wired directly to beforeunload/quit-app/window-close, which pass an
  // event object: only a literal `true` keeps TTS alive.
  const handleCloseBooks = throttle(async (keepTTSAlive?: unknown) => {
    const settings = useSettingsStore.getState().settings;
    await Promise.all(
      bookKeys.map(async (key) => await saveConfigAndCloseBook(key, keepTTSAlive === true)),
    );
    await saveSettings(envConfig, settings);
  }, 200);

  const handleCloseBooksToLibrary = async () => {
    // SPA navigation in the main window (or on web) keeps the webview alive:
    // TTS may continue headless. Non-main Tauri windows hide their webview
    // (Plan A reuse), but their per-window TTS dies with the window either way.
    handleCloseBooks(true);
    if (isTauriAppPlatform()) {
      const currentWindow = getCurrentWindow();
      if (currentWindow.label === 'main') {
        navigateBackToLibrary();
      } else {
        if (appService) {
          await ensureMainLibraryWindow(appService);
        }
        // Hide the reused reader window instead of destroying it.
        await currentWindow.hide();
      }
    } else {
      navigateBackToLibrary();
    }
  };

  const handleCloseBook = async (bookKey: string) => {
    // Header X / pane close: an SPA-side close on web and the main window.
    // The Tauri reader-window branches below hide the reused reader window
    // (Plan A) instead of destroying it, taking the per-window TTS with it.
    const isLastBook = bookKeys.filter((key) => key !== bookKey).length === 0;
    if (isLastBook && appService?.hasWindow) {
      const currentWindow = getCurrentWindow();
      if (currentWindow.label.startsWith('reader')) {
        // Plan A reuse: hide (not destroy) the reader window so it stays warm
        // for the next open. bookKeys is not cleared — the window keeps the
        // current book until the next open swaps it in-place, so we never
        // render a blank window. Stop the book's TTS (it would otherwise keep
        // playing in the hidden window), then bring the library to the front.
        eventDispatcher.dispatch('tts-stop', { bookKey });
        // 方案A：书库窗口在阅读页打开期间被隐藏（未销毁），这里 show 回来即可。
        // 若书库已被销毁（用户主动关掉、异常路径），直接关闭阅读窗退出，绝不
        // 复活出第二个书库窗口（避免"假重启"）。
        const libraryOk = await ensureMainLibraryWindow(appService, {
          createIfMissing: false,
        });
        if (libraryOk) {
          await currentWindow.hide();
        } else {
          await currentWindow.close();
        }
        return;
      }
    }
    saveConfigAndCloseBook(bookKey, true);
    dismissBook(bookKey);
    if (isLastBook) {
      saveSettingsAndGoToLibrary();
    }
  };

  if (!bookKeys || bookKeys.length === 0) return null;
  const bookData = getBookData(bookKeys[0]!);
  const viewSettings = getViewSettings(bookKeys[0]!);
  if (!bookData || !bookData.book || !bookData.bookDoc || !viewSettings) {
    setTimeout(() => setLoading(true), 200);
    return (
      loading &&
      !errorLoading && (
        <div className='hero hero-content full-height'>
          <Spinner loading={true} />
        </div>
      )
    );
  }

  return (
    <div className='reader-content full-height flex'>
      <SideBar />
      <BooksGrid
        bookKey={bookKeys[0]!}
        onCloseBook={handleCloseBook}
        onGoToLibrary={handleCloseBooksToLibrary}
      />
      {isSettingsDialogOpen && <SettingsDialog bookKey={settingsDialogBookKey} />}
      <Notebook />
      {showDetailsBook && (
        <BookDetailModal
          isOpen={!!showDetailsBook}
          book={showDetailsBook}
          onClose={() => setShowDetailsBook(null)}
        />
      )}
    </div>
  );
};

export default ReaderContent;
