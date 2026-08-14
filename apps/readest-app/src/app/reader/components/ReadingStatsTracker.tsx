'use client';

import { useEffect, useRef } from 'react';
import { getBookProgress, useBookProgress } from '@/store/readerProgressStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useEnv } from '@/context/EnvContext';
import { StatisticsDb } from '@/services/statistics/statisticsDb';
import { TrackerCore, type FlushedEvent } from '@/services/statistics/trackerCore';
import { getBookHashFromKey, ttsSessionManager } from '@/services/tts/TTSSessionManager';
import { DEFAULT_STATS_TRACKING_CONFIG } from '@/types/statistics';
import { eventDispatcher } from '@/utils/event';

const nowSec = () => Math.floor(Date.now() / 1000);

// Statistics are best-effort telemetry: a failed write or sync (e.g. the
// statistics DB torn down mid-flight on app teardown -> "database ... not
// loaded", READEST-6) must never surface as an unhandled rejection.
const runBestEffort = (work: Promise<unknown>): void => {
  void work.catch((err) => console.warn('[stats] background operation failed:', err));
};

export default function ReadingStatsTracker({ bookKey }: { bookKey: string }) {
  const { appService } = useEnv();
  // Progress lives in readerProgressStore, not readerStore.viewStates.
  const progress = useBookProgress(bookKey);
  // booksData is keyed by book id = bookKey.split('-')[0].
  const getBookData = useBookDataStore((s) => s.getBookData);
  const coreRef = useRef(new TrackerCore(DEFAULT_STATS_TRACKING_CONFIG));
  const dbRef = useRef<StatisticsDb | null>(null);
  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // this tracker stands down — otherwise TTS auto-follow's relocations would
  // bill the same wall-clock a second time. Seeded from the manager rather than
  // the event bus alone, so opening the reader from the mini player mid-session
  // doesn't miss the transition that already happened.
  const ttsPlayingRef = useRef(
    ttsSessionManager.getPlaybackState() === 'playing' &&
      ttsSessionManager.getActiveSession()?.bookHash === getBookHashFromKey(bookKey),
  );

  const bookData = getBookData(bookKey);
  const book = bookData?.book;
  // Book.hash is the partialMD5 used as KOReader's md5.
  const bookMd5 = book?.hash;
  const title = book?.title ?? '';
  // Book.author is the single-string author field; upsertBook takes authors: string.
  const authors = book?.author ?? '';

  useEffect(() => {
    if (!appService) return;
    let cancelled = false;
    runBestEffort(
      StatisticsDb.open(appService).then((db) => {
        if (cancelled) return;
        dbRef.current = db;
      }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appService]);

  // Persist flushed events into the statistics DB.
  const persist = async (events: FlushedEvent[]): Promise<void> => {
    const db = dbRef.current;
    if (!db || !bookMd5 || events.length === 0) return;
    try {
      const idBook = await db.upsertBook({ bookMd5, title, authors });
      for (const e of events) await db.insertPageEvent(idBook, e);
      await db.recomputeBookTotals(idBook);
    } catch (err) {
      // The statistics DB can be closed mid-write on app/tab teardown
      // ("database ... not loaded", READEST-6). Best-effort: log and
      // never reject, so the fire-and-forget dispatch sites stay safe.
      console.warn('[stats] failed to persist reading events:', err);
    }
  };

  // SF6: 翻页事件累积到 pending，由 idle/隐藏/关闭等低频率时机批量写库，避免
  // 每次翻页一次 IPC 写入（长时间阅读的写入放大）。统计是后台遥测，非实时 UI，
  // 批量写延迟可接受。
  const pendingRef = useRef<FlushedEvent[]>([]);
  const enqueue = (events: FlushedEvent[]) => {
    if (events.length) pendingRef.current.push(...events);
  };
  const flushPending = async () => {
    if (!pendingRef.current.length) return;
    const batch = pendingRef.current;
    pendingRef.current = [];
    await persist(batch);
  };

  const armIdle = () => {
    if (idleRef.current) clearTimeout(idleRef.current);
    idleRef.current = setTimeout(() => {
      enqueue(coreRef.current.onIdle(nowSec()));
      void flushPending();
    }, DEFAULT_STATS_TRACKING_CONFIG.idleTimeoutSeconds * 1000);
  };

  const openPageAt = (info: { current?: number; total: number } | undefined) => {
    if (!info) return;
    enqueue(coreRef.current.onPage((info.current ?? 0) + 1, info.total || 1, nowSec()));
    armIdle();
  };

  // Page changes drive the tracker.
  useEffect(() => {
    if (ttsPlayingRef.current) return;
    openPageAt(progress?.pageinfo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.pageinfo]);

  // Hand the clock to TtsStatsRecorder while this book is read aloud, and take
  // it back afterwards. TTS turns pages to follow the narration, so without
  // this the same minutes would be recorded by both.
  useEffect(() => {
    const bookHash = getBookHashFromKey(bookKey);
    const onPlaybackState = (event: Event) => {
      const detail = (event as CustomEvent).detail as { bookKey?: string; state?: string };
      // Another book can be playing while this one is read manually.
      if (!detail?.bookKey || getBookHashFromKey(detail.bookKey) !== bookHash) return;
      const playing = detail.state === 'playing';
      if (playing === ttsPlayingRef.current) return;
      ttsPlayingRef.current = playing;
      if (playing) {
        if (idleRef.current) clearTimeout(idleRef.current);
        enqueue(coreRef.current.onIdle(nowSec()));
        void flushPending();
      } else {
        openPageAt(getBookProgress(bookKey)?.pageinfo);
      }
    };
    eventDispatcher.on('tts-playback-state', onPlaybackState);
    return () => eventDispatcher.off('tts-playback-state', onPlaybackState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey]);

  // Tab/window visibility.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        if (idleRef.current) clearTimeout(idleRef.current);
        enqueue(coreRef.current.onHide(nowSec()));
        void flushPending();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookMd5]);

  // Book close (unmount).
  useEffect(() => {
    return () => {
      if (idleRef.current) clearTimeout(idleRef.current);
      enqueue(coreRef.current.onClose(nowSec()));
      runBestEffort(flushPending());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookMd5]);

  return null;
}
