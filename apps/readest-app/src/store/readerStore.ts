import { create } from 'zustand';

import {
  BookContent,
  BookConfig,
  PageInfo,
  BookProgress,
  ViewSettings,
  TimeInfo,
  FIXED_LAYOUT_FORMATS,
} from '@/types/book';
import { Insets } from '@/types/misc';
import { EnvConfigType } from '@/services/environment';
import { FoliateView } from '@/types/view';
import { DocumentLoader, TOCItem } from '@/libs/document';
import { computeBookNav, hydrateBookNav, isBookNavCacheCurrent, updateToc } from '@/services/nav';
import { formatTitle, getMetadataHash, getPrimaryLanguage } from '@/utils/book';
import { getBaseFilename } from '@/utils/path';
import { perfMark } from '@/utils/perf';
import { parsePixivNovelFilename } from '@/utils/pixivNovel';
import { SUPPORTED_LANGNAMES } from '@/services/constants';
import { useSettingsStore } from './settingsStore';
import { BookData, useBookDataStore } from './bookDataStore';
import { useLibraryStore } from './libraryStore';
import { clearBookProgress, getBookProgress, setBookProgress } from './readerProgressStore';
import { uniqueId } from '@/utils/misc';

// 翻页热路径 setProgress 的耗时采样周期（每 1s 一次）。每页翻页会多次调用
// setProgress（rAF 合帧），逐次埋点会刷爆日志；采样到日志量小且能验证 B4
// 修复后"库写入+订阅"的每页开销是否真降下来。
const PROGRESS_PERF_SAMPLE_MS = 1000;
let lastProgressPerfAt = 0;

interface ViewState {
  /* Unique key for each book view */
  key: string;
  view: FoliateView | null;
  viewerKey: string;
  isPrimary: boolean;
  loading: boolean;
  inited: boolean;
  error: string | null;
  /* `progress` moved to readerProgressStore — see that file's header for
     rationale. Use `useBookProgress(key)` for reactive subscription or
     `getBookProgress(key)` for one-shot reads. */
  ribbonVisible: boolean;
  ttsEnabled: boolean;
  /* True while an Auto Scroll session (#4998) is engaged for this view;
     session-only, never persisted. Drives the View menu checkmark. */
  autoScrollEnabled: boolean;
  syncing: boolean;
  gridInsets: Insets | null;
  /* True while the reader is showing a position requested by an external
     deep link (e.g. ?cfi=...) that the user hasn't yet confirmed by reading.
     Progress writers (auto-save, cloud sync, kosync) skip while this is true
     so the user's actual last-read position isn't overwritten by a preview.
     Cleared on the first user-initiated relocate (page turn / scroll). */
  previewMode: boolean;
  /* True while the EPUB inline editor is open for this view (editing state). */
  editing: boolean;
  /* View settings for the view:
    generally view settings have a hierarchy of global settings < book settings < view settings
    view settings for primary view are saved to book config which is persisted to config file
    omitting settings that are not changed from global settings */
  viewSettings: ViewSettings | null;
}

interface ReaderStore {
  viewStates: { [key: string]: ViewState };
  bookKeys: string[];
  hoveredBookKey: string | null;
  /* The action tab selected in the mobile bottom bar (font/color/progress);
     lives here rather than in FooterBar state so the TTS mini player can
     stack above the expanded panel. Persists across bar hide/show. */
  bottomBarTab: string;
  setBookKeys: (keys: string[]) => void;
  setHoveredBookKey: (key: string | null) => void;
  setBottomBarTab: (tab: string) => void;
  setBookmarkRibbonVisibility: (key: string, visible: boolean) => void;
  setTTSEnabled: (key: string, enabled: boolean) => void;
  setAutoScrollEnabled: (key: string, enabled: boolean) => void;
  setIsLoading: (key: string, loading: boolean) => void;
  setIsSyncing: (key: string, syncing: boolean) => void;
  setProgress: (
    key: string,
    location: string,
    tocItem: TOCItem,
    pageItem: BookProgress['pageItem'],
    section: PageInfo,
    pageinfo: PageInfo,
    timeinfo: TimeInfo,
    range: Range,
    fraction: number,
  ) => void;
  getProgress: (key: string) => BookProgress | null;
  setView: (key: string, view: FoliateView) => void;
  getView: (key: string | null) => FoliateView | null;
  getViews: () => FoliateView[];
  getViewsById: (id: string) => FoliateView[];
  setViewSettings: (key: string, viewSettings: ViewSettings) => void;
  getViewSettings: (key: string) => ViewSettings | null;

