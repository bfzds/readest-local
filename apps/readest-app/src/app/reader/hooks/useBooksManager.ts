import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useSidebarStore } from '@/store/sidebarStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { uniqueId } from '@/utils/misc';
import { navigateToReader } from '@/utils/nav';
import { eventDispatcher } from '@/utils/event';
import { consumePendingTTSAutoplay } from '@/utils/ttsAutoplay';
import { useTranslation } from '@/hooks/useTranslation';

const useBooksManager = () => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const { bookKeys } = useReaderStore();
  const { setBookKeys, initViewState } = useReaderStore();
  const { setSideBarBookKey } = useSidebarStore();
  const [shouldUpdateSearchParams, setShouldUpdateSearchParams] = useState(false);

  useEffect(() => {
    if (shouldUpdateSearchParams) {
      const ids = bookKeys.map((key) => key.split('-')[0]!);
      if (ids.length > 0) {
        navigateToReader(router, ids, searchParams?.toString() || '', { scroll: false });
      }
      setShouldUpdateSearchParams(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKeys, shouldUpdateSearchParams]);

  // initViewState is called fire-and-forget here; it rejects when the book is
  // missing (e.g. "Book not found" after a library reload dropped the in-memory
  // entry). It already records the failure on the view state, so just keep the
  // rejection from becoming an unhandled rejection (READEST-1V) and let the user
  // know the open failed.
  const handleOpenError = (error: unknown) => {
    console.warn('Failed to open book in reader', error);
    eventDispatcher.dispatch('toast', { message: _('Unable to open book'), type: 'error' });
  };

  // Jump the switched-in book to a deep-link cfi (#4887) once its view has
  // finished initing. The freshly-opened FoliateView first lands on the saved
  // reading position, so wait for `inited` and then goTo; mark it a preview so
  // the saved position is not overwritten. The subscription cleans itself up on
  // success or on load failure.
  const goToCfiWhenReady = (bookKey: string, cfi: string) => {
    const jump = () => {
      const { getView, setPreviewMode } = useReaderStore.getState();
      getView(bookKey)?.goTo(cfi);
      setPreviewMode(bookKey, true);
    };
    const ready = (state: ReturnType<typeof useReaderStore.getState>) => {
      const vs = state.viewStates[bookKey];
      return { done: !!vs?.error || (!!vs?.inited && !!vs?.view), ok: !!vs?.inited && !!vs?.view };
    };
    const initial = ready(useReaderStore.getState());
    if (initial.done) {
      if (initial.ok) jump();
      return;
    }
    const unsub = useReaderStore.subscribe((state) => {
      const { done, ok } = ready(state);
      if (!done) return;
      unsub();
      if (ok) jump();
    });
  };

  // Android Auto "Resume last book" cold-start: once the freshly-opened book's
  // view has inited, start read-aloud. Mirrors goToCfiWhenReady's readiness
  // wait. Caveat: unblockAudio (ttsMediaBridge) is gesture-gated on WebAudio, so
  // an Edge-engine autoplay may be a no-op if the launch is not treated as a
  // user gesture on Android WebView; native TTS is unaffected.
  const startTTSWhenReady = (bookKey: string) => {
    const ready = (state: ReturnType<typeof useReaderStore.getState>) => {
      const vs = state.viewStates[bookKey];
      return { done: !!vs?.error || (!!vs?.inited && !!vs?.view), ok: !!vs?.inited && !!vs?.view };
    };
    const initial = ready(useReaderStore.getState());
    if (initial.done) {
      if (initial.ok) eventDispatcher.dispatch('tts-speak', { bookKey });
      return;
    }
    const unsub = useReaderStore.subscribe((state) => {
      const { done, ok } = ready(state);
      if (!done) return;
      unsub();
      if (ok) eventDispatcher.dispatch('tts-speak', { bookKey });
    });
  };

  // Open a book in-place when a widget/deep link targets a book while a reader
  // is already mounted. REPLACE the open book(s) with the target one (single
  // ids=<hash>) rather than appending: appending produced ids=a+b which, with
  // the OS re-delivering the launch deep link, looped. The store update renders
  // the new book immediately; closing the previous key follows the same path as
  // dismissBook. An optional cfi (annotation deep link) is applied once ready.
  // Session read-history: the books opened in THIS reader session, in open
  // order. Side-button navigation walks this list (not the whole library), so
  // every step lands on a book already parsed & cached — instant and never
  // "Book file not found". Reset naturally on restart (in-memory).
  const navHistoryRef = useRef<string[]>([]);
  const navIndexRef = useRef(-1);
  // Bound the read history and evict the dropped books' parsed data so
  // bookDataStore doesn't accumulate an unbounded set of parsed books.
  const MAX_HISTORY = 3;
  const recordOpen = (bookHash: string) => {
    const history = navHistoryRef.current;
    if (history[navIndexRef.current] === bookHash) return;
    history.length = navIndexRef.current + 1;
    history.push(bookHash);
    navIndexRef.current = history.length - 1;
    while (history.length > MAX_HISTORY) {
      const evicted = history.shift()!;
      navIndexRef.current--;
      const currentHash = useReaderStore.getState().bookKeys[0]?.split('-')[0];
      if (evicted !== currentHash) {
        useBookDataStore.getState().clearBookData(evicted);
      }
    }
  };

  const openBookInReader = (bookHash: string, cfi?: string, updateUrl = true, record = true) => {
    if (record) recordOpen(bookHash);
    const existing = bookKeys.find((key) => key.startsWith(bookHash));
    if (existing) {
      setSideBarBookKey(existing);
      if (cfi) goToCfiWhenReady(existing, cfi);
      // Cold-restore autoplay: the deep link can land after this book is
      // already mounted (the app relaunches straight into the reader), and
      // focusing it leaves bookKeys unchanged — the consumption effect below
      // never re-runs — so consume the pending request here too.
      if (consumePendingTTSAutoplay(bookHash)) startTTSWhenReady(existing);
      return;
    }
    const newKey = `${bookHash}-${uniqueId()}`;
    initViewState(envConfig, bookHash, newKey, true).catch(handleOpenError);
    setBookKeys([newKey]);
    setSideBarBookKey(newKey);
    if (updateUrl) setShouldUpdateSearchParams(true);
    if (cfi) goToCfiWhenReady(newKey, cfi);
  };

  // Stable ref so the listener calls the latest closure without re-subscribing.
  const openBookRef = useRef(openBookInReader);
  openBookRef.current = openBookInReader;
  useEffect(() => {
    const handle = (event: CustomEvent) => {
      const { bookHash, cfi } = event.detail as { bookHash: string; cfi?: string };
      openBookRef.current(bookHash, cfi);
    };
    eventDispatcher.on('open-book-in-reader', handle);
    return () => eventDispatcher.off('open-book-in-reader', handle);
  }, []);

  // Mouse side-button navigation (see useMouseNavigation): back = previous book
  // in this session's read history, forward = next. Only the reading content
  // swaps in place — the reused reader window keeps its position and size.
  // Rapid presses serialize (one switch at a time); stepping past the start/end
  // of the history clears the queue instead of erroring.
  const pendingDirRef = useRef(0);
  const switchInFlightRef = useRef(false);
  const advanceSwitch = () => {
    if (switchInFlightRef.current || pendingDirRef.current === 0) return;
    const dir = pendingDirRef.current > 0 ? 1 : -1;
    const idx = navIndexRef.current + dir;
    if (idx < 0 || idx >= navHistoryRef.current.length) {
      pendingDirRef.current = 0;
      return;
    }
    pendingDirRef.current -= dir;
    switchInFlightRef.current = true;
    navIndexRef.current = idx;
    // updateUrl:false keeps the reader URL unchanged — switching books is an
    // in-place content swap (no history entry, no ViewTransitions churn).
    openBookRef.current(navHistoryRef.current[idx]!, undefined, false, false);
    // History books are already parsed & cached, so a switch is just a
    // focus/swap — release the lock on the next microtask and drain the queue
    // (avoids deadlocking when a step lands on an already-open book, which
    // never changes bookKeys).
    queueMicrotask(() => {
      switchInFlightRef.current = false;
      void advanceSwitch();
    });
  };
  const switchBook = (direction: -1 | 1) => {
    pendingDirRef.current += direction;
    void advanceSwitch();
  };
  useEffect(() => {
    const onBack = () => switchBook(-1);
    const onForward = () => switchBook(1);
    eventDispatcher.on('library-nav-back', onBack);
    eventDispatcher.on('library-nav-forward', onForward);
    return () => {
      eventDispatcher.off('library-nav-back', onBack);
      eventDispatcher.off('library-nav-forward', onForward);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed the read-history with the initially opened book.
  useEffect(() => {
    if (navHistoryRef.current.length === 0) {
      const initialHash = bookKeys[0]?.split('-')[0];
      if (initialHash) {
        navHistoryRef.current = [initialHash];
        navIndexRef.current = 0;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKeys]);

  // Consume an Android Auto cold-resume autoplay request once its book is in the
  // open set (covers both the in-place open and cold-navigate paths).
  useEffect(() => {
    for (const key of bookKeys) {
      if (consumePendingTTSAutoplay(key.split('-')[0]!)) {
        startTTSWhenReady(key);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKeys]);

  // Close a book and sync with bookKeys and URL
  const dismissBook = (bookKey: string) => {
    const updatedKeys = bookKeys.filter((key) => key !== bookKey);
    setBookKeys(updatedKeys);
    setShouldUpdateSearchParams(true);
  };

  return {
    bookKeys,
    dismissBook,
  };
};

export default useBooksManager;
