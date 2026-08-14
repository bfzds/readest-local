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

// NF5: 等 view 就绪的订阅超时兜底——view 初始化悬挂（不 error 不 inited）时
// 若无超时，订阅永不解除，每次深链打开累积一个僵尸订阅。
const READINESS_TIMEOUT_MS = 10000;

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
    // NF5: view 初始化悬挂时超时解除订阅，防僵尸订阅累积
    setTimeout(() => unsub(), READINESS_TIMEOUT_MS);
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
    // NF5: view 初始化悬挂时超时解除订阅，防僵尸订阅累积
    setTimeout(() => unsub(), READINESS_TIMEOUT_MS);
  };

  // Open a book in-place when a widget/deep link targets a book while a reader
  // is already mounted. REPLACE the open book(s) with the target one (single
  // ids=<hash>) rather than appending: appending produced ids=a+b which, with
  // the OS re-delivering the launch deep link, looped. The store update renders
  // the new book immediately; closing the previous key follows the same path as
  // dismissBook. An optional cfi (annotation deep link) is applied once ready.
  //
  // 会话阅读历史：本会话按打开顺序读过的书。鼠标侧键切书就在这张表上前后
  // 移动（见 advanceSwitch），不扫整个书库——保证每次切到的都是已解析缓存的
  // 书，切换瞬间完成，且绝不因文件缺失报错。组件随 reader 窗口常驻（Plan A
  // 复用窗口，关闭书籍只隐藏、不卸载），故历史跨多次打开保留；内存态，重启即清。
  const navHistoryRef = useRef<string[]>([]);
  const navIndexRef = useRef(-1);
  // 历史长度上限，防止 bookDataStore 里堆积无限多本书的解析数据（每本含
  // bookDoc、章节 DOM 等，内存可观）。超出即淘汰最老一本并释放其解析数据。
  const MAX_HISTORY = 5;
  const recordOpen = (bookHash: string) => {
    const history = navHistoryRef.current;
    if (history[navIndexRef.current] === bookHash) return;
    // 历史是有序的"读过哪些书"列表，不是浏览器的前进/后退栈：把已读过的书
    // 移到末尾（去重），新书 append 到末尾。绝不能按 navIndex 截断（旧实现曾
    // `history.length = navIndex + 1`）——用户侧键切回较早的书后再打开新书，
    // 截断会把切回点之后的历史丢弃，历史被压缩成两三本，侧键切书范围随之
    // 缩小。注意移动已存在的书时要修正 navIndex：被移动的书位于当前书之前时，
    // splice 移除会让当前书的下标前移一位。
    const existingIdx = history.indexOf(bookHash);
    if (existingIdx !== -1) {
      history.splice(existingIdx, 1);
      if (existingIdx < navIndexRef.current) navIndexRef.current--;
    }
    history.push(bookHash);
    navIndexRef.current = history.length - 1;
    while (history.length > MAX_HISTORY) {
      const evicted = history.shift()!;
      navIndexRef.current--;
      const currentHash = useReaderStore.getState().bookKeys[0]?.split('-')[0];
      // 当前正在看的书绝不淘汰其解析数据（它仍在使用）；只有被挤掉的最老历史书需要释放。
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
    // B2：复用 reader 窗口只保留当前打开的 view。换书生成新 key 时必须同步
    // 释放旧 key 的 viewState 及其 FoliateView——view.close() 销毁 renderer 并
    // 移除整章 DOM，否则旧 key 永不回收，长会话内存单调增长（700-970MB 高位
    // 内存的主要来源之一）。clearViewState 在其它路径（显式关闭、编辑重存）
    // 也会调用，此处只在换书产生新 key 时补上。
    for (const k of useReaderStore.getState().bookKeys) {
      if (k === newKey) continue;
      useReaderStore.getState().getView(k)?.close?.();
      useReaderStore.getState().clearViewState(k);
    }
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

  // 鼠标侧键导航（见 useMouseNavigation）：后退 = 会话历史上一本，前进 = 下一本。
  // 只换阅读内容，复用 reader 窗口的位置与尺寸不变。连按串行处理（一次切一本，
  // switchInFlightRef 保证）；走到历史头/尾时清空待切队列而不是报错。
  //
  // 历史里可能残留已删除的书：Plan A 复用 reader 窗口，关闭书籍只隐藏、历史跨
  // 打开保留；而删除书会 clearBookData 掉它的解析数据。若切到这种书，openBook
  // 会重新 initViewState 一个已不存在的文件，报 "Book not found"。因此按方向
  // 跳过任何解析数据已消失的历史条目——数据在 = 书仍有效（侧键切到的历史书
  // 必然已解析过，数据缺失即异常，不必怀疑误判）。
  const pendingDirRef = useRef(0);
  const switchInFlightRef = useRef(false);
  const advanceSwitch = () => {
    if (switchInFlightRef.current || pendingDirRef.current === 0) return;
    const dir = pendingDirRef.current > 0 ? 1 : -1;
    let idx = navIndexRef.current + dir;
    while (idx >= 0 && idx < navHistoryRef.current.length) {
      if (useBookDataStore.getState().getBookData(navHistoryRef.current[idx]!)) break;
      idx += dir;
    }
    if (idx < 0 || idx >= navHistoryRef.current.length) {
      pendingDirRef.current = 0;
      return;
    }
    pendingDirRef.current -= dir;
    switchInFlightRef.current = true;
    navIndexRef.current = idx;
    // updateUrl:false —— 切书是原地内容替换（不产生历史记录、不触发 ViewTransitions）。
    openBookRef.current(navHistoryRef.current[idx]!, undefined, false, false);
    // 历史书已解析缓存，切换只是 focus/swap —— 下个微任务解锁并继续排空队列
    // （防止切到一本已打开的书时 bookKeys 不变导致的死锁）。
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