  initViewState: (
    envConfig: EnvConfigType,
    id: string,
    key: string,
    isPrimary?: boolean,
    reload?: boolean,
  ) => Promise<void>;
  clearViewState: (key: string) => void;
  getViewState: (key: string) => ViewState | null;
  getGridInsets: (key: string) => Insets | null;
  setGridInsets: (key: string, insets: Insets | null) => void;
  setViewInited: (key: string, inited: boolean) => void;
  setPreviewMode: (key: string, previewMode: boolean) => void;
  setEditing: (key: string, editing: boolean) => void;
  recreateViewer: (envConfig: EnvConfigType, key: string) => void;
}

export const useReaderStore = create<ReaderStore>((set, get) => ({
  viewStates: {},
  bookKeys: [],
  hoveredBookKey: null,
  bottomBarTab: '',
  setBookKeys: (keys: string[]) => set({ bookKeys: keys }),
  setHoveredBookKey: (key: string | null) => set({ hoveredBookKey: key }),
  setBottomBarTab: (tab: string) => set({ bottomBarTab: tab }),
  getView: (key: string | null) => (key && get().viewStates[key]?.view) || null,
  setView: (key: string, view) =>
    set((state) => ({
      viewStates: {
        ...state.viewStates,
        [key]: { ...state.viewStates[key]!, view },
      },
    })),
  getViews: () => Object.values(get().viewStates).map((state) => state.view!),
  getViewsById: (id: string) => {
    const { viewStates } = get();
    return Object.values(viewStates)
      .filter((state) => state.key && state.key.startsWith(id))
      .map((state) => state.view!);
  },

  clearViewState: (key: string) => {
    // Drop the per-book progress entry alongside the view state so the
    // standalone progress store doesn't leak across opens/closes.
    clearBookProgress(key);
    set((state) => {
      const viewStates = { ...state.viewStates };
      delete viewStates[key];
      return { viewStates };
    });
  },
  getViewState: (key: string) => get().viewStates[key] || null,
  initViewState: async (
    envConfig: EnvConfigType,
    id: string,
    key: string,
    isPrimary = true,
    reload = false,
  ) => {
    const t0 = perfMark('initViewState', 'start');
    const booksData = useBookDataStore.getState().booksData;
    const bookData = booksData[id];
    set((state) => ({
      viewStates: {
        ...state.viewStates,
        [key]: {
          key: '',
          view: null,
          viewerKey: '',
          isPrimary: false,
          loading: true,
          inited: false,
          error: null,
          ribbonVisible: false,
          ttsEnabled: false,
          autoScrollEnabled: false,
          syncing: false,
          gridInsets: null,
          previewMode: false,
          editing: false,
          viewSettings: null,
        },
      },
    }));
    try {
      const appService = await envConfig.getAppService();
      const { settings } = useSettingsStore.getState();
      const { getBookByHash, library, setLibrary } = useLibraryStore.getState();
      let book = getBookByHash(id);
      if (!book) {
        // 全新书首次打开竞态兜底：阅读窗口是独立 store，挂载时从磁盘加载书库，
        // 可能早于主窗口 saveLibraryBooks 写盘完成，读到不含新书的旧清单
        // （仅"从未导入过"的书会踩中——已导入/已删书永远在清单里）。
        // 此时磁盘通常已写入，从头重读一次书库再查（罕见窗口才多一次读盘）。
        console.warn(
          `Book ${id} not in in-memory library (size=${library.length}); reloading from disk`,
        );
        const reloaded = await appService.loadLibraryBooks();
        setLibrary(reloaded);
        book = getBookByHash(id);
      }
      if (!book) {
        console.error(
          `Book ${id} not found in library after disk reload (size=${library.length});`,
        );
        throw new Error('Book not found');
      }
      let bookDoc = bookData?.bookDoc;
      let file: File | null = bookData?.file ?? null;
      if (!bookDoc || !file || reload) {
        console.log('Loading book', key);
        const content = (await appService.loadBookContent(book)) as BookContent;
        file = content.file;
        let nativeFilePath: string | null = null;
        try {
          nativeFilePath = await appService.resolveNativeBookFilePath(book);
        } catch (err) {
          console.warn('resolveNativeBookFilePath failed', err);
        }
        const doc = await new DocumentLoader(file, {
          nativeFilePath: nativeFilePath ?? undefined,
        }).open();
        bookDoc = doc.book;
      }
      if (!bookDoc) {
        throw new Error('Failed to load book document');
      }
      perfMark('initViewState', 'parse', t0);
      const config = await appService.loadBookConfig(book, settings);
      perfMark('initViewState', 'config', t0);
      // Import annotations from third-party readers on first open
      if (bookDoc.metadata.identifier) {
        const { getAnnotationProviders } = await import('@/services/annotation');
        for (const provider of getAnnotationProviders()) {
          if (provider.isAvailable(appService)) {
            const merged = await provider.importAnnotations(
              appService,
              bookDoc.metadata.identifier,
              config,
            );
            if (merged !== config) {
              Object.assign(config, merged);
              await appService.saveBookConfig(book, config, settings);
            }
          }
        }
      }
      // Filter out invalid booknotes
      config.booknotes = config.booknotes?.filter((booknote) => booknote.cfi) ?? [];
      // Load cached book navigation (TOC + section fragments) or compute and persist.
      if (book.format === 'EPUB' && bookDoc.rendition?.layout !== 'pre-paginated') {
        const cachedNav = await appService.loadBookNav(book);
        if (isBookNavCacheCurrent(cachedNav) && process.env.NODE_ENV === 'production') {
          hydrateBookNav(bookDoc, cachedNav);
        } else {
          const freshNav = await computeBookNav(bookDoc);
          hydrateBookNav(bookDoc, freshNav);
          try {
            await appService.saveBookNav(book, freshNav);
          } catch (e) {
            console.warn('Failed to persist book nav cache:', e);
          }
        }
      }
      await updateToc(
        bookDoc,
        config.viewSettings?.sortedTOC ?? false,
        config.viewSettings?.convertChineseVariant ?? 't2s',
      );
      perfMark('initViewState', 'nav', t0);
      if (!bookDoc.metadata.title && file) {
        bookDoc.metadata.title =
          parsePixivNovelFilename(file.name)?.title || getBaseFilename(file.name);
      }
      book.sourceTitle = formatTitle(bookDoc.metadata.title);
      // Correct language codes mistakenly set with language names
      if (typeof bookDoc.metadata?.language === 'string') {
        if (bookDoc.metadata.language in SUPPORTED_LANGNAMES) {
          bookDoc.metadata.language = SUPPORTED_LANGNAMES[bookDoc.metadata.language]!;
        }
      }
      // Set the book's language for formerly imported books, newly imported books have this field set
      const primaryLanguage = getPrimaryLanguage(bookDoc.metadata.language);
      book.primaryLanguage = book.primaryLanguage ?? primaryLanguage;
      book.metadata = book.metadata ?? bookDoc.metadata;

      // Update series info from metadata if available and not already set on the book
      if (bookDoc.metadata.belongsTo?.series) {
        const belongsTo = bookDoc.metadata.belongsTo.series;
        const series = Array.isArray(belongsTo) ? belongsTo[0] : belongsTo;
        if (series) {
          book.metadata.series = book.metadata.series ?? formatTitle(series.name);
          book.metadata.seriesIndex =
            book.metadata.seriesIndex ?? parseFloat(series.position || '0');
          book.metadata.seriesTotal =
            book.metadata.seriesTotal ?? (series.total ? parseInt(series.total, 10) : undefined);
        }
      }
      // TODO: uncomment this when we can ensure metaHash is correctly generated for all books
      // book.metaHash = book.metaHash ?? getMetadataHash(bookDoc.metadata);
      // PDF metaHash is salted with the original import filename (issue #5411),
      // which is lost after import — keep the value stamped at import time.
      if (book.format !== 'PDF' || !book.metaHash) {
        book.metaHash = getMetadataHash(bookDoc.metadata);
      }

      const isFixedLayout =
        bookDoc.rendition?.layout === 'pre-paginated' || FIXED_LAYOUT_FORMATS.has(book.format);
      const newBookData: BookData = { id, book, file, config, bookDoc, isFixedLayout };
      useBookDataStore.setState((state) => ({
        booksData: {
          ...state.booksData,
          [id]: newBookData,
        },
      }));
      const configViewSettings = config.viewSettings!;
      const globalViewSettings = settings.globalViewSettings;
      perfMark('initViewState', 'total', t0);
      set((state) => ({
        viewStates: {
          ...state.viewStates,
          [key]: {
            ...state.viewStates[key],
            key,
            view: null,
            viewerKey: `${key}-${uniqueId()}`,
            isPrimary,
            loading: false,
            inited: false,
            error: null,
            ribbonVisible: false,
            ttsEnabled: false,
            autoScrollEnabled: false,
            syncing: false,
            gridInsets: null,
            previewMode: false,
            editing: false,
            viewSettings: { ...globalViewSettings, ...configViewSettings },
          },
        },
      }));
    } catch (error) {
      console.error(error);
      set((state) => ({
        viewStates: {
          ...state.viewStates,
          [key]: {
            ...state.viewStates[key],
            key: '',
            view: null,
            viewerKey: '',
            isPrimary: false,
            loading: false,
            inited: false,
            error: 'Failed to load book.',
            ribbonVisible: false,
            ttsEnabled: false,
            autoScrollEnabled: false,
            syncing: false,
            gridInsets: null,
            previewMode: false,
            editing: false,
            viewSettings: null,
          },
        },
      }));
      throw error;
    }
  },
  getViewSettings: (key: string) => get().viewStates[key]?.viewSettings || null,
  setViewSettings: (key: string, viewSettings: ViewSettings) => {
    if (!key) return;
    const id = key.split('-')[0]!;
    const bookData = useBookDataStore.getState().booksData[id];
    const viewState = get().viewStates[key];
    if (!viewState || !bookData) return;
    if (viewState.isPrimary) {
      useBookDataStore.setState((state) => ({
        booksData: {
          ...state.booksData,
          [id]: {
            ...bookData,
            config: {
              ...bookData.config,
              updatedAt: Date.now(),
              viewSettings,
            },
          },
        },
      }));
    }
    set((state) => ({
      viewStates: {
        ...state.viewStates,
        [key]: {
          ...state.viewStates[key]!,
          viewSettings,
        },
      },
    }));
  },
  // Delegates to the standalone readerProgressStore so that progress reads
  // do not subscribe the caller to readerStore. Most call sites need a
  // one-shot read (event handlers, useEffect bodies). Components that
  // genuinely depend on progress for rendering should subscribe via the
  // `useBookProgress(key)` hook exported from readerProgressStore instead.
  getProgress: (key: string) => getBookProgress(key),
  setProgress: (
    key: string,
    location: string,
    tocItem: TOCItem,
    pageItem: BookProgress['pageItem'],
    section: PageInfo,
    pageinfo: PageInfo,
    timeinfo: TimeInfo,
    range: Range,
    fraction: number,
  ) => {
    const sampleStart = performance.now();
    const sampled = sampleStart - lastProgressPerfAt >= PROGRESS_PERF_SAMPLE_MS;
    if (sampled) lastProgressPerfAt = sampleStart;
    const id = key.split('-')[0]!;
    const bookData = useBookDataStore.getState().booksData[id];
    const viewState = get().viewStates[key];
    if (!viewState || !bookData) return;

    const pageInfo = bookData.isFixedLayout ? section : pageinfo;
    const progress: [number, number] = [pageInfo.current + 1, pageInfo.total];
    // NF4: total===0 时分页未就绪，除零得 Infinity 会误标 finished——此时记为 0。
    const progressPercentage = progress[1] > 0 ? Math.round((progress[0] / progress[1]) * 100) : 0;

    // Lightweight library update — O(1) lookup, no array copy, no refreshGroups
    const { getBookByHash, updateBookProgress } = useLibraryStore.getState();
    const existingBook = getBookByHash(id);
    if (existingBook) {
      let newReadingStatus = existingBook.readingStatus;
      if (existingBook.readingStatus === 'unread') {
        newReadingStatus = undefined;
      }
      if (progressPercentage >= 100 && existingBook.readingStatus !== 'finished') {
        newReadingStatus = 'finished';
      }
      updateBookProgress(id, progress, newReadingStatus);
    }

    // Only the primary view persists progress into the shared bookData
    // config. Skip the bookDataStore write entirely when not primary to spare
    // its subscribers a re-render.
    if (viewState.isPrimary) {
      const existing = useBookDataStore.getState().booksData[id];
      // NF3: 仅在 location（CFI）变化时写 bookDataStore——翻页动画期间同页
      // 各帧 location 相同，原先每帧 setState 触发 ~26 处无 selector 订阅的
      // 组件整树重渲。location 同时是 useProgressAutoSave 的持久化键，同一
      // 位置进度稳定，故"变化才写"不丢持久化（翻页/跳转时 location 必变）。
      if (existing && existing.config?.location !== location) {
        useBookDataStore.setState((state) => {
          const current = state.booksData[id];
          if (!current) return state;
          return {
            booksData: {
              ...state.booksData,
              [id]: {
                ...current,
                config: {
                  ...current.config,
                  progress,
                  location,
                } as BookConfig,
              },
            },
          };
        });
      }
    }

    // Write progress to the standalone store. This is the only setState on
    // the hot swipe path that the previous implementation routed through
    // the (much bigger) readerStore — the split here is the whole point of
    // the refactor: components subscribing to `useReaderStore()` without a
    // selector will no longer re-render per page turn.
    setBookProgress(key, {
      location,
      sectionHref: tocItem?.href,
      sectionLabel: tocItem?.label,
      pageItem,
      section,
      pageinfo,
      timeinfo,
      fraction,
      index: section.current,
      range,
      page: pageInfo.current + 1,
    } as BookProgress);
    if (sampled) perfMark('setProgress', 'total', sampleStart);
  },
  setBookmarkRibbonVisibility: (key: string, visible: boolean) =>
    set((state) => ({
      viewStates: {
        ...state.viewStates,
        [key]: {
          ...state.viewStates[key]!,
          ribbonVisible: visible,
        },
      },
    })),

  setTTSEnabled: (key: string, enabled: boolean) =>
    set((state) => ({
      viewStates: {
        ...state.viewStates,
        [key]: {
          ...state.viewStates[key]!,
          ttsEnabled: enabled,
        },
      },
    })),

  setAutoScrollEnabled: (key: string, enabled: boolean) =>
    set((state) => ({
      viewStates: {
        ...state.viewStates,
        [key]: {
          ...state.viewStates[key]!,
          autoScrollEnabled: enabled,
        },
      },
    })),

  setIsLoading: (key: string, loading: boolean) =>
    set((state) => ({
      viewStates: {
        ...state.viewStates,
        [key]: {
          ...state.viewStates[key]!,
          loading,
        },
      },
    })),

  setIsSyncing: (key: string, syncing: boolean) =>
    set((state) => ({
      viewStates: {
        ...state.viewStates,
        [key]: {
          ...state.viewStates[key]!,
          syncing,
        },
      },
    })),

  getGridInsets: (key: string) =>
    get().viewStates[key]?.gridInsets || { top: 0, right: 0, bottom: 0, left: 0 },
  setGridInsets: (key: string, insets: Insets | null) =>
    set((state) => ({
      viewStates: {
        ...state.viewStates,
        [key]: {
          ...state.viewStates[key]!,
          gridInsets: insets,
        },
      },
    })),

  setViewInited: (key: string, inited: boolean) =>
    set((state) => ({
      viewStates: {
        ...state.viewStates,
        [key]: {
          ...state.viewStates[key]!,
          inited,
        },
      },
    })),

  setPreviewMode: (key: string, previewMode: boolean) =>
    set((state) => ({
      viewStates: {
        ...state.viewStates,
        [key]: {
          ...state.viewStates[key]!,
          previewMode,
        },
      },
    })),

  setEditing: (key, editing) =>
    set((state) => {
      const current = state.viewStates[key];
      if (!current) return state;
      return {
        viewStates: {
          ...state.viewStates,
          [key]: { ...current, editing },
        },
      };
    }),

  recreateViewer: (envConfig: EnvConfigType, key: string) => {
    const id = key.split('-')[0]!;
    // `initViewState` already mints a fresh `viewerKey` when the reload lands,
    // which is what remounts <FoliateViewer>. Minting a second one here
    // remounted it twice: the abandoned first mount kept running its async
    // `openBook()` and registered another `data` transform listener on the
    // *same* reloaded bookDoc, so every resource was piped through the
    // transform chain twice. A twice-transformed stylesheet lost all its
    // font-family declarations, and the book fell back to the app font
    // (readest#5277).
    void get().initViewState(envConfig, id, key, true, true);
  },
}));
