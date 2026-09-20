'use client';

import clsx from 'clsx';
import * as React from 'react';
import { MdChevronRight, MdClose } from 'react-icons/md';
import { useState, useRef, useEffect, Suspense, useCallback } from 'react';
import { ReadonlyURLSearchParams, useSearchParams } from 'next/navigation';

import {
  Book,
  BookVersionConflictChoice,
  BookVersionConflictInfo,
  BooksGroup,
  type LibrarySearchConfig,
} from '@/types/book';
import { AppService, DeleteAction } from '@/types/system';
import {
  buildBookLookupIndex,
  collectKnownSourcePaths,
  normalizeFilePathForIndex,
  selectNewImportableFiles,
  toWatchedFolderImports,
} from '@/services/bookService';
import { debounce } from '@/utils/debounce';
import { createThrottledCheckpoint } from '@/utils/checkpoint';
import { DEFAULT_NEARBY_WORDS } from '@/utils/searchConfig';
import { clearLibrarySearchHistory, loadLibrarySearchHistory } from './utils/searchHistory';
import { isStaleForwardTarget } from './utils/forwardStack';
import type { LibrarySearchTarget } from '@/types/book';
import { navigateToLibrary, navigateToReader } from '@/utils/nav';
import { getBookWithUpdatedMetadata, listFormater } from '@/utils/book';
import { startReaderWindowWatchdog } from '@/utils/readerWindowWatchdog';
import { getImportErrorMessage } from '@/services/errors';
import { ingestFile } from '@/services/ingestService';
import {
  discardImportedBook,
  findBatchVersionConflicts,
  planVersionConflictResolution,
  replaceBookVersion,
} from '@/services/bookVersionService';
import {
  buildVersionComparison,
  loadNewVersionFacts,
  loadOldVersionFacts,
  type VersionComparison,
} from '@/services/bookVersionCompare';
import {
  MAX_PENDING_VERSION_CONFLICTS,
  consumeVersionConflictOverflow,
  enqueueVersionConflicts,
  peekVersionConflicts,
  pendingVersionConflictCount,
  settleVersionConflicts,
} from '@/services/versionConflictQueue';
import { eventDispatcher } from '@/utils/event';
import { getFilename, getFolderImportGroupName, joinScannedPath } from '@/utils/path';
import {
  DEFAULT_WATCHED_FOLDER_MIN_SIZE_KB,
  findStoredWatchedFolderRule,
  isWatchedFolderMode,
  mergeRecordedExtensions,
  resolveImportBatchFolderRule,
  resolveWatchedFolderRule,
  shouldRecordWatchedFilters,
  withWatchedFolderRule,
  withoutWatchedFolderRule,
} from '@/utils/watchedFolders';
import { parseOpenWithFiles } from '@/helpers/openWith';
import { isTauriAppPlatform } from '@/services/environment';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';

import { useEnv } from '@/context/EnvContext';
import { useThemeStore } from '@/store/themeStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import { useTheme } from '@/hooks/useTheme';
import { useUICSS } from '@/hooks/useUICSS';
import { useAutoImportFolders } from './hooks/useAutoImportFolders';
import { useBookDataStore } from '@/store/bookDataStore';
import { useBackgroundTexture } from '@/hooks/useBackgroundTexture';
import { getLibraryViewSettings, saveSysSettings } from '@/helpers/settings';
import { useReadingWidget } from '@/hooks/useReadingWidget';
import { useKeyDownActions } from '@/hooks/useKeyDownActions';
import { SelectedFile, useFileSelector } from '@/hooks/useFileSelector';
import { SUPPORTED_BOOK_EXTS } from '@/services/constants';
import {
  tauriHandleClose,
  tauriHandleOnCloseMainWindow,
  tauriHandleSetAlwaysOnTop,
  tauriHandleToggleFullScreen,
  tauriQuitApp,
  tauriSetWindowTitle,
} from '@/utils/window';

import { LibraryGroupByType, WatchedFolderMode, WatchedFolderRule } from '@/types/settings';
import { BookMetadata } from '@/libs/document';
import { AboutWindow } from '@/components/AboutWindow';
import { KeyboardShortcutsHelp } from '@/components/KeyboardShortcutsHelp';
import { BookDetailModal } from '@/components/metadata';
import { MigrateDataWindow } from './components/MigrateDataWindow';
import { BackupWindow } from './components/BackupWindow';
import { CacheManagerWindow } from './components/CacheManagerWindow';
import { useDragDropImport } from './hooks/useDragDropImport';
import { useAppRouter } from '@/hooks/useAppRouter';
import { Toast } from '@/components/Toast';
import {
  createBookGroups,
  findGroupById,
  getBreadcrumbs,
  getGroupNewBookHashes,
  resolveCurrentGroupBy,
} from './utils/libraryUtils';
import { resolveImportToast } from './utils/importToast';
import {
  AuthorGroupedImport,
  buildAuthorGroupedToastSpec,
  collectGroupNames,
  findAuthorGroupMatch,
  matchesOwnGroupAuthor,
} from './utils/authorGrouping';
import { demoteBookToRoot, shouldDemoteDedupHitToRoot } from './utils/importPlacement';
import Spinner from '@/components/Spinner';
import LibraryHeader from './components/LibraryHeader';
import Bookshelf from './components/Bookshelf';
import LibraryEmptyState from './components/LibraryEmptyState';
import ImportMenuPopup from './components/ImportMenuPopup';
import GroupHeader from './components/GroupHeader';
import FailedImportsDialog, { FailedImport } from './components/FailedImportsDialog';
import ImportFromFolderDialog, {
  ALL_FORMAT_GROUP_EXTENSIONS,
  formatGroupIdsForExtensions,
  ImportFromFolderResult,
} from './components/ImportFromFolderDialog';
import WatchedFoldersDialog, {
  WatchedFolderRow,
  WatchedFolderScanStatus,
} from './components/WatchedFoldersDialog';
import TxtChapterGuideDialog from './components/TxtChapterGuideDialog';
import BookVersionConflictDialog from './components/BookVersionConflictDialog';
import NowPlayingBar from './components/NowPlayingBar';
import { ttsSessionManager } from '@/services/tts';
import useShortcuts from '@/hooks/useShortcuts';
import { useCustomFonts } from '@/hooks/useCustomFonts';
import DropIndicator from '@/components/DropIndicator';
import SettingsDialog from '@/components/settings/SettingsDialog';

/**
 * Key used to persist the last scan result per watched folder (newest first —
 * one timestamp covers the whole run), so the manage dialog can say "last
 * refreshed 3 minutes ago, 2 new books" across sessions. Display-only state:
 * it is never written into settings, which stay the source of truth for the
 * folders themselves.
 */
const WATCHED_FOLDER_STATUS_KEY = 'readest:watchedFolderStatus';

/**
 * How often the library index is persisted during a long import (#5601). A
 * crash/kill mid-run loses at most this much work instead of the entire run;
 * keep it long enough that the full-library serialization stays a rounding
 * error next to the per-file parse/copy work.
 */
const IMPORT_CHECKPOINT_INTERVAL_MS = 15 * 1000;

/**
 * What one import batch reports back to its caller. The per-folder counts exist
 * for the manage-watched-folders dialog, which reports each row's own result
 * ("3 new books" / "nothing new"); files that did not come from a folder scan
 * simply have no bucket.
 */
export interface ImportBooksResult {
  failedPaths: string[];
  /**
   * Records that landed on the shelf — newly imported or revived — keyed by
   * normalized watched-folder path.
   */
  importedByFolder: Record<string, number>;
  /** Files the library already knew, same keying. */
  knownByFolder: Record<string, number>;
  /** Files that failed to import, same keying. */
  failedByFolder: Record<string, number>;
  /** How many books had a source path recorded into the copy-mode ledger. */
  sourcePathsRecorded: number;
}

/** One folder's result from a scan, before it is stored for display. */
interface WatchedFolderScanOutcome {
  folder: string;
  /** Books genuinely new to the library. */
  imported: number;
  /** Files the library already knew (dedup hit) — proof the ledger is working. */
  known: number;
  /** Files that failed to import. */
  failed: number;
  /** Set when the folder could not be scanned at all. */
  error?: string;
}

const emptyImportBooksResult = (): ImportBooksResult => ({
  failedPaths: [],
  importedByFolder: {},
  knownByFolder: {},
  failedByFolder: {},
  sourcePathsRecorded: 0,
});
const LIBRARY_SEARCH_MODES: LibrarySearchConfig['mode'][] = [
  'contains',
  'whole-words',
  'regex',
  'nearby-words',
  'fuzzy',
];

const getLibrarySearchConfig = (
  searchParams: ReadonlyURLSearchParams | null,
): LibrarySearchConfig => {
  const modeParam = searchParams?.get('mode') as LibrarySearchConfig['mode'] | null;
  const nearbyParam = Number(searchParams?.get('nearby'));
  return {
    scope: 'book',
    mode: modeParam && LIBRARY_SEARCH_MODES.includes(modeParam) ? modeParam : 'contains',
    matchCase: searchParams?.get('matchCase') === 'true',
    matchDiacritics: searchParams?.get('matchDiacritics') === 'true',
    nearbyWords:
      Number.isFinite(nearbyParam) && nearbyParam > 0 ? nearbyParam : DEFAULT_NEARBY_WORDS,
  };
};

/**
 * Key used to persist the last directory the user imported books from.
 * Stored in localStorage so re-opening the dialog (even across app
 * restarts) seeds the path field with their previous choice — this
 * mirrors the behaviour of native file pickers on most desktop OSes.
 */
const LAST_IMPORT_FOLDER_KEY = 'readest:lastImportFolder';
/**
 * Key used to persist the user's last "Folder Structure" choice
 * (`mirror` / `flat` / `author`, or the older `keep` / `flatten`). Restored as
 * the default radio selection on the next dialog open.
 */
const LAST_IMPORT_FOLDER_MODE_KEY = 'readest:lastImportFolderMode';

/**
 * Restore the persisted "Folder Structure" choice. Values are the watched
 * folder modes; the older `keep` / `flatten` strings (written before the third
 * mode existed) still map to their equivalents so nobody's last choice is lost.
 */
const readLastImportFolderMode = (stored: string | null | undefined): WatchedFolderMode => {
  if (stored === 'keep') return 'mirror';
  if (stored === 'flatten') return 'flat';
  return isWatchedFolderMode(stored) ? stored : 'mirror';
};
/**
 * Key used to persist the comma-separated list of FormatGroup ids the
 * user last ticked, e.g. "epub,pdf". Empty / missing falls back to the
 * dialog's built-in default ("epub,pdf").
 */
const LAST_IMPORT_FOLDER_FORMATS_KEY = 'readest:lastImportFolderFormats';
/**
 * Key used to persist the last "File size larger than" threshold (KB).
 * Stored as a stringified non-negative integer.
 */
const LAST_IMPORT_FOLDER_MIN_SIZE_KEY = 'readest:lastImportFolderMinSizeKB';
/**
 * Key used to persist the last "Read books in place" toggle value
 * (`'1'` or `'0'`). Restored as the dialog's initial toggle state.
 * The toggle only matters for fresh, not-yet-registered folders —
 * once a folder is registered as an external library folder, the
 * dialog forces the toggle ON regardless of this value.
 */
const LAST_IMPORT_FOLDER_READ_IN_PLACE_KEY = 'readest:lastImportFolderReadInPlace';

const LibraryPageWithSearchParams = () => {
  const searchParams = useSearchParams();
  return <LibraryPageContent searchParams={searchParams} />;
};

// TXT 目录识别失败引导的待处理项：源文件（File）+ 分组信息，重切时按新规则
// 重新导入该文件（仅本次，不写全局规则）。
type TxtGuideItem = {
  file: File;
  filename: string;
  groupId?: string;
  groupName?: string;
  /**
   * true = 书已按段落兜底切分导入成功（规则一条标题都没匹配上），引导
   * 仅为"重切改进"；取消保留现有导入。false（缺省）= 导入硬失败（如空
   * 文件），取消即放弃导入。
   */
  fallbackImported?: boolean;
};

// 导入疑似命中书库旧版本时挂起的一批冲突，等整批导入结束后统一让用户决定。

const LibraryPageContent = ({ searchParams }: { searchParams: ReadonlyURLSearchParams | null }) => {
  const router = useAppRouter();
  const { envConfig, appService } = useEnv();
  const {
    library: libraryBooks,
    libraryLoaded: libraryLoadedFromDisk,
    updateBook,
    updateBooks,
    setLibrary,
    getGroupId,
    getGroupName,
    checkOpenWithBooks,
    checkLastOpenBooks,
    setCheckOpenWithBooks,
    setCheckLastOpenBooks,
    setSelectedBooks,
  } = useLibraryStore();
  const _ = useTranslation();
  const { selectFiles } = useFileSelector(appService, _);
  const { safeAreaInsets: insets, isRoundedWindow } = useThemeStore();
  const { clearBookData } = useBookDataStore();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const {
    isSettingsDialogOpen,
    setSettingsDialogOpen,
    isWatchedFoldersDialogOpen,
    setWatchedFoldersDialogOpen,
  } = useSettingsStore();

  // FoliateViewer hydration never runs without a book open.
  useCustomFonts();
  const [importMenuAnchor, setImportMenuAnchor] = useState<HTMLElement | null>(null);
  const [loading, setLoading] = useState(false);
  // Import progress (done/total books) shown over the full-screen loading
  // spinner while a (potentially large) batch is being imported.
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  // Seed from the library store: if we already have books in memory (the
  // common reader → library return path), treat the page as loaded
  // immediately. This prevents `showBookshelf` from briefly being false on
  // remount, which used to flash a placeholder before `initLibrary` finished.
  const [libraryLoaded, setLibraryLoaded] = useState(() => libraryBooks.length > 0);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [isSelectAll, setIsSelectAll] = useState(false);
  const [isSelectNone, setIsSelectNone] = useState(false);
  const [librarySearchQuery, setLibrarySearchQuery] = useState(searchParams?.get('q') ?? '');

  // A new search invalidates the selection context: books selected under the
  // previous query may fall out of view and would then be silently dropped
  // from (or invisibly included in) the bulk delete/group actions.
  useEffect(() => {
    setSelectedBooks([]);
    setIsSelectAll(false);
    setIsSelectNone(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [librarySearchQuery, setSelectedBooks]);
  const pendingLibrarySearchQueryRef = useRef<string | null>(null);
  const [librarySearchProgress, setLibrarySearchProgress] = useState<number | null>(null);
  const [librarySearchHistory, setLibrarySearchHistory] = useState<string[]>([]);
  const [librarySearchTarget, setLibrarySearchTarget] = useState<LibrarySearchTarget>(() =>
    ['contents', 'text'].includes(searchParams?.get('search') ?? '') ? 'text' : 'books',
  );
  const [librarySearchConfig, setLibrarySearchConfig] = useState<LibrarySearchConfig>(() =>
    getLibrarySearchConfig(searchParams),
  );
  useEffect(() => {
    if (librarySearchTarget === 'text' && !librarySearchQuery.trim()) {
      setLibrarySearchHistory(loadLibrarySearchHistory());
    }
  }, [librarySearchTarget, librarySearchQuery]);
  const librarySearchTargetRef = useRef(librarySearchTarget);
  const librarySearchConfigRef = useRef(librarySearchConfig);
  const [showDetailsBook, setShowDetailsBook] = useState<Book | null>(null);
  const [failedImportsModal, setFailedImportsModal] = useState<FailedImport[] | null>(null);
  // 导入被自动归组后"前往查看"时短暂高亮的目标书（几秒后自动清除）；
  // 进入文件夹分组时持久高亮该组的新书（离开分组/切换分组即重算或清除）。
  const [highlightedBookHashes, setHighlightedBookHashes] = useState<Set<string>>(new Set());
  const highlightClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightBooks = useCallback((hashes: string[], options?: { persist?: boolean }) => {
    setHighlightedBookHashes(new Set(hashes));
    if (highlightClearTimerRef.current) clearTimeout(highlightClearTimerRef.current);
    if (!options?.persist) {
      highlightClearTimerRef.current = setTimeout(() => {
        setHighlightedBookHashes(new Set());
      }, 6000);
    }
  }, []);
  // "Import from folder" dialog state. Held as a small object rather
  // than a boolean because we need a default starting directory to seed
  // the path field, and we want the dialog to remain mounted long
  // enough for the platform's folder picker to overlay it.
  const [importFromFolderState, setImportFromFolderState] = useState<{
    initialDirectory: string;
    initialFolderMode: WatchedFolderMode;
    initialSelectedGroupIds?: string[];
    initialMinSizeKB?: number;
    initialReadInPlace?: boolean;
    initialAutoImport?: boolean;
  } | null>(null);
  // "Manage watched folders" dialog. Holds no state of its own — it reads the
  // folder list straight from settings so edits show up as soon as they are
  // persisted. The open/closed flag lives in the settings store (destructured
  // with the rest of that store above) because Settings → Custom opens the
  // same dialog and cannot reach this component's state.
  // Newest scan result per normalized folder path, for the dialog's status
  // lines. Display-only, restored from localStorage when the dialog opens.
  const [watchedFolderResults, setWatchedFolderResults] = useState<
    Record<string, WatchedFolderScanStatus>
  >({});
  // `null` = idle, a folder path = that row is refreshing, `'all'` = refresh-all.
  const [watchedFolderRefreshing, setWatchedFolderRefreshing] = useState<string | null>(null);
  // Mirrors the state above for the guard: a second click lands before React
  // re-renders, so `watchedFolderRefreshing` itself is still null in the closure.
  const watchedFolderRefreshingRef = useRef(false);
  // TXT 目录识别失败的引导队列（一次处理一个文件）。
  const txtGuideQueueRef = useRef<TxtGuideItem[]>([]);
  const [guideItem, setGuideItem] = useState<TxtGuideItem | null>(null);
  // 待问的版本冲突放在模块级队列里（`services/versionConflictQueue.ts`），不是
  // 这里的 ref：攒它的路径可能紧接着就把本页卸载（双击/「打开方式」入库后直接
  // 去阅读器），页面内的队列会随组件一起消失、用户永远看不到也点不到。
  const [versionConflicts, setVersionConflicts] = useState<BookVersionConflictInfo[] | null>(null);
  // setVersionConflicts 的镜像：回调里要判断"弹窗是不是已经开着"，而 state 在
  // 闭包里是过时的。
  const versionConflictsRef = useRef<BookVersionConflictInfo[] | null>(null);
  // 本页正在导航离开（去阅读器）：此期间不弹任何东西——导航动画期间弹出的框会
  // 落在一个正在被卸载的页面上。见导航 effect 与 tryDrain。
  const navigatingAwayRef = useRef(false);
  const openVersionConflicts = useCallback((next: BookVersionConflictInfo[] | null) => {
    versionConflictsRef.current = next;
    setVersionConflicts(next);
  }, []);
  /**
   * 把排队的冲突交给弹窗。队列为空、或已经有一个冲突弹窗开着时什么都不做——
   * 后者的冲突留在队列里，等本次弹窗收尾后再问。
   */
  const drainVersionConflicts = useCallback(() => {
    if (versionConflictsRef.current) return;
    // 只读快照，**不清空队列**：清空要等弹窗落定（见 settleVersionConflicts）。
    // 取用即清空会让"正在导航离开的这一页"把队列拿走——那一刻 route.replace 已经
    // 在路上，弹窗落在马上要卸载的实例上，用户回到书库时队列已空、什么都不问。
    const conflicts = peekVersionConflicts();
    if (conflicts.length === 0) return;
    if (consumeVersionConflictOverflow()) {
      eventDispatcher.dispatch('toast', {
        message: `同名书籍较多，本次只询问了前 ${MAX_PENDING_VERSION_CONFLICTS} 本，其余已按独立书目保留`,
        timeout: 6000,
        type: 'info',
      });
    }
    openVersionConflicts(conflicts);
  }, [openVersionConflicts]);
  /**
   * 静默路径（受监视文件夹重扫、双击/「打开方式」）攒下的冲突不弹模态框——那些
   * 都发生在用户做别的事的时候。给一条可点击通知：点它，或下次回到书库页时
   * 再问（见下面的 focus/visibilitychange 兜底）。
   */
  const notifyPendingVersionConflicts = useCallback(() => {
    const pendingCount = pendingVersionConflictCount();
    if (pendingCount === 0) return;
    eventDispatcher.dispatch('toast', {
      message: `检测到 ${pendingCount} 本书库中已有同名版本 · 点击查看`,
      timeout: 8000,
      type: 'info',
      actions: [{ label: '查看', onClick: () => drainVersionConflicts() }],
    });
  }, [drainVersionConflicts]);
  // 弹窗里的两栏对比数据（键为 incoming.hash）。取数是读缓存文件（nav.json /
  // config.json）与一次 stats，不解析任何书文件；每条冲突在弹窗打开后异步补齐，
  // 未到位的先渲染不依赖对比的部分。
  const [versionComparisons, setVersionComparisons] = useState<Record<string, VersionComparison>>(
    {},
  );

  // 弹窗一打开就为每条冲突取对比数据。串行做：一次读两份缓存文件，20 条冲突
  // 并发读会同时压 40 个文件句柄，而这些数据只是为了让人看清楚，不值得抢 IO。
  useEffect(() => {
    if (!versionConflicts || versionConflicts.length === 0) return;
    let cancelled = false;
    void (async () => {
      const app = appService ?? (await envConfig.getAppService());
      const settings = useSettingsStore.getState().settings;
      for (const conflict of versionConflicts) {
        const target = conflict.candidates[0];
        if (!target) continue;
        try {
          const oldSide = await loadOldVersionFacts(app, target, settings);
          const newSide = await loadNewVersionFacts(app, conflict.incoming, conflict.incomingFacts);
          if (cancelled) return;
          const comparison = buildVersionComparison(oldSide, newSide);
          setVersionComparisons((prev) => ({ ...prev, [conflict.incoming.hash]: comparison }));
        } catch (error) {
          // 对比是"锦上添花"：读不出缓存时弹窗照旧可用，用户仍能做决定。
          console.warn('Failed to build version comparison:', conflict.incoming.title, error);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [versionConflicts, appService, envConfig]);

  const [currentGroupPath, setCurrentGroupPath] = useState<string | undefined>(undefined);
  const [currentVirtualGroup, setCurrentVirtualGroup] = useState<{
    groupBy:
      | typeof LibraryGroupByType.Series
      | typeof LibraryGroupByType.Author
      | typeof LibraryGroupByType.Tag
      | typeof LibraryGroupByType.Subject;
    groupName: string;
  } | null>(null);
  const [pendingNavigationBookIds, setPendingNavigationBookIds] = useState<string[] | null>(null);
  // 「初始化导航确实在途」：此时整个页面渲染的是一个空白占位（见下方的提前
  // return），连本页自己的 <Toast /> 都不在树里。冲突队列的取用必须避开这一刻，
  // 因为那次导航正是要卸载本页——取走就等于丢掉（双击/「打开方式」入库后直接
  // 去阅读器，冲突只能等回到书库页再问）。
  const awaitingInitNavigation =
    !!pendingNavigationBookIds && (checkOpenWithBooks || checkLastOpenBooks);

  // 回到书库页时把待问的冲突弹出来：点过通知以外，窗口重新聚焦、页面重新可见、
  // 或本页重新挂载（从阅读器回来）时都该被问到——通知可能已经被划走或超时消失。
  // 别的模态框正在用时排队，等它关掉后下一次触发再试。
  useEffect(() => {
    const tryDrain = () => {
      if (document.visibilityState === 'hidden') return;
      if (navigatingAwayRef.current) return;
      if (awaitingInitNavigation || !libraryLoaded) return;
      if (failedImportsModal || guideItem || importFromFolderState) return;
      drainVersionConflicts();
    };
    tryDrain();
    window.addEventListener('focus', tryDrain);
    document.addEventListener('visibilitychange', tryDrain);
    return () => {
      window.removeEventListener('focus', tryDrain);
      document.removeEventListener('visibilitychange', tryDrain);
    };
  }, [
    drainVersionConflicts,
    awaitingInitNavigation,
    libraryLoaded,
    failedImportsModal,
    guideItem,
    importFromFolderState,
  ]);
  const isInitiating = useRef(false);
  // 每次 initLibrary effect 重跑自增：把上一轮尚未完成的 async 体标记为陈旧，
  // 防止旧 promise 在组件（或导航配置）变化后继续 setState / 写库。
  const libraryInitGeneration = useRef(0);
  const pageMountedRef = useRef(true);

  const iconSize = useResponsiveSize(18);
  const viewSettings = settings.globalViewSettings;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const handleScrollerRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
  }, []);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  // Tracks paths that failed to import in this session so auto-import does not
  // re-attempt (and re-toast) them on every subsequent folder scan.
  const autoImportFailedPathsRef = useRef<Set<string>>(new Set());
  /**
   * `true` while an import batch is running. Mirrors the `loading` state for
   * callers that check it in the same tick a batch was started (React has not
   * re-rendered yet, so the state they closed over is still `false`). Every
   * place that gates on "is an import running" should read both.
   */
  const importingRef = useRef(false);
  // Folders whose fs/asset scopes were already granted this session. Each
  // `allowPathsInScopes` call makes tauri-plugin-persisted-scope rewrite its
  // whole state file on the main thread, so grant once, not on every focus
  // scan (issue #5494).
  const autoImportGrantedFoldersRef = useRef<Set<string>>(new Set());

  const getScrollKey = (group: string) => `library-scroll-${group || 'all'}`;

  const saveScrollPosition = (group: string) => {
    if (scrollRef.current) {
      sessionStorage.setItem(getScrollKey(group), scrollRef.current.scrollTop.toString());
    }
  };

  const restoreScrollPosition = useCallback((group: string) => {
    const savedPosition = sessionStorage.getItem(getScrollKey(group));
    if (savedPosition && scrollRef.current) {
      scrollRef.current.scrollTop = parseInt(savedPosition, 10);
    }
  }, []);

  useTheme({ systemUIVisible: true, appThemeColor: 'base-200' });
  useUICSS();

  // Apply the library's own background texture (separate from the reader's,
  // issue #4743). Re-applies on mount so returning from a textured book
  // restores the library background, and whenever the library texture — or the
  // reader/global texture it inherits when unset — changes from the Color panel.
  const { applyBackgroundTexture } = useBackgroundTexture();
  useEffect(() => {
    applyBackgroundTexture(envConfig, getLibraryViewSettings(settings));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    envConfig,
    applyBackgroundTexture,
    settings.libraryBackgroundTextureId,
    settings.libraryBackgroundOpacity,
    settings.libraryBackgroundSize,
    settings.globalViewSettings?.backgroundTextureId,
    settings.globalViewSettings?.backgroundOpacity,
    settings.globalViewSettings?.backgroundSize,
  ]);

  useReadingWidget();

  const { isDragging } = useDragDropImport();

  const refreshLibrary = async () => {
    if (!appService) return;
    const library = await appService.loadLibraryBooks();
    setLibrary(library);
    setLibraryLoaded(true);
  };

  usePullToRefresh(
    scrollRef,
    async () => {
      await refreshLibrary();
    },
    async () => {
      await refreshLibrary();
    },
  );
  useShortcuts({
    onToggleFullscreen: async () => {
      if (isTauriAppPlatform()) {
        await tauriHandleToggleFullScreen();
      }
    },
    onCloseWindow: async () => {
      if (isTauriAppPlatform()) {
        await tauriHandleClose();
      }
    },
    onQuitApp: async () => {
      if (isTauriAppPlatform()) {
        await tauriQuitApp();
      }
    },
    onOpenFontLayoutSettings: () => {
      setSettingsDialogOpen(true);
    },
    onOpenBooks: () => {
      handleImportBooksFromFiles();
    },
  });

  useEffect(() => {
    const snapshot = searchParams?.toString() || '';
    if (snapshot !== new URLSearchParams(window.location.search).toString()) return;
    sessionStorage.setItem('lastLibraryParams', snapshot);
  }, [searchParams]);

  // Strip the empty `group=` param that `handleLibraryNavigation` sets as a
  // workaround for a Next.js 16.2 static-export regression (see the NOTE
  // above `handleLibraryNavigation` for full context). This effect runs
  // after the router.replace() has committed, so React has already
  // re-rendered with the new (empty) group state; we're only rewriting the
  // URL cosmetically via window.history.replaceState — Next.js' patched
  // replaceState will pick up the new canonical URL without triggering
  // another navigation.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (searchParams?.get('group') !== '') return;
    const url = new URL(window.location.href);
    url.searchParams.delete('group');
    const cleanHref = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(null, '', cleanHref);
  }, [searchParams]);

  // Unified navigation function that handles scroll position and direction.
  // Workaround for a Next.js 16.2 static-export regression: navigating to a
  // same-pathname URL with an empty search string causes `router.replace()`
  // to silently no-op (e.g. `/library?group=foo` -> `/library`), which broke
  // the breadcrumb "All" button. By always calling `params.set('group',
  // targetGroup)` — including when `targetGroup` is an empty string — the
  // resulting URL becomes `/library?group=` instead of `/library`, which
  // Next.js does commit. The trailing empty `group=` is stripped via a
  // cleanup effect below (purely cosmetic URL rewrite). See
  // https://github.com/readest/readest/issues/3782.
  // 鼠标侧键"前进"栈（见 handleMouseNavBack/Forward）：后退时记录退出的分组，
  // 前进时恢复。声明在 handleLibraryNavigation 之前——后者在每次新分支导航时
  // 清空它（浏览器语义：新导航之后"前进"作废）。
  const forwardGroupStackRef = useRef<{ group: string; groupBy?: string; from?: string }[]>([]);

  const handleLibraryNavigation = useCallback(
    (targetGroup: string, options?: { clearForwardStack?: boolean }) => {
      // The selection is scoped to the view the user made it in; navigating
      // invalidates that context, so carry nothing over (and never let the
      // confirm dialogs reference books the user can no longer see).
      setSelectedBooks([]);
      setIsSelectAll(false);
      setIsSelectNone(false);

      // 默认视为一次新分支导航：清空侧键前进栈，避免"前进"跳到过期分组。
      // 侧键后退链路经 handleBackUpOneGroupLevel 到达这里时传
      // clearForwardStack:false，保留刚压栈的后退记录。
      if (options?.clearForwardStack !== false) forwardGroupStackRef.current = [];

      const params = new URLSearchParams(window.location.search);
      const currentGroup = params.get('group') || '';

      // Save current scroll position BEFORE navigation
      saveScrollPosition(currentGroup);

      // Detect and set navigation direction. Compare folder depth (path
      // segment count): retreating to a shallower folder — including the top
      // level — is "back"; entering a deeper or sibling folder, or a virtual
      // group, is "forward". The old check (`currentGroup && !targetGroup`)
      // only recognised the retreat-to-top case, so backing out of a nested
      // folder to its parent animated forward. Leaving a virtual group (its
      // id never resolves to a folder path) always counts as "back".
      const folderPath = currentGroup
        ? useLibraryStore.getState().getGroupName(currentGroup)
        : undefined;
      const targetFolderPath = targetGroup
        ? useLibraryStore.getState().getGroupName(targetGroup)
        : undefined;
      const groupDepth = (path: string | undefined) => (path ? path.split('/').length : 0);
      const direction =
        groupDepth(targetFolderPath) < groupDepth(folderPath) || (currentGroup && !folderPath)
          ? 'back'
          : 'forward';
      document.documentElement.setAttribute('data-nav-direction', direction);

      // Build query params — always `set` so the search string is non-empty
      // even when targetGroup is '' (the Next.js 16.2 workaround).
      params.set('group', targetGroup);
      // The callback is memoized on [router] only, so read fresh state here.
      const currentSettings = useSettingsStore.getState().settings;
      // Resolve the current dimension from the URL, not just the remembered /
      // global default: after a virtual-group back-navigation the top level sits
      // on a URL `groupBy` override (e.g. author), and ignoring it would re-derive
      // the wrong dimension and drop the override when re-entering another group.
      // `params` still carries the URL's groupBy — only `group` was rewritten.
      const currentGroupBy = resolveCurrentGroupBy(params, currentSettings, folderPath);
      const isVirtualDimension =
        currentGroupBy === LibraryGroupByType.Series ||
        currentGroupBy === LibraryGroupByType.Author ||
        currentGroupBy === LibraryGroupByType.Tag ||
        currentGroupBy === LibraryGroupByType.Subject;
      // 进入虚拟分组（作者/系列/标签/主题）时必须把该维度写进 URL，否则分组会按
      // 全局默认解析，书架变空。仅在目标是虚拟分组（其 id 不在文件夹分组映射里）
      // 时携带——回退到父级文件夹不能继承虚拟维度。
      // 同时把来源 group（'' = 顶层，或文件夹 id）记进 `from`，让退出虚拟分组能
      // 精确回到进入时的位置；否则在文件夹内打开的作者分组，退出后落到全库顶层，
      // 面包屑/导航头消失、回不到来源文件夹（用户曾报的"导航栏消失"bug）。
      // targetFolderPath 已在导航方向判定处解析。
      if (targetGroup && isVirtualDimension && !targetFolderPath) {
        params.set('groupBy', currentGroupBy);
        params.set('from', currentGroup);
      } else {
        params.delete('groupBy');
        params.delete('from');
      }

      // 进入文件夹分组即视为"看过"：清除该分组的新书角标（晚于此刻导入的
      // 书才重新计数）。键与角标计算一致——分组 id（组名指纹）。
      // 角标清除的同时无从得知刚才计数的是哪几本，所以在写入 visited 之前
      // 先捕获新书快照，持久高亮它们（换分组重算、回顶层清除），补上
      // "角标说有 1 本新书、进组后却不知道是哪本"的断层。
      if (targetGroup) {
        const targetPath = useLibraryStore.getState().getGroupName(targetGroup);
        if (targetPath) {
          const { library } = useLibraryStore.getState();
          const newBookHashes = getGroupNewBookHashes(
            library,
            targetPath,
            useSettingsStore.getState().settings.groupLastVisitedAt ?? {},
          );
          highlightBooks(newBookHashes, { persist: true });
        } else {
          setHighlightedBookHashes(new Set());
        }
        const nextVisited = {
          ...(useSettingsStore.getState().settings.groupLastVisitedAt ?? {}),
          [targetGroup]: Date.now(),
        };
        void saveSysSettings(envConfig, 'groupLastVisitedAt', nextVisited);
      } else {
        setHighlightedBookHashes(new Set());
      }

      navigateToLibrary(router, params.toString());
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router],
  );

  const handleBackUpOneGroupLevel = () => {
    if (currentGroupPath) {
      const segments = currentGroupPath.split('/');
      const parentPath = segments.length > 1 ? segments.slice(0, -1).join('/') : undefined;
      const parentGroupId = parentPath ? getGroupId(parentPath) || '' : '';
      setIsSelectAll(false);
      setIsSelectNone(false);
      // 后退链路：不清空侧键前进栈——handleMouseNavBack 刚压栈的记录就是
      // 这次后退要保留的。
      handleLibraryNavigation(parentGroupId, { clearForwardStack: false });
      return;
    }
    // 虚拟分组（作者/系列/标签/主题）内后退：回到进入时的来源 —— `from` 参数记录
    // 来源 group（文件夹 id 或空 = 顶层）。没有它，文件夹内打开的作者分组会退回
    // 全库顶层，丢失文件夹上下文（"导航栏消失、回不到上级目录"bug）。
    const group = searchParams?.get('group') || '';
    if (!group) return; // 顶层 — 没有更上级可退
    if (getGroupName(group)) return; // 文件夹分组恒有 currentGroupPath，已在上方处理
    setIsSelectAll(false);
    setIsSelectNone(false);
    const params = new URLSearchParams(window.location.search);
    const fromGroup = params.get('from');
    params.set('group', fromGroup ?? '');
    params.delete('from');
    // 来源视图用自己 per-group 记忆（groupByByGroup[来源]）解析分组维度，所以这里
    // 必须删掉 URL 上的 groupBy override——否则虚拟维度会被强加到来源视图上，回退
    // 到顶层/文件夹时仍按错误的维度渲染。
    params.delete('groupBy');
    // 退出来源视图同理是"后退"方向；显式设置，避免沿用上一次导航残留的
    // data-nav-direction（该属性驱动 ::view-transition 的滑动方向）。
    document.documentElement.setAttribute('data-nav-direction', 'back');
    navigateToLibrary(router, params.toString());
  };

  const handleBackUpOneGroupLevelRef = useRef(handleBackUpOneGroupLevel);
  handleBackUpOneGroupLevelRef.current = handleBackUpOneGroupLevel;
  const triggerBackUpOneGroupLevel = useCallback(() => handleBackUpOneGroupLevelRef.current(), []);

  // Mouse side-button navigation (see useMouseNavigation). The library maps
  // back/forward to moving up/down one group level; the forward stack
  // (forwardGroupStackRef, declared above handleLibraryNavigation) remembers
  // the group we stepped back from so "forward" can return to it.
  const handleMouseNavBack = () => {
    const currentGroup = searchParams?.get('group') || '';
    if (currentGroup) {
      // 记住退出的 group 及其虚拟维度，供"前进"恢复——文件夹内打开的作者分组，
      // 退回后再前进时若缺少维度会无法复原。`from` 一并记下该虚拟分组的来源，
      // 使恢复后的虚拟分组再后退仍能回到同一文件夹。
      forwardGroupStackRef.current.push({
        group: currentGroup,
        groupBy: searchParams?.get('groupBy') || undefined,
        from: searchParams?.get('from') || undefined,
      });
    }
    handleBackUpOneGroupLevel();
  };
  const handleMouseNavForward = () => {
    const target = forwardGroupStackRef.current.pop();
    if (!target) return;
    // 弹出的目标可能已失效（后退之后分组被删除，文件夹分组解析不到）：整栈
    // 作废、"前进"归零，而不是继续弹出更早的条目跳到更久远的位置。虚拟分组
    //（携带 groupBy 维度）由书目元数据实时推导，无法静态校验，直接放行。
    if (isStaleForwardTarget(target, useLibraryStore.getState().getGroupName)) {
      forwardGroupStackRef.current = [];
      return;
    }
    setIsSelectAll(false);
    setIsSelectNone(false);
    // 直接恢复记住的 group 与虚拟维度（走 handleLibraryNavigation 会从当前顶层
    // 重新推导维度而丢失它）。同时维持滚动位置与导航方向的簿记。
    saveScrollPosition(searchParams?.get('group') || '');
    document.documentElement.setAttribute('data-nav-direction', 'forward');
    const params = new URLSearchParams(window.location.search);
    params.set('group', target.group);
    if (target.groupBy) params.set('groupBy', target.groupBy);
    else params.delete('groupBy');
    if (target.from) params.set('from', target.from);
    else params.delete('from');
    navigateToLibrary(router, params.toString());
  };
  const handleMouseNavBackRef = useRef(handleMouseNavBack);
  handleMouseNavBackRef.current = handleMouseNavBack;
  const handleMouseNavForwardRef = useRef(handleMouseNavForward);
  handleMouseNavForwardRef.current = handleMouseNavForward;
  useEffect(() => {
    const onBack = () => handleMouseNavBackRef.current();
    const onForward = () => handleMouseNavForwardRef.current();
    eventDispatcher.on('library-nav-back', onBack);
    eventDispatcher.on('library-nav-forward', onForward);
    return () => {
      eventDispatcher.off('library-nav-back', onBack);
      eventDispatcher.off('library-nav-forward', onForward);
    };
  }, []);

  useKeyDownActions({
    onCancel: triggerBackUpOneGroupLevel,
    enabled: false,
  });

  useEffect(() => {
    if (settings.alwaysOnTop) {
      tauriHandleSetAlwaysOnTop(settings.alwaysOnTop);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  // Drop the book name the reader put in the window title, so a window back on
  // the library does not keep announcing a book that is no longer open.
  useEffect(() => {
    if (appService?.hasWindow) {
      tauriSetWindowTitle();
    }
  }, [appService?.hasWindow]);

  useEffect(() => {
    if (appService?.hasWindow) {
      const currentWebview = getCurrentWebview();
      const unlisten = currentWebview.listen('close-reader-window', async () => {
        // Reader windows are independent Tauri webviews with their own
        // libraryStore instance — progress / readingStatus / move-to-front
        // updates from the reader window do NOT propagate to this main
        // window's store. Reload from disk so the library reflects the
        // changes the reader just persisted.
        const currentWindow = getCurrentWindow();
        // 方案A 兜底：reader 经系统级关闭（Alt+F4）时会走到这里，此时书库可能
        // 处于方案A 的隐藏状态。把它带回前台，避免"无可见窗口但进程残留"。
        // show/unminimize 对已可见窗口是 no-op，正常路径（reader 顶部关闭书籍）
        // 不 emit 此事件，故不影响既有流程。
        const appService = await envConfig.getAppService();
        // B8：窗口恢复与数据重载并行，缩短关闭阅读页的感知延迟。settings 复用
        // 内存值不重载——书架渲染不依赖多数设置项，reader 关闭时设置极少跨窗口
        // 变化，避免 setSettings 触发一轮订阅重渲。
        // NF1：窗口操作各自 .catch 隔离失败域——unminimize/setFocus 任一 reject
        // 都不再让 Promise.all 整体拒绝，保证 setLibrary（数据刷新）一定执行。
        const [library] = await Promise.all([
          appService.loadLibraryBooks(),
          (async () => {
            await currentWindow.show().catch(() => {});
            await currentWindow.unminimize().catch(() => {});
            await currentWindow.setFocus().catch(() => {});
          })(),
        ]);
        setLibrary(library);
      });
      return () => {
        unlisten.then((fn) => fn());
      };
    }
    return;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appService, envConfig]);

  // Watch for reader windows whose webview has crashed (blank window): they
  // stop heartbeating and never emit close-reader-window, so the watchdog
  // destroys them instead of leaving them open forever.
  useEffect(() => {
    if (!appService?.hasWindow) return;
    const stopWatchdog = startReaderWindowWatchdog();
    return stopWatchdog;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appService?.hasWindow]);

  // 方案A：书库窗口关闭拦截。阅读页打开时点 X 只隐藏书库（保留滚动/选中/搜索/
  // 筛选/列表等全部状态），阅读页关闭后再 show 回来；无阅读页时才是真关闭（退出）。
  useEffect(() => {
    if (!appService?.hasWindow) return;
    const unlisten = tauriHandleOnCloseMainWindow().catch((error) => {
      console.info('Failed to register main close handler:', error);
      return () => {};
    });
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appService?.hasWindow]);

  const handleImportBookFiles = useCallback(async (event: CustomEvent) => {
    const selectedFiles: SelectedFile[] = event.detail.files;
    // 顶层拖拽的 groupId 是 ''（仅表示"当前视图在顶层"），归一成 undefined
    // 走推导模式，让按作者自动归组等逐文件逻辑有机会生效；'' 是 tri-state
    // 里"明确放根目录"，会把这些逻辑全部短路。
    const groupId: string | undefined = event.detail.groupId || undefined;
    if (selectedFiles.length === 0) return;
    await importBooks(selectedFiles, groupId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleImportBookDirectory = useCallback(async (event: CustomEvent) => {
    const dirPath: string | undefined = event.detail?.path;
    if (!dirPath) return;
    await handleImportBooksFromDirectory(dirPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    eventDispatcher.on('import-book-files', handleImportBookFiles);
    eventDispatcher.on('import-book-directory', handleImportBookDirectory);
    return () => {
      eventDispatcher.off('import-book-files', handleImportBookFiles);
      eventDispatcher.off('import-book-directory', handleImportBookDirectory);
    };
  }, [handleImportBookFiles, handleImportBookDirectory]);

  useEffect(() => {
    if (!libraryBooks.some((book) => !book.deletedAt)) {
      handleSetSelectMode(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryBooks]);

  const processOpenWithFiles = useCallback(
    async (appService: AppService, openWithFiles: string[], libraryBooks: Book[]) => {
      const gen = libraryInitGeneration.current;
      const settings = await appService.loadSettings();
      if (gen !== libraryInitGeneration.current) return false;
      const bookIds: string[] = [];
      // 新书先进内存：按 hash 替换/追加，落盘时以最新数组为准，避免
      // "先写盘、书却没进内存数组" 的入库缺失。
      let library = libraryBooks;
      for (const file of openWithFiles) {
        if (gen !== libraryInitGeneration.current) return false;
        try {
          const temp = !settings.autoImportBooksOnOpen;
          const result = await ingestFile(
            {
              file,
              books: library,
              transient: temp,
              // 双击/「打开方式」也会认出书库里的旧版本，但不在这条路径上弹窗：
              // 入库成功后马上就会导航去阅读器，本页连自己的 <Toast /> 都还没
              // 进树（初始化导航在途时渲染的是空白占位），任何模态/通知都不可见。
              // 冲突只入队——队列在模块级、与页面无关，用户从阅读器回到书库时
              // 本页重新挂载，那时才问（见 drainVersionConflicts 的调用点）。
              // transient（不自动入库）时不注册：没有落库的记录，没什么可问的。
              ...(temp
                ? {}
                : {
                    onVersionConflict: (info: BookVersionConflictInfo) => {
                      enqueueVersionConflicts([info]);
                    },
                  }),
            },
            { appService, settings },
          );
          if (result) {
            library = [...library.filter((b) => b.hash !== result.book.hash), result.book];
            bookIds.push(result.book.hash);
          }
        } catch (error) {
          console.error('Failed to import book:', file, error);
          // 双击打开损坏/不支持的文件时不能零反馈：明确报哪个文件失败。
          eventDispatcher.dispatch('toast', {
            message: _('Failed to import book(s): {{filenames}}', {
              filenames: listFormater(false).format([getFilename(file)]),
            }),
            timeout: 4000,
            type: 'error',
          });
        }
      }
      if (gen !== libraryInitGeneration.current) return false;
      if (bookIds.length > 0) {
        // C-4 复核：保存成功后才提交内存快照——保存失败时 store 不变、不
        // 导航，也没有"内存含新书而磁盘未写"的半提交。
        let saved: Book[];
        try {
          saved = await appService.saveLibraryBooks(library);
        } catch (error) {
          console.error('Failed to persist Open With books; staying on library:', error);
          eventDispatcher.dispatch('toast', {
            message: _('Failed to save library'),
            timeout: 4000,
            type: 'error',
          });
          return false;
        }
        // 以磁盘最终 LWW 合并快照为准提交内存。
        // 保存成功后才以磁盘最终快照提交内存；但仅当前 generation 允许提交，
        // 防旧轮次的保存晚到污染新页面。
        if (gen !== libraryInitGeneration.current) return false;
        setLibrary(saved);
        setPendingNavigationBookIds(bookIds);
        // 不在这里弹任何东西：紧接着的导航会让本页卸载，通知没有落脚点。冲突
        // 留在模块队列里，用户回到书库页时由 drainVersionConflicts 补问。
        return true;
      }
      return false;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleOpenLastBooks = async (
    appService: AppService,
    lastBookIds: string[],
    libraryBooks: Book[],
  ) => {
    if (lastBookIds.length === 0) return false;
    const bookIds: string[] = [];
    for (const bookId of lastBookIds) {
      const book = libraryBooks.find((b) => b.hash === bookId && b.readingStatus !== 'finished');
      if (book && (await appService.isBookAvailable(book))) {
        bookIds.push(book.hash);
      }
    }
    if (bookIds.length > 0) {
      setPendingNavigationBookIds(bookIds);
      return true;
    }
    return false;
  };

  const libraryInitKey = (() => {
    const params = new URLSearchParams(searchParams?.toString());
    for (const key of ['q', 'search', 'mode', 'matchCase', 'matchDiacritics', 'nearby']) {
      params.delete(key);
    }
    return params.toString();
  })();

  useEffect(() => {
    if (pendingNavigationBookIds) {
      const bookIds = pendingNavigationBookIds;
      // 先置标记再放手导航：本 effect 置 null 会让 awaitingInitNavigation 转假，
      // drain effect 随之重跑；tryDrain 见到这个标记就跳过，弹窗才不会在导航
      // 动画期间闪一帧落在正在卸载的页面上（队列本身不会被取走，见
      // drainVersionConflicts — 只读快照，清空等弹窗落定）。
      navigatingAwayRef.current = true;
      setPendingNavigationBookIds(null);
      if (bookIds.length > 0) {
        navigateToReader(router, bookIds);
      }
    }
  }, [pendingNavigationBookIds, appService, router]);

  useEffect(() => {
    if (isInitiating.current) return;
    isInitiating.current = true;
    const generation = ++libraryInitGeneration.current;
    pageMountedRef.current = true;

    // Reuse the in-store library only when it was actually loaded from disk.
    // Gating on `length > 0` was unsafe: a transient "Open with" entry made the
    // store non-empty before any disk load, so this skipped loadLibraryBooks and
    // a later save persisted the partial library (wiping library.json).
    const hasCachedLibrary = libraryLoadedFromDisk;
    const stale = () => generation !== libraryInitGeneration.current;
    // 过期轮（URL 规范化触发的并发 initLibrary）不得把全屏"加载中"置位：
    // stale 提前退出的轮次没有后续 setLoading(false)，定时器若照常触发就把
    // 遮罩遗留常驻、盖住已渲染完成的书库。回调里先守卫 stale。
    const loadingTimeout = hasCachedLibrary
      ? null
      : setTimeout(() => {
          if (stale()) {
            bail();
            return;
          }
          setLoading(true);
        }, 500);
    // stale 提前退出时的统一收尾：清掉本轮的加载定时器。只有当前 generation
    // （active 轮）允许把 loading 关回 false——旧轮 bail 不得关闭新轮次的遮罩。
    const bail = () => {
      if (loadingTimeout) clearTimeout(loadingTimeout);
      if (!stale()) setLoading(false);
    };
    const initLibrary = async () => {
      const appService = await envConfig.getAppService();
      if (stale()) {
        bail();
        return;
      }
      const settings = await appService.loadSettings();
      if (stale()) {
        bail();
        return;
      }
      setSettings(settings);

      // Re-hydrate persisted (possibly still-empty) groups so they appear on
      // the shelf even before any book is added to them.
      for (const groupName of settings.libraryCustomGroups ?? []) {
        useLibraryStore.getState().addPersistentGroup(groupName);
      }

      // Re-grant fs_scope / asset_protocol_scope for every external
      // library folder the user registered in a previous session, so
      // in-place books under those roots are immediately readable
      // through both `dir_scanner::read_dir` and the fs plugin.
      // Best-effort — `allowPathsInScopes` swallows its own errors.
      // On iOS the corresponding native-bridge plugin separately
      // re-acquires security-scoped resources via persisted
      // bookmarks (see InPlaceFolderBookmarkStore in
      // NativeBridgePlugin.swift); here we just sync Tauri's in-memory
      // scope set with the persisted intent.
      const externalRoots = settings.externalLibraryFolders ?? [];
      // Watched folders need the same treatment even when they are NOT external
      // library folders: watching a folder without reading it in place still
      // reads every file in it (to copy it into the library), and the scan
      // would fail with an fs_scope error without this grant.
      const watchedRoots = settings.autoImportFolders ?? [];
      const scopedRoots = [...new Set([...externalRoots, ...watchedRoots])];
      if (scopedRoots.length > 0 && appService.allowPathsInScopes) {
        await appService.allowPathsInScopes(scopedRoots, true);
        if (stale()) {
          bail();
          return;
        }
      }

      // Reuse the library from the store when we return from the reader
      const library = hasCachedLibrary ? libraryBooks : await appService.loadLibraryBooks();
      if (stale()) {
        bail();
        return;
      }
      let opened = false;
      if (checkOpenWithBooks) {
        opened = await handleOpenWithBooks(appService, library);
        if (stale()) {
          bail();
          return;
        }
      }
      setCheckOpenWithBooks(opened);
      if (!opened && checkLastOpenBooks && settings.openLastBooks) {
        opened = await handleOpenLastBooks(appService, settings.lastOpenBooks, library);
        if (stale()) {
          bail();
          return;
        }
      }
      setCheckLastOpenBooks(opened);

      if (stale()) {
        bail();
        return;
      }
      // Skip the redundant setLibrary on the cached path: the store already
      // contains the same array reference, and a no-op set would still
      // trigger refreshGroups (O(n) MD5) and a full Bookshelf re-render.
      // The cold path or the openWith / openLast path may have produced a
      // different `library` reference (intent-imported books) — only then
      // do we commit it.
      if (!hasCachedLibrary || library !== libraryBooks) {
        setLibrary(library);
      }
      setLibraryLoaded(true);
      bail();
    };

    const handleOpenWithBooks = async (appService: AppService, library: Book[]) => {
      const openWithFiles = (await parseOpenWithFiles()) || [];
      if (stale()) return false;

      if (openWithFiles.length > 0) {
        return await processOpenWithFiles(appService, openWithFiles, library);
      }
      return false;
    };

    // initLibrary 内部任何一步 reject（loadSettings/loadLibraryBooks IPC 失败、
    // 封面 blob URL 生成失败等）都不能让全屏"加载中"遮罩常驻：catch 里复用
    // bail() 收尾本轮流次，active 轮失败再给出可见错误提示。
    initLibrary().catch((error) => {
      console.error('Failed to initialize library:', error);
      bail();
      if (!stale()) {
        eventDispatcher.dispatch('toast', {
          type: 'error',
          message: _('Failed to load library'),
          timeout: 2500,
        });
      }
    });
    return () => {
      pageMountedRef.current = false;
      // 使上一轮在途 async 的后续 setState 全部失效（卸载或 libraryInitKey 重进）。
      libraryInitGeneration.current += 1;
      // 卸载/重进时清掉本轮的加载定时器，避免其稍后把 loading 置位后无人可关。
      if (loadingTimeout) clearTimeout(loadingTimeout);
      setCheckOpenWithBooks(false);
      setCheckLastOpenBooks(false);
      isInitiating.current = false;
    };
    // Non-search URL changes trigger parsing OPEN_WITH_FILES without reinitializing on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryInitKey]);

  useEffect(() => {
    setCurrentGroupPath(getGroupName(searchParams?.get('group') || ''));
    // 依赖 libraryBooks：组名映射随书库数据就绪后再解析。
  }, [libraryBooks, searchParams, getGroupName]);

  useEffect(() => {
    if (
      (searchParams?.toString() || '') !== new URLSearchParams(window.location.search).toString()
    ) {
      return;
    }
    const urlQuery = searchParams?.get('q') ?? '';
    if (pendingLibrarySearchQueryRef.current === urlQuery) {
      pendingLibrarySearchQueryRef.current = null;
    }
    if (pendingLibrarySearchQueryRef.current === null) setLibrarySearchQuery(urlQuery);
    const target = ['contents', 'text'].includes(searchParams?.get('search') ?? '')
      ? 'text'
      : 'books';
    const config = getLibrarySearchConfig(searchParams);
    librarySearchTargetRef.current = target;
    librarySearchConfigRef.current = config;
    setLibrarySearchTarget(target);
    setLibrarySearchConfig(config);
  }, [searchParams]);

  useEffect(() => {
    const group = searchParams?.get('group') || '';
    restoreScrollPosition(group);
  }, [searchParams, restoreScrollPosition]);

  // Track the current virtual group for the navigation header.
  useEffect(() => {
    const groupId = searchParams?.get('group') || '';
    const folderGroupPath = groupId ? getGroupName(groupId) : undefined;
    const groupBy = resolveCurrentGroupBy(searchParams, settings, folderGroupPath);

    if (
      groupId &&
      (groupBy === LibraryGroupByType.Series ||
        groupBy === LibraryGroupByType.Author ||
        groupBy === LibraryGroupByType.Tag ||
        groupBy === LibraryGroupByType.Subject)
    ) {
      // Find the group to get its name
      const allGroups = createBookGroups(
        libraryBooks.filter((b) => !b.deletedAt),
        groupBy,
      );
      const targetGroup = findGroupById(allGroups, groupId);

      if (targetGroup) {
        setCurrentVirtualGroup({
          groupBy,
          groupName: targetGroup.displayName || targetGroup.name,
        });
      } else {
        setCurrentVirtualGroup(null);
      }
    } else {
      setCurrentVirtualGroup(null);
    }
  }, [libraryBooks, searchParams, settings, getGroupName]);

  /**
   * 撤销导入时的按作者自动归组：把本批被归组的书移回根目录。只回滚仍然
   * 停在自动分配分组里的书——用户若已手动重新归组，就不动它。
   */
  const undoAuthorGrouping = async (entries: AuthorGroupedImport[]) => {
    const { library } = useLibraryStore.getState();
    const now = Date.now();
    const reverted: Book[] = [];
    for (const entry of entries) {
      const book = library.find((b) => b.hash === entry.hash);
      if (book && !book.deletedAt && book.groupId === entry.groupId) {
        reverted.push({
          ...book,
          groupId: undefined,
          groupName: undefined,
          updatedAt: now,
          metadataUpdatedAt: now,
        });
      }
    }
    if (reverted.length > 0) {
      await updateBooks(envConfig, reverted);
    }
  };

  const importBooks = async (
    files: SelectedFile[],
    groupId?: string,
    options: {
      silent?: boolean;
      rememberSourcePath?: boolean;
      folderRule?: WatchedFolderRule;
    } = {},
  ): Promise<ImportBooksResult> => {
    // Reject concurrent imports: two interleaved batch runs would overwrite
    // each other's progress and interleave store writes. The auto-import path
    // already had this guard; the manual paths get it here. `importingRef`
    // mirrors the state for the same-tick case: a second caller that arrives
    // before React re-renders would still read `loading === false` here.
    if (loading || importingRef.current) return emptyImportBooksResult();
    importingRef.current = true;
    setLoading(true);
    try {
      return await runImportBooks(files, groupId, options);
    } finally {
      // 保存/收尾任一步抛错（如 Tauri ACL 拒绝、磁盘失败）都不能把全屏
      // 加载遮罩留在最上层卡死书库——复位必须发生在 finally 里。
      importingRef.current = false;
      setLoading(false);
      setImportProgress(null);
    }
  };

  const runImportBooks = async (
    files: SelectedFile[],
    groupId?: string,
    options: {
      silent?: boolean;
      rememberSourcePath?: boolean;
      folderRule?: WatchedFolderRule;
    } = {},
  ): Promise<ImportBooksResult> => {
    const totalFiles = files.length;
    let processedFiles = 0;
    setImportProgress({ done: 0, total: totalFiles });
    const { library } = useLibraryStore.getState();
    // 导入前已在库中的书 hash：按作者归组只作用于"真正新进来的书"，
    // byHash/byFilePath 命中的重复导入不重新归组（不惊动既有的手动分组）。
    const knownHashes = new Set(library.map((book) => book.hash));
    // 现存分组名快照（含嵌套祖先与手动建的空组），供按作者匹配；本批
    // 归组产生的新分组名会随时补进集合，让同批后续文件也能命中。
    const existingGroupNames = new Set(
      collectGroupNames(library, useLibraryStore.getState().persistentGroupNames ?? []),
    );
    const authorGroupedImports: AuthorGroupedImport[] = [];
    // 其中本次导入真正执行了归组的书（不含 dedup 重导后"本就在作者组"的
    // 书）——"撤销"只回退这些书的分组。
    const regroupedImports: AuthorGroupedImport[] = [];
    // Build the lookup index ONCE per import batch so each book lookup is
    // O(1) instead of O(n) over the existing library. importBook also keeps
    // the index updated as new books are appended, so subsequent files in
    // the same batch see the additions.
    //
    // `osPlatform` is required for the `byFilePath` arm: on case-insensitive
    // filesystems (macOS / iOS / Windows) two paths that differ only in
    // casing must hash to the same key, so the in-place fast path in
    // importBook can recognize a re-import of the same file.
    const lookupIndex = buildBookLookupIndex(library, appService?.osPlatform);
    const failedImports: Array<{ filename: string; errorMessage: string }> = [];
    const failedPaths: string[] = [];
    const successfulImports: string[] = [];
    const existingImports: string[] = [];
    const revivedImports: string[] = [];
    // 本次真正新建的记录 hash，供批后二次探测在"本批新建"之间配对。
    const newImportHashes: string[] = [];
    // 补记了源路径的书数（复制模式账本）。>0 就要落盘，见末尾的保存闸门。
    let sourcePathsRecorded = 0;
    // 按监控文件夹归类的计数，供管理页逐行显示结果。键是归一化后的文件夹路径。
    const importedByFolder: Record<string, number> = {};
    const knownByFolder: Record<string, number> = {};
    const failedByFolder: Record<string, number> = {};

    // Readest's own Books/ prefix is resolved once at app init and persisted
    // in `settings.localBooksDir`. We hand it to `ingestFile` so the in-place
    // decision can exclude files that already live inside our managed hash
    // store WITHOUT misclassifying user-owned folders that happen to be
    // named "Books" (e.g. Baidu Netdisk's default `Books/` directory
    // directly under the user's library root).
    const appBooksPrefix: string | null =
      useSettingsStore.getState().settings.localBooksDir || null;

    const processFile = async (selectedFile: SelectedFile): Promise<Book | null> => {
      const file = selectedFile.file || selectedFile.path;
      if (!file) return null;
      if (!appService) return null;
      // `groupId` 三态（undefined=由 basePath 推导分组；''=根目录；字符串=指定分组）
      // 在 try 外求值——catch 分支处理"目录识别失败引导"时也需要它。
      let resolvedGroupId = groupId;
      let resolvedGroupName = groupId !== undefined ? getGroupName(groupId) : undefined;
      try {
        const { path, basePath } = selectedFile;
        // 分组规则跟设置一起从 store 现取：`runFolderImport` 可能刚把这个文件夹
        // 的规则写进设置，而组件闭包里的 `settings` 还是上一轮渲染的快照。
        // `options.folderRule` 是本次导入对话框选的那套规则——它必须优先，因为
        // "只导入不监控"时规则不会写进设置，只按设置解析会让「按作者分组」在
        // 一次性导入里被静默忽略（书落到完整镜像分组）。
        const liveSettings = useSettingsStore.getState().settings;
        if (resolvedGroupId === undefined && path && basePath) {
          resolvedGroupName = getFolderImportGroupName(
            path,
            basePath,
            resolveImportBatchFolderRule(options.folderRule, basePath, liveSettings),
          );
          resolvedGroupId = getGroupId(resolvedGroupName);
        }
        // Read settings from the store at call-time rather than the
        // component closure. `runFolderImport` may have just registered
        // the picked directory as an external library folder via
        // `setSettings(...)`, but React state updates don't mutate the
        // already-captured `settings` reference until the next render —
        // by the time we get here, the closure still holds the *old*
        // settings, so `shouldImportInPlace` would see an empty
        // `externalLibraryFolders` and incorrectly fall back to copy
        // mode. Pulling the latest snapshot from zustand fixes this.
        const result = await ingestFile(
          {
            file,
            books: library,
            lookupIndex,
            groupId: resolvedGroupId,
            groupName: resolvedGroupName,
            // 文件夹导入两条通路（手动 / 受监视重扫）开账本：复制模式下记住源路径，
            // 之后的每次重扫才能按路径短路，不必重新解析 + 重算 partialMD5。
            // 拖拽单文件导入不打开——那是一次性动作，没有账本需求。
            ...(options.rememberSourcePath ? { rememberSourcePath: true } : {}),
            // 静默重扫（受监视文件夹）同样收集冲突——它和手动导入唯一的区别是
            // "什么时候问"：静默路径整批结束后只给一条可点击通知，不弹模态框
            // （那时用户正在做别的事）。判定与入队逻辑完全共用；上限与溢出标记
            // 由队列模块统一处理，各条路径不会再各写一套。
            onVersionConflict: (info) => {
              enqueueVersionConflicts([info]);
            },
          },
          { appService, settings: liveSettings, appBooksPrefix },
        );
        if (!result) return null;
        // 三态结果决定提示语：复活与"已存在"都不能算成功导入，否则用户会以为
        // 书库多了本书（而实际上什么都没变）。
        if (result.outcome === 'revived') {
          revivedImports.push(result.book.title);
        } else if (result.outcome === 'already-in-library') {
          existingImports.push(result.book.title);
        } else {
          successfulImports.push(result.book.title);
          newImportHashes.push(result.book.hash);
        }
        // 账本变化必须落盘（见 runImportBooks 末尾的保存闸门）：重扫时命中的都是
        // "已在书库"，只补记路径的那一次如果不保存，账本随进程消失，下次重扫又把
        // 整个目录重新解析一遍。
        if (result.sourcePathRemembered) sourcePathsRecorded += 1;
        // 按监控文件夹归类本次结果，供管理页逐行显示"新增 N 本 / 失败 N 个"。
        const originFolder = selectedFile.watchedFolder
          ? normalizeRoot(selectedFile.watchedFolder)
          : undefined;
        if (originFolder) {
          // 复活也算"书架多了一本"：用户删过、源文件还在，重扫把它带回来。
          // 只统计真正新建的记录会让这次刷新报告"无新增"，而书明明回来了。
          if (result.outcome === 'imported' || result.outcome === 'revived') {
            importedByFolder[originFolder] = (importedByFolder[originFolder] ?? 0) + 1;
          } else {
            knownByFolder[originFolder] = (knownByFolder[originFolder] ?? 0) + 1;
          }
        }
        // 按作者自动归组：仅当用户没有明确指定目标分组、目录导入也没推导出
        // 分组（书本来会落在根目录）时才生效。优先级：
        // 用户显式选择 > 目录结构推导 > 作者匹配。盖 metadataUpdatedAt 时钟，
        // 否则多端同步时旧的元数据编辑会赢，把这个分组改动冲掉（同 #5438）。
        // 真新导入按作者匹配现存分组；dedup 重导入（byHash 命中、原样保留
        // 原分组）若恰好落在作者分组，同样纳入去向反馈——否则同一本书
        // 第二次拖入只有普通"成功导入"提示，去向信息凭空消失。撤销只针对
        // 本次真正归组的书（dedup 书本就在组里，撤销不该把它挪回根目录）。
        const book = result.book;
        // 顶层手动导入的去重落点（#3）：去重命中复活的书带着旧分组，用户
        // "拖到顶层"的意图优先——降回顶层（作者匹配组除外）。必须在按作者
        // 归组块之前判定，降组的书不再参与去向反馈/撤销。
        if (
          shouldDemoteDedupHitToRoot(book, {
            topLevelImport: groupId === undefined,
            noFolderDerivedGroup: !resolvedGroupName,
            userInitiated: !options.silent,
            dedupHit: knownHashes.has(book.hash) || result.existed,
          })
        ) {
          demoteBookToRoot(book);
        } else if (groupId === undefined && !resolvedGroupName && book.author) {
          if (!knownHashes.has(book.hash)) {
            const matchedGroupName = findAuthorGroupMatch(book.author, [...existingGroupNames]);
            if (matchedGroupName) {
              const now = Date.now();
              book.groupId = useLibraryStore.getState().getGroupId(matchedGroupName);
              book.groupName = matchedGroupName;
              book.updatedAt = now;
              book.metadataUpdatedAt = now;
              existingGroupNames.add(matchedGroupName);
              const entry = {
                hash: book.hash,
                title: book.title,
                groupId: book.groupId!,
                groupName: matchedGroupName,
              };
              authorGroupedImports.push(entry);
              regroupedImports.push(entry);
            }
          } else if (!result.existed && book.groupId) {
            const ownGroupName = matchesOwnGroupAuthor(book);
            if (ownGroupName) {
              authorGroupedImports.push({
                hash: book.hash,
                title: book.title,
                groupId: book.groupId,
                groupName: ownGroupName,
              });
            }
          }
        }
        // TXT 规则一条标题都没匹配上时，转换器按段落兜底切分（书已入库、
        // 但目录只是"1/2/3"序号）。弹引导让用户勾选标题行生成临时规则重切
        // （重切结果按 metaHash 并回同一本书）；取消则保留兜底导入。库中
        // 已有的重复导入不重复打扰。
        if (result.txtFallbackFile && !knownHashes.has(book.hash)) {
          const importFilename = typeof file === 'string' ? file : file.name;
          txtGuideQueueRef.current.push({
            file: result.txtFallbackFile,
            filename: getFilename(importFilename),
            groupId: resolvedGroupId,
            groupName: resolvedGroupName,
            fallbackImported: true,
          });
        }
        return book;
      } catch (error) {
        const filename = typeof file === 'string' ? file : file.name;
        if (typeof file === 'string') failedPaths.push(file);
        const baseFilename = getFilename(filename);
        // TXT 目录完全识别失败（内置规则一行未命中）且源是 File 时，改走引导
        // 而非直接报错：用户勾选标题行 → 生成临时规则 → 带新规则重切该文件
        // （见 TxtChapterGuideDialog）。
        if (
          (typeof file === 'object' || typeof file === 'string') &&
          error instanceof Error &&
          error.message.includes('No chapters detected')
        ) {
          // 桌面端三条导入路径（文件选择器/拖放/watched-folder）产出的全是
          // 字符串路径而非 File 对象。先读回 File 再走引导，否则引导框永不
          // 弹出、无法识别目录的 TXT 一律落到 failedImports 报错分支。
          let resolvedFile: File | null = null;
          if (typeof file === 'object') {
            resolvedFile = file;
          } else if (appService) {
            try {
              resolvedFile = await appService.openFile(file, 'None');
            } catch {
              resolvedFile = null;
            }
          }
          if (resolvedFile) {
            txtGuideQueueRef.current.push({
              file: resolvedFile,
              filename: baseFilename,
              groupId: resolvedGroupId,
              groupName: resolvedGroupName,
            });
            return null;
          }
        }
        const errorMessage = error instanceof Error ? _(getImportErrorMessage(error.message)) : '';
        failedImports.push({ filename: baseFilename, errorMessage });
        if (selectedFile.watchedFolder) {
          const originFolder = normalizeRoot(selectedFile.watchedFolder);
          failedByFolder[originFolder] = (failedByFolder[originFolder] ?? 0) + 1;
        }
        console.error('Failed to import book:', filename, error);
        return null;
      }
    };

    // Adaptive concurrency: every file is buffered into the webview for
    // parsing, so importing several large books at once spikes memory. Window
    // the batch by size — no window holds more than MAX_CONCURRENT_FILES and
    // total in-flight bytes stays under MAX_INFLIGHT_BYTES — so a single large
    // book never shares a window with others while small books still batch up.
    const MAX_CONCURRENT_FILES = 4;
    const MAX_INFLIGHT_BYTES = 256 * 1024 * 1024;
    const sizedFiles = await Promise.all(
      files.map(async (selectedFile) => {
        let size = 0;
        if (selectedFile.file) {
          size = selectedFile.file.size;
        } else if (selectedFile.path && appService) {
          try {
            size = (await appService.stats(selectedFile.path, 'None')).size ?? 0;
          } catch {
            // Unknown size — treat as light so it never throttles the batch.
          }
        }
        return { selectedFile, size };
      }),
    );
    const batches: SelectedFile[][] = [];
    let currentBatch: SelectedFile[] = [];
    let currentBytes = 0;
    for (const { selectedFile, size } of sizedFiles) {
      if (
        currentBatch.length >= MAX_CONCURRENT_FILES ||
        (currentBatch.length > 0 && currentBytes + size > MAX_INFLIGHT_BYTES)
      ) {
        batches.push(currentBatch);
        currentBatch = [];
        currentBytes = 0;
      }
      currentBatch.push(selectedFile);
      currentBytes += size;
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    // Periodically persist the library index while the run is in flight so a
    // crash/kill mid-import (#5601) loses at most one interval of work instead
    // of the whole run — the book dirs are written per file, and index rows
    // that never reach disk are what re-imports and duplicate rows are made
    // of. Saving per book would bring back the "library.json save dominates
    // large imports" cost, hence the throttle.
    const checkpoint = createThrottledCheckpoint(async () => {
      const currentLibrary = useLibraryStore.getState().library;
      const currentAppService = await envConfig.getAppService();
      await currentAppService.saveLibraryBooks(currentLibrary);
    }, IMPORT_CHECKPOINT_INTERVAL_MS);

    try {
      for (const batch of batches) {
        const importedBooks = (await Promise.all(batch.map(processFile))).filter((book) => !!book);
        // Update store state per batch (so the UI can render imported books
        // incrementally) but defer disk persistence until the entire batch is
        // done — saving library.json once per batch of 4 books was the dominant
        // cost for large imports.
        if (importedBooks.length > 0) {
          await updateBooks(envConfig, importedBooks, { skipSave: true });
          checkpoint.touch();
        }
        processedFiles += batch.length;
        setImportProgress({ done: processedFiles, total: totalFiles });
      }
    } finally {
      // Persist whatever the last checkpoint hasn't covered, also on a
      // mid-run exception (the batch loop's per-file errors are caught inside
      // processFile; this guards anything the loop itself might throw).
      await checkpoint.flush();
    }

    // Persist the full library once after every file in the batch is done.
    // 复活也算改动（清了墓碑），必须落盘，否则重启后那本书又是"已删除"。
    // 账本同理：重扫只补记源路径时 `successfulImports`/`revivedImports` 都是空的，
    // 不把它算进闸门的话这次补记根本不会写盘，下次重扫又要整目录重新解析。
    let saveFailed = false;
    if (successfulImports.length > 0 || revivedImports.length > 0 || sourcePathsRecorded > 0) {
      const finalLibrary = useLibraryStore.getState().library;
      const finalAppService = await envConfig.getAppService();
      try {
        await finalAppService.saveLibraryBooks(finalLibrary);
      } catch (error) {
        // 书目已进内存 store（书架上可见），但磁盘未写入——不提示的话用户
        // 以为导入成功，重启后书"消失"（典型诱因：双窗口书库锁超时）。
        saveFailed = true;
        console.error('Failed to persist imported books:', error);
        eventDispatcher.dispatch('toast', {
          message: _('Failed to save library'),
          timeout: 4000,
          type: 'error',
        });
      }
    }

    if (!options.silent && failedImports.length > 1) {
      setFailedImportsModal(failedImports);
    } else if (!options.silent && failedImports.length === 1) {
      const { filename, errorMessage } = failedImports[0]!;
      eventDispatcher.dispatch('toast', {
        message:
          _('Failed to import book(s): {{filenames}}', {
            filenames: listFormater(false).format([filename]),
          }) + (errorMessage ? `\n${errorMessage}` : ''),
        timeout: 5000,
        type: 'error',
      });
    }
    // Surface the success toast when books were imported. In silent (auto-import)
    // mode failures are suppressed, so show success independently of them; in
    // interactive mode keep the original behaviour (only when nothing failed).
    // Duplicate imports are reported separately ("Already in library") instead
    // of counting as successes; silent re-scans must never toast that.
    const importToast = options.silent
      ? successfulImports.length > 0 && !saveFailed
        ? {
            type: 'success' as const,
            message: _('Successfully imported {{count}} book(s)', {
              count: successfulImports.length,
            }),
          }
        : null
      : resolveImportToast({
          newTitles: successfulImports,
          existingTitles: existingImports,
          revivedTitles: revivedImports,
          failedCount: failedImports.length,
          saveFailed,
          formatList: (titles) => listFormater(false).format(titles),
          t: _,
        });
    // 有书被自动归组时，toast 升级为带去向的版本（逐分组列出书名），并附
    // "前往查看"（单分组时）与"撤销"操作；基础计数行保留在最上面。
    const groupedToastSpec =
      authorGroupedImports.length > 0 && !saveFailed
        ? buildAuthorGroupedToastSpec(
            importToast?.message ?? '',
            authorGroupedImports,
            (group, titles) =>
              _('Moved into group "{{group}}": {{titles}}', {
                group,
                titles: listFormater(false).format(titles),
              }),
          )
        : null;
    if (groupedToastSpec) {
      const actions = [];
      if (groupedToastSpec.groupIds.length === 1) {
        const targetGroupId = groupedToastSpec.groupIds[0]!;
        actions.push({
          label: _('View'),
          onClick: () => {
            handleLibraryNavigation(targetGroupId);
            highlightBooks(authorGroupedImports.map((entry) => entry.hash));
          },
        });
      }
      actions.push({
        label: _('Undo'),
        onClick: () => undoAuthorGrouping(regroupedImports),
      });
      eventDispatcher.dispatch('toast', {
        message: groupedToastSpec.message,
        timeout: 8000,
        type: importToast?.type ?? 'success',
        actions,
      });
    } else if (importToast) {
      eventDispatcher.dispatch('toast', {
        message: importToast.message,
        timeout: importToast.type === 'info' ? 2500 : 2000,
        type: importToast.type,
      });
    }

    // 有 TXT 目录识别失败的待引导文件 → 弹出引导（一次一个，完成/取消后再下一个）。
    if (txtGuideQueueRef.current.length > 0) {
      setGuideItem(txtGuideQueueRef.current.shift()!);
    }
    // 批后二次探测：一次拖入多个版本时，批内两本互为新旧版本，而导入那一刻
    // 的探针看不见对方（对方还不存在）。整批落盘后在最终书库上把"本次新建"
    // 的记录两两互查一遍，命中补进冲突队列——同一对只报一次，导入时刻已经
    // 报过的冲突不会重复。
    if (newImportHashes.length > 1) {
      // 入队即可：队列模块按 incoming 去重（同一对本批版本可能已经被导入时刻
      // 的探针报过一次），上限与溢出标记也在那里统一处理。
      enqueueVersionConflicts(
        findBatchVersionConflicts({
          importedHashes: newImportHashes,
          library: useLibraryStore.getState().library,
        }),
      );
    }

    // 有疑似旧版本的冲突：手动导入整批一次弹窗（此时新书记录已入库落盘、旧记录
    // 原封不动，用户关掉窗口不做选择就是"两本都留着"，不会有任何东西被删）。
    // 静默路径（受监视文件夹重扫、双击/「打开方式」）不弹模态框——那时用户在
    // 做别的事——只给一条可点击通知，点它或下次回到书库页时再问。
    if (pendingVersionConflictCount() > 0) {
      if (options.silent) {
        notifyPendingVersionConflicts();
      } else {
        drainVersionConflicts();
      }
    }
    return { failedPaths, importedByFolder, knownByFolder, failedByFolder, sourcePathsRecorded };
  };

  /**
   * Apply the user's per-item choices from the version-conflict dialog.
   *
   * Every replacement goes through `replaceBookVersion`, which persists the
   * library itself; the store is adopted from the returned snapshot rather than
   * rebuilt locally so memory and library.json cannot disagree.
   */
  const resolveVersionConflicts = async (
    conflicts: BookVersionConflictInfo[],
    choices: BookVersionConflictChoice[],
  ) => {
    // Two conflicts can point at the same old record (one batch holding two
    // releases of a book the library already has). An old record can only be
    // folded once; the rest stay as separate books, and saying so beats the
    // user thinking the second "replace" silently did nothing.
    const { replacements, discards, skipped } = planVersionConflictResolution(conflicts, choices);
    if (replacements.length === 0 && discards.length === 0) return;
    setLoading(true);
    setImportProgress({ done: 0, total: replacements.length + discards.length });
    const app = appService ?? (await envConfig.getAppService());
    let done = 0;
    const failed: string[] = [];
    const undoFailed: string[] = [];
    // 选了撤销、但那条记录已经不在了（同批另一次「替换」把它折进了新版）：
    // 结果与用户想要的"别再单独留着这本书"一致，但不是这次操作做的——分开记，
    // 否则提示会声称撤销了一件根本没发生的事。
    const undoneAlreadyFolded: string[] = [];
    try {
      for (const conflict of replacements) {
        try {
          const { library } = useLibraryStore.getState();
          const result = await replaceBookVersion(app, {
            oldBook: conflict.candidates[0]!,
            newBook: conflict.incoming,
            books: library,
          });
          setLibrary(result.library);
        } catch (error) {
          console.error('Failed to replace book version:', conflict.incoming.title, error);
          failed.push(conflict.incoming.title);
        }
        done += 1;
        setImportProgress({ done, total: replacements.length + discards.length });
      }
      // 撤销导入：只丢开刚导入的那一本，库里原来那条原封不动（留给它一条
      // 墓碑，好让受监视文件夹的重扫不再把这个文件当新文件反复弹窗）。
      for (const conflict of discards) {
        try {
          const { library } = useLibraryStore.getState();
          const result = await discardImportedBook(app, {
            book: conflict.incoming,
            books: library,
          });
          setLibrary(result.library);
          if (!result.applied) undoneAlreadyFolded.push(conflict.incoming.title);
        } catch (error) {
          console.error('Failed to discard imported book:', conflict.incoming.title, error);
          undoFailed.push(conflict.incoming.title);
        }
        done += 1;
        setImportProgress({ done, total: replacements.length + discards.length });
      }
    } finally {
      setLoading(false);
      setImportProgress(null);
    }
    const replaced = replacements.length - failed.length;
    if (replaced > 0) {
      eventDispatcher.dispatch('toast', {
        message: `已用新版替换 ${replaced} 本书，阅读进度和书签已保留`,
        timeout: 3000,
        type: 'success',
      });
    }
    const undone = discards.length - undoFailed.length - undoneAlreadyFolded.length;
    if (undone > 0) {
      eventDispatcher.dispatch('toast', {
        message: `已撤销 ${undone} 本导入，书库保持原样`,
        timeout: 3000,
        type: 'success',
      });
    }
    if (undoneAlreadyFolded.length > 0) {
      eventDispatcher.dispatch('toast', {
        message: `《${undoneAlreadyFolded.join('》《')}》已随同批的「用新版替换」并入新版，无需再撤销`,
        timeout: 6000,
        type: 'info',
      });
    }
    if (failed.length > 0) {
      eventDispatcher.dispatch('toast', {
        message: `《${failed.join('》《')}》替换失败，旧版本已保留`,
        timeout: 6000,
        type: 'error',
      });
    }
    if (undoFailed.length > 0) {
      eventDispatcher.dispatch('toast', {
        message: `《${undoFailed.join('》《')}》撤销失败，已保留为独立书目`,
        timeout: 6000,
        type: 'error',
      });
    }
    // Only report the ones the user actually asked to replace — the default
    // "keep" choices are not worth mentioning.
    if (skipped.length > 0) {
      eventDispatcher.dispatch('toast', {
        message: `《${skipped
          .map((conflict) => conflict.incoming.title)
          .join('》《')}》指向的旧版本已被另一本替换，这两本保留为独立书目`,
        timeout: 6000,
        type: 'info',
      });
    }
    // 队列里可能还有本次弹窗期间攒下的冲突（静默重扫与手动导入撞在一起），
    // 收尾后接着问。
    drainVersionConflicts();
  };

  /**
   * Re-scan the given watched folders and import any newly-added books, one
   * rule per folder (structure mode, formats, minimum size). Reuses the same
   * dedup as manual folder import but stays quiet: unreadable folders are
   * recorded as that folder's error rather than aborting the others, and
   * `importBooks` runs only when genuinely-new files exist.
   *
   * Returns one outcome per folder so both callers can report it — the silent
   * focus-triggered scan stores them for the manage dialog, the manual
   * "refresh" turns them into a toast. `null` means the scan was skipped
   * because an import batch was already running.
   */
  const scanWatchedFolders = async (
    folders: string[],
  ): Promise<WatchedFolderScanOutcome[] | null> => {
    if (!appService || folders.length === 0) return null;
    // A batch already in flight owns the import path (and the full-screen
    // loading overlay). Report "busy" instead of silently importing nothing —
    // a manual refresh that claimed "nothing new" would be a lie. Checked with
    // the ref as well as the state: a batch that started in this same tick has
    // not re-rendered yet.
    if (loading || importingRef.current) return null;
    const { library } = useLibraryStore.getState();
    const osPlatform = appService.osPlatform;
    const liveSettings = useSettingsStore.getState().settings;
    // Known local source paths — live AND soft-deleted (files the user deleted
    // but whose in-place source is still on disk), plus paths that already failed
    // to import this session — so we neither resurrect a deleted book nor
    // re-parse/re-toast a bad file on every focus.
    const existingPaths = collectKnownSourcePaths(library, osPlatform);
    for (const key of autoImportFailedPathsRef.current) existingPaths.add(key);
    const outcomes: WatchedFolderScanOutcome[] = [];
    const newFiles: SelectedFile[] = [];
    for (const folder of folders) {
      let error: string | undefined;
      try {
        if (!autoImportGrantedFoldersRef.current.has(folder)) {
          await appService.allowPathsInScopes?.([folder], true);
          autoImportGrantedFoldersRef.current.add(folder);
        }
        const rule = resolveWatchedFolderRule(folder, liveSettings);
        const items = await appService.readDirectory(folder, 'None', rule.extensions);
        const entries = items.map((item) => ({
          fullPath: joinScannedPath(folder, item.path),
          size: item.size,
        }));
        const fresh = selectNewImportableFiles(entries, {
          extensions: rule.extensions,
          minSizeBytes: Math.max(0, Math.floor(rule.minSizeKB)) * 1024,
          existingPaths,
          osPlatform,
        });
        // Reproduce the folder's own "Folder Structure" rule: unless it is
        // flattened, each file carries the watched folder as `basePath` so
        // `importBooks` seats the book in the group the rule implies — the same
        // group the folder's initial import used (issue #5423).
        newFiles.push(...toWatchedFolderImports(folder, fresh, rule.mode));
        for (const entry of fresh) {
          // Prevent the same file matching again via a later overlapping folder.
          const key = normalizeFilePathForIndex(entry.fullPath, osPlatform);
          if (key) existingPaths.add(key);
        }
      } catch (e) {
        // One unreadable/temporarily-missing folder must not abort the others
        // or nag the user (unlike the manual path, which nudges a re-pick).
        console.error('Auto-import: failed to scan folder', folder, e);
        error = e instanceof Error ? e.message : String(e);
      }
      outcomes.push({ folder, imported: 0, failed: 0, known: 0, ...(error ? { error } : {}) });
    }

    if (newFiles.length > 0) {
      // The directory walk above awaits, so an import batch can have started
      // since the check at the top of this function. Being here again means
      // `importBooks` would refuse the batch and hand back an empty result,
      // which every caller would then report as "no new books" — wrong on both
      // counts. Report "busy" instead.
      if (loading || importingRef.current) return null;
      const result = await importBooks(newFiles, undefined, {
        silent: true,
        // 复制模式也要记住源路径，否则这一批书每次回前台都要重新解析 + 重算 md5。
        rememberSourcePath: true,
      });
      for (const p of result.failedPaths) {
        const key = normalizeFilePathForIndex(p, osPlatform);
        if (key) autoImportFailedPathsRef.current.add(key);
      }
      for (const outcome of outcomes) {
        const key = normalizeRoot(outcome.folder);
        outcome.imported = result.importedByFolder[key] ?? 0;
        outcome.known = result.knownByFolder[key] ?? 0;
        outcome.failed = result.failedByFolder[key] ?? 0;
      }
    }
    return outcomes;
  };

  /** Store the newest scan result per folder (state + localStorage, display only). */
  const recordWatchedFolderResults = useCallback((outcomes: WatchedFolderScanOutcome[]) => {
    if (outcomes.length === 0) return;
    const at = Date.now();
    setWatchedFolderResults((prev) => {
      const next: Record<string, WatchedFolderScanStatus> = { ...prev };
      for (const outcome of outcomes) {
        next[normalizeRoot(outcome.folder)] = {
          at,
          imported: outcome.imported,
          failed: outcome.failed,
          ...(outcome.error ? { error: outcome.error } : {}),
        };
      }
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(WATCHED_FOLDER_STATUS_KEY, JSON.stringify(next));
        } catch (e) {
          console.error('Failed to persist watched folder status:', e);
        }
      }
      return next;
    });
  }, []);

  /**
   * The focus-triggered auto-import. Runs in the background while the user is
   * doing something else, so it never toasts: results land in the manage
   * dialog's per-folder status lines instead.
   */
  const autoImportFromWatchedFolders = async (folders: string[]) => {
    const outcomes = await scanWatchedFolders(folders);
    if (outcomes) recordWatchedFolderResults(outcomes);
  };

  /**
   * Manual refresh from the manage dialog (one row or every folder). Same scan
   * as the background path, but with visible feedback and a busy guard so a
   * double-click can't start two batches.
   */
  const refreshWatchedFolders = async (folder?: string) => {
    if (watchedFolderRefreshingRef.current) return;
    const targets = folder
      ? [folder]
      : (useSettingsStore.getState().settings.autoImportFolders ?? []);
    if (targets.length === 0) return;
    watchedFolderRefreshingRef.current = true;
    setWatchedFolderRefreshing(folder ?? 'all');
    try {
      const outcomes = await scanWatchedFolders(targets);
      if (!outcomes) {
        // Skipped: an import batch is already running (manual import or a
        // background scan). Say so rather than reporting a false "nothing new".
        eventDispatcher.dispatch('toast', {
          type: 'info',
          timeout: 3000,
          message: _('Another import is still running. Try again in a moment.'),
        });
        return;
      }
      recordWatchedFolderResults(outcomes);
      const imported = outcomes.reduce((sum, o) => sum + o.imported, 0);
      const failed = outcomes.reduce((sum, o) => sum + o.failed, 0);
      const unreadable = outcomes.filter((o) => o.error).length;
      const message =
        imported > 0
          ? _('Successfully imported {{count}} book(s)', { count: imported })
          : _('No new books found.');
      eventDispatcher.dispatch('toast', {
        type: imported > 0 && failed === 0 && unreadable === 0 ? 'success' : 'info',
        timeout: 4000,
        message:
          failed > 0 || unreadable > 0
            ? `${message} ${_('{{count}} item(s) could not be imported.', { count: failed + unreadable })}`
            : message,
      });
    } finally {
      watchedFolderRefreshingRef.current = false;
      setWatchedFolderRefreshing(null);
    }
  };

  useAutoImportFolders({
    enabled: (settings.autoImportFolders?.length ?? 0) > 0 && libraryLoaded && isTauriAppPlatform(),
    folders: settings.autoImportFolders ?? [],
    scanAndImport: autoImportFromWatchedFolders,
  });

  const handleBookDelete = (deleteAction: DeleteAction) => {
    return async (book: Book) => {
      const deletionMessages: Partial<Record<DeleteAction, string>> = {
        both: _('Book deleted: {{title}}', { title: book.title }),
        local: _('Deleted local copy of the book: {{title}}', { title: book.title }),
        purge: _('Purged book data: {{title}}', { title: book.title }),
      };
      const deletionFailMessages: Partial<Record<DeleteAction, string>> = {
        both: _('Failed to delete book: {{title}}', { title: book.title }),
        local: _('Failed to delete local copy of the book: {{title}}', { title: book.title }),
        purge: _('Failed to purge book data: {{title}}', { title: book.title }),
      };

      try {
        if (deleteAction === 'local' || deleteAction === 'both' || deleteAction === 'purge') {
          await appService?.deleteBook(book, deleteAction === 'purge' ? 'purge' : 'local');
          if (deleteAction === 'both' || deleteAction === 'purge') {
            book.deletedAt = Date.now();
            book.downloadedAt = null;
            book.coverDownloadedAt = null;
          }
          await updateBook(envConfig, book);
          if (ttsSessionManager.getSessionByHash(book.hash)) {
            await ttsSessionManager.stopActive('deleted');
          }
          clearBookData(book.hash);
        }

        eventDispatcher.dispatch('toast', {
          type: 'info',
          timeout: 1000,
          message:
            deletionMessages[deleteAction] ?? _('Book deleted: {{title}}', { title: book.title }),
        });
        return true;
      } catch {
        eventDispatcher.dispatch('toast', {
          message:
            deletionFailMessages[deleteAction] ??
            _('Failed to delete book: {{title}}', { title: book.title }),
          type: 'error',
        });
        return false;
      }
    };
  };

  const handleUpdateMetadata = async (book: Book, metadata: BookMetadata, tags: string[]) => {
    // Build a NEW book object instead of mutating `book` in place. <BookCover>
    // is memoized and compares fields off the book, so mutating the existing
    // object (which React holds as the previous snapshot) makes the comparator
    // see no change and the library cover only refreshes after a full reload.
    const updatedBook = getBookWithUpdatedMetadata(book, metadata, tags);
    if (metadata.coverImageBlobUrl || metadata.coverImageUrl || metadata.coverImageFile) {
      try {
        await appService?.updateCoverImage(
          updatedBook,
          metadata.coverImageBlobUrl || metadata.coverImageUrl,
          metadata.coverImageFile,
        );
      } catch (error) {
        console.warn('Failed to update cover image:', error);
      }
    }
    metadata.coverImageUrl = undefined;
    metadata.coverImageBlobUrl = undefined;
    metadata.coverImageFile = undefined;
    await updateBook(envConfig, updatedBook);
  };

  const handleMetadataValueClick = (type: 'tag' | 'subject', value: string) => {
    const groupBy = type === 'tag' ? LibraryGroupByType.Tag : LibraryGroupByType.Subject;
    const targetGroup = createBookGroups(libraryBooks, groupBy).find(
      (item): item is BooksGroup => 'books' in item && item.name === value,
    );
    if (!targetGroup) return;
    const params = new URLSearchParams(window.location.search);
    params.set('groupBy', groupBy);
    params.set('group', targetGroup.id);
    // 与 handleLibraryNavigation 一致：从详情模态跳入标签/主题虚拟分组也要记来源
    // group（当前所在位置），否则退出该分组会回顶层而非打开详情前的视图。
    params.set('from', searchParams?.get('group') || '');
    params.delete('q');
    setShowDetailsBook(null);
    navigateToLibrary(router, params.toString());
  };

  const getImportTargetGroupId = () => {
    const group = searchParams?.get('group') || '';
    // Import into the current folder group whenever the view is inside one,
    // regardless of the display dimension chosen for it. At the top level
    // return undefined — the "derive" tri-state — rather than '': an explicit
    // empty string would pin books to the root and block author-based
    // auto-grouping, while undefined lets the per-file resolution run.
    return group && getGroupName(group) ? group : undefined;
  };

  const handleImportBooksFromFiles = async () => {
    setIsSelectMode(false);
    selectFiles({ type: 'books', multiple: true }).then((result) => {
      if (result.error) {
        // The selector itself failed (platform denial, IPC error) — silence
        // here reads as a dead button.
        eventDispatcher.dispatch('toast', {
          message: _('Failed to open file selector'),
          type: 'error',
        });
        return;
      }
      if (result.files.length === 0) return;
      importBooks(result.files, getImportTargetGroupId());
    });
  };

  const handleImportBooksFromDirectory = async (dirPath?: string) => {
    if (!appService || !isTauriAppPlatform()) return;

    setIsSelectMode(false);

    // When a path is supplied (e.g. URL ingress / drag-drop replay) we
    // honour the legacy "import everything" behaviour without opening
    // the dialog. Manual menu invocations always go through the dialog
    // so users can pick formats and a size threshold before scanning.
    if (dirPath) {
      await runFolderImport(
        {
          directory: dirPath,
          extensions: SUPPORTED_BOOK_EXTS.slice(),
          // The non-dialog path is invoked by URL ingress / drag-drop
          // replay, where the user never picked any filter — keep the
          // synthetic values minimal and non-restrictive.
          selectedGroupIds: [],
          minSizeKB: 0,
          folderMode: 'mirror',
          // URL ingress / drag-drop don't go through the dialog and so
          // can't set this. Default to the legacy "copy" behaviour;
          // already-registered external roots will still be detected
          // by `runFolderImport` itself via the prefix check, so books
          // under a registered folder are imported in-place either way.
          readInPlace: false,
          // Non-dialog path never opts into auto-import.
          autoImport: false,
        },
        // Nobody asked about this folder here: it neither starts nor stops
        // watching it, and the synthetic "mirror" above must not overwrite the
        // structure a watched folder already records for itself.
        { manageWatching: false },
      );
      return;
    }

    // Restore both the last-used folder and the last folder-structure
    // mode from localStorage. Anything else (or first-time use) falls
    // back to the dialog's built-in defaults.
    const ls = typeof window !== 'undefined' ? window.localStorage : null;
    const storedDirectory = ls?.getItem(LAST_IMPORT_FOLDER_KEY) || '';
    const storedMode = ls?.getItem(LAST_IMPORT_FOLDER_MODE_KEY);
    const storedFormats = ls?.getItem(LAST_IMPORT_FOLDER_FORMATS_KEY);
    const storedMinSize = ls?.getItem(LAST_IMPORT_FOLDER_MIN_SIZE_KEY);
    const storedReadInPlace = ls?.getItem(LAST_IMPORT_FOLDER_READ_IN_PLACE_KEY);
    const parsedFormats = storedFormats
      ? storedFormats
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const parsedMinSize =
      storedMinSize !== null && storedMinSize !== undefined
        ? Number.parseInt(storedMinSize, 10)
        : undefined;
    // A watched folder's own rule wins over the generic "last used" values:
    // re-opening the dialog on folder A must show A's structure, formats and
    // size floor, or confirming would quietly rewrite A's rule with whatever
    // folder B was last imported with. Only a folder that is *not* watched
    // takes the last-used values — those describe the import the user is about
    // to start.
    //
    // Resolved, not stored: a folder watched before per-folder rules existed
    // has no entry in the rules map, and seeding from `undefined` would leave
    // the dialog showing the last-import formats and mode for it — then
    // confirming would narrow that folder's scans (dropping formats it used to
    // take) and could flip a flattened folder back to grouping.
    const watched = isAutoImportFolder(storedDirectory);
    const watchedRule = watched ? resolveWatchedFolderRule(storedDirectory, settings) : undefined;
    const watchedGroupIds = watchedRule ? formatGroupIdsForExtensions(watchedRule.extensions) : [];
    setImportFromFolderState({
      initialDirectory: storedDirectory,
      initialFolderMode: watchedRule?.mode ?? readLastImportFolderMode(storedMode),
      initialSelectedGroupIds: watchedGroupIds.length > 0 ? watchedGroupIds : parsedFormats,
      initialMinSizeKB:
        watchedRule?.minSizeKB ??
        (parsedMinSize !== undefined && Number.isFinite(parsedMinSize) && parsedMinSize >= 0
          ? parsedMinSize
          : undefined),
      initialReadInPlace: storedReadInPlace === '1',
      initialAutoImport: watched,
    });
  };

  /**
   * Pop the platform's native folder picker. Wrapped here (rather than
   * inlined into the dialog) so the same Android-permission / Tauri
   * dialog dance is shared between the dialog's "change folder" button
   * and any future programmatic import paths.
   */
  const pickImportDirectory = async (): Promise<string | undefined> => {
    if (!appService) return undefined;
    const picked = (await appService.selectDirectory?.('read')) || undefined;
    if (picked && !validatePickedDirectory(picked)) {
      // Already toasted from inside the validator. Treat as "no
      // selection" so the caller leaves the dialog's old folder
      // value alone and the user can immediately try again.
      return undefined;
    }
    return picked;
  };

  /**
   * Sanity-check a path returned by the native folder picker before
   * we commit to scanning it. Desktop paths are all readable, so every
   * pick is accepted as-is.
   */
  const validatePickedDirectory = (_path: string): boolean => true;

  /**
   * Normalize a path the same way `shouldImportInPlace` does so the
   * predicate / store helpers below stay consistent with the ingest
   * layer's own path-prefix matching. Trailing separators and Windows
   * backslashes are normalized; nothing else is touched.
   */
  const normalizeRoot = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');

  /**
   * `true` when `directory` is already in
   * `settings.externalLibraryFolders` after path normalization. Hands
   * over to the ImportFromFolderDialog so it can render the "Read in
   * place" toggle as ON-and-locked when the user re-imports from a
   * folder they've already registered. The match is exact-string
   * (after normalization) — sub-paths of a registered folder are NOT
   * considered registered roots themselves, only the registered root
   * is.
   */
  const isRegisteredExternalRoot = (directory: string): boolean => {
    const target = normalizeRoot(directory);
    if (!target) return false;
    const roots = settings.externalLibraryFolders ?? [];
    return roots.some((r) => normalizeRoot(r) === target);
  };

  /**
   * `true` when `directory` is in `settings.autoImportFolders` after path
   * normalization. Seeds the dialog's "Auto-import new books from this
   * folder" checkbox so re-opening on a watched folder shows it ticked.
   */
  const isAutoImportFolder = (directory: string): boolean => {
    const target = normalizeRoot(directory);
    if (!target) return false;
    const roots = settings.autoImportFolders ?? [];
    return roots.some((r) => normalizeRoot(r) === target);
  };

  /**
   * The watched folders as the manage dialog wants them: path plus the resolved
   * rule (structure mode, formats, minimum size) and the folder's newest scan
   * result. Derived from `settings` rather than the store snapshot so adding or
   * re-pointing a folder re-renders the list immediately.
   */
  const watchedFolderRows: WatchedFolderRow[] = (settings.autoImportFolders ?? []).map((path) => ({
    path,
    rule: resolveWatchedFolderRule(path, settings),
    storedRule: findStoredWatchedFolderRule(path, settings),
    status: watchedFolderResults[normalizeRoot(path)],
  }));

  /**
   * Add `directory` to `settings.externalLibraryFolders` (and persist
   * settings) so the ingest layer's `shouldImportInPlace` will pick
   * up subsequent imports from the same folder automatically. No-op
   * when the folder is already registered. Errors are swallowed
   * because the import flow can still succeed in copy mode even if
   * registration fails — we just won't get the in-place behaviour
   * next launch.
   */
  const registerExternalLibraryFolder = async (directory: string): Promise<void> => {
    const target = normalizeRoot(directory);
    if (!target) return;
    const liveSettings = useSettingsStore.getState().settings;
    const existing = liveSettings.externalLibraryFolders ?? [];
    if (existing.some((r) => normalizeRoot(r) === target)) {
      return;
    }
    const next = [...existing, directory];
    const nextSettings = { ...liveSettings, externalLibraryFolders: next };
    setSettings(nextSettings);
    try {
      await saveSettings(envConfig, nextSettings);
    } catch (e) {
      console.error('Failed to persist externalLibraryFolders update:', e);
    }
  };

  /**
   * Add or remove `directory` from `settings.autoImportFolders` (and persist)
   * per the user's per-folder "Auto-import new books from this folder" choice.
   * `mode` records the same import's "Folder Structure" pick (plus the formats
   * and minimum size that import used) so later scans reproduce it exactly.
   *
   * New writes go into `autoImportFolderRules`; the legacy
   * `autoImportFlattenFolders` array is only read as a fallback for folders the
   * new code has never touched, so any folder handled here is dropped from it
   * (leaving a stale entry behind would keep overriding the rule). A no-op when
   * the folder is already in the desired state. Errors are swallowed — the
   * import itself still succeeds; we just won't watch (or stop watching) the
   * folder until the next successful settings write.
   */
  const setAutoImportFolder = async (
    directory: string,
    enabled: boolean,
    mode: WatchedFolderMode,
    filters?: { extensions: string[]; minSizeKB: number },
  ): Promise<void> => {
    const target = normalizeRoot(directory);
    if (!target) return;
    const liveSettings = useSettingsStore.getState().settings;
    const existing = liveSettings.autoImportFolders ?? [];
    const present = existing.some((r) => normalizeRoot(r) === target);
    const storedRule = findStoredWatchedFolderRule(directory, liveSettings);
    const nextRule: WatchedFolderRule = {
      ...storedRule,
      mode,
      ...(filters ? { extensions: filters.extensions, minSizeKB: filters.minSizeKB } : {}),
    };
    // Skip a redundant settings write when the folder is already exactly in the
    // desired state — this runs on every row edit, and a no-op write would still
    // re-render the list under the user's finger.
    const ruleUnchanged =
      !!storedRule &&
      storedRule.mode === nextRule.mode &&
      JSON.stringify(storedRule.extensions ?? null) ===
        JSON.stringify(nextRule.extensions ?? null) &&
      (storedRule.minSizeKB ?? null) === (nextRule.minSizeKB ?? null);
    if (enabled === present && (enabled ? ruleUnchanged : !storedRule)) return;
    // Append only when the folder isn't listed yet: re-adding an existing entry
    // would move it to the end and shuffle the managed list under the user's
    // finger every time they flip a row's structure mode.
    const without = (roots: string[]) => roots.filter((r) => normalizeRoot(r) !== target);
    const next = enabled ? (present ? existing : [...existing, directory]) : without(existing);
    const nextRules = enabled
      ? withWatchedFolderRule(liveSettings.autoImportFolderRules, directory, nextRule)
      : withoutWatchedFolderRule(liveSettings.autoImportFolderRules, directory);
    const nextSettings = {
      ...liveSettings,
      autoImportFolders: next,
      autoImportFlattenFolders: without(liveSettings.autoImportFlattenFolders ?? []),
      autoImportFolderRules: nextRules,
    };
    setSettings(nextSettings);
    try {
      await saveSettings(envConfig, nextSettings);
    } catch (e) {
      console.error('Failed to persist autoImportFolders update:', e);
    }
  };

  /** Stop watching `folder`; it stays readable in place if it was registered. */
  const removeWatchedFolder = async (path: string) => {
    await setAutoImportFolder(path, false, 'mirror');
  };

  /**
   * Change one folder's scan rule from the manage dialog (structure mode,
   * formats, minimum size), leaving the rest of its rule alone. The folder has
   * to stay watched for the change to mean anything, so it is added back to
   * `autoImportFolders` when it somehow isn't listed.
   */
  const updateWatchedFolderRule = async (
    path: string,
    patch: Partial<WatchedFolderRule>,
  ): Promise<void> => {
    const liveSettings = useSettingsStore.getState().settings;
    const resolved = resolveWatchedFolderRule(path, liveSettings);
    await setAutoImportFolder(path, true, patch.mode ?? resolved.mode, {
      extensions: patch.extensions ?? resolved.extensions,
      minSizeKB: patch.minSizeKB ?? resolved.minSizeKB,
    });
  };

  /**
   * "Add folder" in the manage dialog: pick a directory, start watching it with
   * the dialog's defaults (mirror the structure, EPUB+PDF..., 20 KB), and scan
   * it right away so the user sees the books arrive instead of waiting for the
   * next focus event.
   *
   * Watching does NOT register the folder as an external library folder
   * (R1): without "read books in place" its books are copied into the library,
   * and the source path is remembered so later scans stay cheap.
   */
  const addWatchedFolder = async (): Promise<void> => {
    const directory = await pickImportDirectory();
    if (!directory) return;
    await setAutoImportFolder(directory, true, 'mirror', {
      extensions: [...SUPPORTED_BOOK_EXTS],
      minSizeKB: DEFAULT_WATCHED_FOLDER_MIN_SIZE_KB,
    });
    await refreshWatchedFolders(directory);
  };

  /**
   * Open the manager dialog. Both entry points (library import menu, Settings →
   * Custom) go through the store flag; the effect below restores the persisted
   * per-folder scan results whenever it flips open.
   */
  const openWatchedFolders = useCallback(() => {
    useSettingsStore.getState().setWatchedFoldersDialogOpen(true);
  }, []);

  /** Restore the display-only per-folder scan results (never written to settings). */
  useEffect(() => {
    if (!isWatchedFoldersDialogOpen) return;
    try {
      const stored = window.localStorage.getItem(WATCHED_FOLDER_STATUS_KEY);
      const parsed = stored ? JSON.parse(stored) : null;
      if (parsed && typeof parsed === 'object') {
        setWatchedFolderResults(parsed as Record<string, WatchedFolderScanStatus>);
      }
    } catch (e) {
      console.error('Failed to restore watched folder status:', e);
    }
  }, [isWatchedFoldersDialogOpen]);

  /**
   * Recursively scan {@link result.directory}, keep files matching one
   * of {@link result.extensions} that are at least
   * {@link result.minSizeKB} KB, and feed them through {@link importBooks}.
   *
   * Two cooperating signals carry "where should the imported books
   * end up" downstream:
   *   1. Each {@link SelectedFile}'s `basePath` — when present,
   *      {@link importBooks}' `processFile` derives a nested groupName
   *      relative to it (`<sub>` / `<sub>/<deeper>`).
   *   2. The `groupId` argument passed to {@link importBooks} —
   *      tri-state per the comment in `processFile`. An explicit
   *      string (including '') wins over basePath-derived grouping.
   *
   * The three structure modes use these signals as follows:
   *   - keep    → omit basePath? no, *include* basePath; pass
   *               groupId=undefined so basePath wins.
   *   - author  → same as keep (basePath is also how `processFile` finds this
   *               folder's rule); the rule then trims the group to
   *               `<folder>/<first non-date level>`.
   *   - flatten → omit basePath AND pass an explicit groupId equal to
   *               the user's currently-viewed group ('' = root). The
   *               omitted basePath alone wouldn't be enough on a
   *               re-import, since deduped books carry stale groupIds
   *               from prior sessions; the explicit groupId is what
   *               actually reseats them. Dropping basePath in flatten
   *               mode is therefore belt-and-suspenders.
   * `options.manageWatching === false` marks a call that did NOT come from the
   * import dialog (URL ingress / drag-drop replay). Those synthesize a folder
   * description from nothing, so letting them drive the watch state would stop
   * watching a folder — and, since the rule lives with the watch state, delete
   * its structure/formats/size — just because a path arrived from outside. They
   * also must not impose their synthetic `mirror` on the current batch's
   * grouping, which is why `folderRule` is withheld too.
   */
  const runFolderImport = async (
    result: ImportFromFolderResult,
    options: { manageWatching?: boolean } = {},
  ) => {
    const manageWatching = options.manageWatching !== false;
    if (!appService || !result.directory) return;
    // Last-chance sanity check. The dialog's own pickImportDirectory
    // already validates fresh picks, but `result.directory` can also
    // come from the persisted "last import folder" in localStorage —
    // which may have been a bad path (e.g. user picked "On My iPhone"
    // root last session, app remembered it, user just hits OK now).
    // Catch that here so they get the same clear guidance instead of
    // a fs_scope error from readDirectory below.
    if (!validatePickedDirectory(result.directory)) return;

    // The user can opt the chosen folder into "in place" via the
    // dialog toggle; the same effect happens automatically when the
    // folder is already a registered external library folder (the
    // ingest layer's `shouldImportInPlace` does a path-prefix match
    // against `settings.externalLibraryFolders`). Register here so the
    // bookkeeping survives across launches and so subsequent imports
    // from the same folder don't have to re-trigger the toggle.
    if (result.readInPlace) {
      await registerExternalLibraryFolder(result.directory);
    }
    // Opt this folder into (or out of) auto-import per the dialog's per-folder
    // checkbox. Watching is independent of "read in place": a watched folder
    // that is not registered as an external library folder has its books copied
    // into the library (see the copy notice in the dialog). The same pick also
    // records the structure mode, formats and minimum size, so later scans
    // reproduce exactly what this import just did.
    //
    // The dialog re-seeds its form from the picked folder (see
    // `resolveWatchedFolder`), so the value written here always describes the
    // folder it is written for — unticking the box means the user asked to stop
    // watching *this* folder, not that some other folder was last imported with
    // the box unticked.
    if (manageWatching) {
      // 规则里的格式/体积要在"用户确实改过"时才回写：老监控目录（规则表无条目）
      // 解析出来的是完整支持列表，而对话框只会整组勾选、没有 md 的位置，未改动
      // 也回写就等于把该目录的扫描范围悄悄收窄。见 shouldRecordWatchedFilters。
      const liveSettings = useSettingsStore.getState().settings;
      const resolvedRule = resolveWatchedFolderRule(result.directory, liveSettings);
      const recordFilters = shouldRecordWatchedFilters({
        hasStoredRule: !!findStoredWatchedFolderRule(result.directory, liveSettings),
        resolvedGroupIds: formatGroupIdsForExtensions(resolvedRule.extensions),
        resolvedMinSizeKB: resolvedRule.minSizeKB,
        selectionGroupIds: result.selectedGroupIds,
        selectionMinSizeKB: result.minSizeKB,
      });
      await setAutoImportFolder(
        result.directory,
        result.autoImport,
        result.folderMode,
        recordFilters
          ? {
              // 回写也要带上对话框表达不了的扩展名（md 没有对应格式组），
              // 否则一旦回写就把它们从该目录的扫描范围里删掉了。
              extensions: mergeRecordedExtensions({
                selectionExtensions: result.extensions,
                resolvedExtensions: resolvedRule.extensions,
                groupExtensions: ALL_FORMAT_GROUP_EXTENSIONS,
              }),
              minSizeKB: result.minSizeKB,
            }
          : undefined,
      );
    }

    // Re-grant scopes for the directory before scanning. This matters
    // when `result.directory` came from somewhere the dialog plugin
    // didn't authorise — typically the persisted "last import folder"
    // restored from localStorage when the user just hit OK without
    // re-picking. Without this, `RemoteFile` reads through the asset
    // protocol later in `importBook` would fail with
    // "asset protocol not configured to allow the path".
    await appService.allowPathsInScopes?.([result.directory], true);
    const exts = result.extensions.map((e) => e.toLowerCase());
    const minSizeBytes = Math.max(0, Math.floor(result.minSizeKB)) * 1024;
    let files;
    try {
      files = await appService.readDirectory(result.directory, 'None', exts);
    } catch (e) {
      // readDirectory can reject for a few related reasons:
      //   - iOS handed us a virtual / file-provider path that the OS
      //     sandbox refuses to enumerate (the validator above catches
      //     the common shapes, but not every file-provider variant);
      //   - the path is outside Tauri's `fs_scope` and scope
      //     extension didn't stick (e.g. an iCloud Drive entry whose
      //     security-scoped resource the system declined to grant);
      //   - the directory was deleted / permissions revoked between
      //     pick and scan.
      // Swallow the rejection (otherwise it bubbles up as an
      // unhandledRejection through Next.js) and surface a friendly
      // message that nudges the user to re-pick.
      const detail = e instanceof Error ? e.message : String(e);
      console.error('Folder import: readDirectory failed', detail);
      eventDispatcher.dispatch('toast', {
        type: 'error',
        timeout: 6000,
        message: _(
          "Couldn't read this folder. Please pick the folder again, or choose a different location.",
        ),
      });
      return;
    }
    // Re-filter by extension because the JS fallback of readDirectory ignores
    // the extensions argument (only the native Rust walk filters in-scan).
    const filtered = files.filter((file) => {
      const ext = file.path.split('.').pop()?.toLowerCase() || '';
      if (!exts.includes(ext)) return false;
      if (minSizeBytes > 0 && file.size < minSizeBytes) return false;
      return true;
    });
    const entries = filtered.map((file) => ({
      fullPath: joinScannedPath(result.directory, file.path),
      size: file.size,
    }));
    // Same mapping the auto-import scan uses, so a folder's later scans group
    // newly-found books exactly like this import does.
    const toImportFiles = toWatchedFolderImports(result.directory, entries, result.folderMode);
    if (toImportFiles.length === 0) {
      eventDispatcher.dispatch('toast', {
        type: 'info',
        message: _('No matching books found in the selected folder.'),
      });
      return;
    }
    // When flattening, route the books into whichever group the user
    // is currently viewing (empty string == library root). In the other two
    // modes we leave groupId undefined so importBooks derives the group from
    // each file's basePath plus this folder's rule.
    const targetGroupId =
      result.folderMode === 'flat' ? searchParams?.get('group') || '' : undefined;
    // `rememberSourcePath`: this folder may well be watched, and a watched
    // folder's later scans need its books recognizable by path. Copy-mode books
    // get their source recorded; in-place ones already store it on `filePath`.
    // `folderRule`: group by what the dialog promised even when the folder is
    // not watched (nothing was persisted in that case). A non-dialog call has
    // no such promise, so it groups by the folder's own rule instead.
    void importBooks(toImportFiles, targetGroupId, {
      rememberSourcePath: true,
      ...(manageWatching
        ? {
            folderRule: {
              mode: result.folderMode,
              extensions: result.extensions,
              minSizeKB: result.minSizeKB,
            },
          }
        : {}),
    });
  };

  const handleSetSelectMode = (selectMode: boolean) => {
    setIsSelectMode(selectMode);
    setIsSelectAll(false);
    setIsSelectNone(false);
  };

  const updateLibrarySearchUrl = (target: LibrarySearchTarget, config: LibrarySearchConfig) => {
    const params = new URLSearchParams(window.location.search);
    const query = pendingLibrarySearchQueryRef.current ?? librarySearchQuery;
    if (query) params.set('q', query);
    else params.delete('q');
    if (target === 'text') params.set('search', 'text');
    else params.delete('search');
    if (config.mode !== 'contains') params.set('mode', config.mode);
    else params.delete('mode');
    if (config.matchCase) params.set('matchCase', 'true');
    else params.delete('matchCase');
    if (config.matchDiacritics) params.set('matchDiacritics', 'true');
    else params.delete('matchDiacritics');
    if (config.mode === 'nearby-words' && config.nearbyWords !== DEFAULT_NEARBY_WORDS) {
      params.set('nearby', String(config.nearbyWords));
    } else {
      params.delete('nearby');
    }
    const value = params.toString();
    window.history.replaceState(null, '', `?${value}`);
    sessionStorage.setItem('lastLibraryParams', value);
  };

  const handleSearchTargetChange = (target: LibrarySearchTarget) => {
    librarySearchTargetRef.current = target;
    setLibrarySearchTarget(target);
    debouncedSearchUrlUpdate.cancel();
    updateLibrarySearchUrl(target, librarySearchConfigRef.current);
    if (target === 'text') handleSetSelectMode(false);
  };

  // The input itself stays instant; applying the query (URL, shelf filter,
  // content scans) debounces so typing does not re-filter the library or
  // restart searches on every keystroke.
  const updateLibrarySearchUrlRef = useRef<typeof updateLibrarySearchUrl>(null!);
  updateLibrarySearchUrlRef.current = updateLibrarySearchUrl;
  const debouncedSearchUrlUpdate = React.useMemo(
    () =>
      debounce(() => {
        updateLibrarySearchUrlRef.current(
          librarySearchTargetRef.current,
          librarySearchConfigRef.current,
        );
      }, 500),
    [],
  );
  useEffect(() => () => debouncedSearchUrlUpdate.cancel(), [debouncedSearchUrlUpdate]);

  // Immediate variant for history pills and other one-shot applications.
  const handleSearchQueryApply = (query: string) => {
    debouncedSearchUrlUpdate.cancel();
    const urlQuery = new URLSearchParams(window.location.search).get('q') ?? '';
    pendingLibrarySearchQueryRef.current = query === urlQuery ? null : query;
    setLibrarySearchQuery(query);
    updateLibrarySearchUrl(librarySearchTargetRef.current, librarySearchConfigRef.current);
  };

  const handleSearchQueryChange = (query: string) => {
    const urlQuery = new URLSearchParams(window.location.search).get('q') ?? '';
    pendingLibrarySearchQueryRef.current = query === urlQuery ? null : query;
    setLibrarySearchQuery(query);
    debouncedSearchUrlUpdate();
  };

  const handleSearchConfigChange = (config: LibrarySearchConfig) => {
    librarySearchConfigRef.current = config;
    React.startTransition(() => {
      setLibrarySearchConfig(config);
    });
    debouncedSearchUrlUpdate.cancel();
    updateLibrarySearchUrl(librarySearchTargetRef.current, config);
  };

  const handleSelectAll = () => {
    setIsSelectAll(true);
    setIsSelectNone(false);
  };

  const handleDeselectAll = () => {
    setIsSelectNone(true);
    setIsSelectAll(false);
  };

  const handleShowDetailsBook = (book: Book) => {
    setShowDetailsBook(book);
  };

  const handleNavigateToPath = (path: string | undefined) => {
    const group = path ? getGroupId(path) || '' : '';
    setIsSelectAll(false);
    setIsSelectNone(false);
    // A fresh explicit navigation starts a new branch — handleLibraryNavigation
    // clears the mouse side-button forward stack by default.
    handleLibraryNavigation(group);
  };

  const fromGroupName = currentVirtualGroup
    ? (searchParams?.get('from') && getGroupName(searchParams.get('from') ?? '')) || ''
    : '';

  // 白屏占位只在「open-with/open-last 导航确实在途」时出现；一旦 pending
  // 被消费（导航发生或失败），占位立即退出，避免误置标记把整页卡成空白。
  // （awaitingInitNavigation 本身在状态声明处算好，见上面的注释。）
  if (!appService || !insets || awaitingInitNavigation) {
    return <div className='full-height bg-base-200' />;
  }

  const showBookshelf = libraryLoaded || libraryBooks.length > 0;

  return (
    <div
      ref={pageRef}
      aria-label={_('Your Library')}
      className={clsx(
        'library-page text-base-content full-height flex select-none flex-col overflow-hidden',
        viewSettings?.isEink ? 'bg-base-100' : 'bg-base-200',
        appService?.hasRoundedWindow && isRoundedWindow && 'window-border rounded-window',
      )}
    >
      <div
        className='relative top-0 z-40 w-full'
        role='banner'
        tabIndex={-1}
        aria-label={_('Library Header')}
      >
        <LibraryHeader
          isSelectMode={isSelectMode}
          isSelectAll={isSelectAll}
          onPullLibrary={refreshLibrary}
          onImportBooksFromFiles={handleImportBooksFromFiles}
          onImportBooksFromDirectory={
            appService?.canReadExternalDir ? handleImportBooksFromDirectory : undefined
          }
          onManageWatchedFolders={appService?.canReadExternalDir ? openWatchedFolders : undefined}
          onToggleSelectMode={() => handleSetSelectMode(!isSelectMode)}
          onSelectAll={handleSelectAll}
          onDeselectAll={handleDeselectAll}
          searchQuery={librarySearchQuery}
          searchTarget={librarySearchTarget}
          searchConfig={librarySearchConfig}
          onSearchConfigChange={handleSearchConfigChange}
          onSearchQueryChange={handleSearchQueryChange}
          onSearchTargetChange={handleSearchTargetChange}
        />
        <progress
          aria-label={_('Library Search Progress')}
          aria-hidden={librarySearchProgress != null ? 'false' : 'true'}
          className={clsx(
            'progress progress-success absolute bottom-0 left-0 right-0 h-1 translate-y-[2px] transition-opacity duration-200 sm:translate-y-[4px]',
            librarySearchProgress != null ? 'opacity-100' : 'opacity-0',
          )}
          value={librarySearchProgress ?? 0}
          max={100}
        />
      </div>
      {loading && (
        <div className='fixed inset-0 z-50 flex items-center justify-center'>
          <div className='flex flex-col items-center gap-3'>
            <Spinner loading />
            {importProgress && (
              <>
                <progress
                  aria-label={_('Import Progress')}
                  className='progress progress-success h-1 w-48'
                  value={importProgress.done}
                  max={importProgress.total}
                />
                <div className='text-sm text-base-content/70'>
                  {importProgress.done} / {importProgress.total}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {librarySearchTarget === 'text' &&
        !librarySearchQuery.trim() &&
        librarySearchHistory.length > 0 && (
          <div className='relative my-1 flex shrink-0 items-center px-4 sm:px-6'>
            <div className='no-scrollbar not-eink:[mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%_-_12px),transparent)] flex flex-1 gap-1.5 overflow-x-auto'>
              {librarySearchHistory.map((term) => (
                <button
                  key={term}
                  type='button'
                  onClick={() => handleSearchQueryApply(term)}
                  className='bg-base-300/45 hover:bg-base-300/70 text-base-content/70 max-w-[60%] flex-shrink-0 whitespace-nowrap rounded-full px-3 py-0.5 text-xs'
                >
                  <p className='truncate'>{term}</p>
                </button>
              ))}
            </div>
            <button
              type='button'
              onClick={() => {
                clearLibrarySearchHistory();
                setLibrarySearchHistory([]);
              }}
              title={_('Clear search history')}
              aria-label={_('Clear search history')}
              className='text-base-content/50 hover:text-base-content/80 flex h-6 w-8 shrink-0 items-center justify-center'
            >
              <MdClose className='h-4 w-4' />
            </button>
          </div>
        )}
      {currentGroupPath && (
        <div
          className={`transition-all duration-300 ease-in-out ${
            currentGroupPath ? 'opacity-100' : 'max-h-0 opacity-0'
          }`}
        >
          <div className='flex flex-wrap items-center gap-y-1 px-4 text-base'>
            <button
              onClick={() => handleNavigateToPath(undefined)}
              className='hover:bg-base-300 text-base-content/85 rounded px-2 py-1'
              data-drop-target-group=''
            >
              {_('All')}
            </button>
            {getBreadcrumbs(currentGroupPath).map((crumb, index, array) => {
              const isLast = index === array.length - 1;
              return (
                <React.Fragment key={index}>
                  <MdChevronRight size={iconSize} className='text-neutral-content' />
                  {isLast ? (
                    <span
                      className='truncate rounded px-2 py-1'
                      data-drop-target-group={crumb.path}
                    >
                      {crumb.name}
                    </span>
                  ) : (
                    <button
                      onClick={() => handleNavigateToPath(crumb.path)}
                      className='hover:bg-base-300 text-base-content/85 truncate rounded px-2 py-1'
                      data-drop-target-group={crumb.path}
                    >
                      {crumb.name}
                    </button>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}
      {currentVirtualGroup && (
        <GroupHeader
          groupName={
            fromGroupName
              ? `${fromGroupName} / ${currentVirtualGroup.groupName}`
              : currentVirtualGroup.groupName
          }
        />
      )}
      {showBookshelf &&
        (libraryBooks.some((book) => !book.deletedAt) ? (
          <div aria-label={_('Your Bookshelf')} className='flex min-h-0 flex-grow flex-col'>
            <div
              ref={containerRef}
              className={clsx(
                'scroll-container drop-zone flex min-h-0 flex-grow flex-col',
                isDragging && 'drag-over',
              )}
              style={{
                paddingRight: `${insets.right}px`,
                paddingLeft: `${insets.left}px`,
              }}
            >
              <DropIndicator />
              <Bookshelf
                libraryBooks={libraryBooks}
                highlightedBookHashes={highlightedBookHashes}
                isSelectMode={isSelectMode}
                isSelectAll={isSelectAll}
                isSelectNone={isSelectNone}
                onScrollerRef={handleScrollerRef}
                handleImportBooks={setImportMenuAnchor}
                handleBookDelete={handleBookDelete('both')}
                handleBookPurge={handleBookDelete('purge')}
                handleSetSelectMode={handleSetSelectMode}
                handleShowDetailsBook={handleShowDetailsBook}
                handleLibraryNavigation={handleLibraryNavigation}
                onSearchContents={() => handleSearchTargetChange('text')}
                onSearchProgress={setLibrarySearchProgress}
                contentSearch={
                  librarySearchTarget === 'text'
                    ? { query: searchParams?.get('q') ?? '', config: librarySearchConfig }
                    : null
                }
                onSelectionManuallyAdjusted={() => {
                  setIsSelectAll(false);
                  setIsSelectNone(false);
                }}
              />
            </div>
          </div>
        ) : (
          <div
            className={clsx(
              'hero drop-zone h-screen items-center justify-center',
              isDragging && 'drag-over',
            )}
          >
            <DropIndicator />
            <LibraryEmptyState onImport={setImportMenuAnchor} />
          </div>
        ))}
      {importMenuAnchor && (
        <ImportMenuPopup
          anchor={importMenuAnchor}
          onClose={() => setImportMenuAnchor(null)}
          onImportBooksFromFiles={handleImportBooksFromFiles}
          onImportBooksFromDirectory={
            appService?.canReadExternalDir ? () => void handleImportBooksFromDirectory() : undefined
          }
          onManageWatchedFolders={
            appService?.canReadExternalDir
              ? () => {
                  setImportMenuAnchor(null);
                  openWatchedFolders();
                }
              : undefined
          }
        />
      )}
      <NowPlayingBar isSelectMode={isSelectMode} />
      {showDetailsBook && (
        <BookDetailModal
          isOpen={!!showDetailsBook}
          book={showDetailsBook}
          onClose={() => setShowDetailsBook(null)}
          handleBookMetadataUpdate={handleUpdateMetadata}
          onMetadataValueClick={handleMetadataValueClick}
        />
      )}
      <AboutWindow />
      <KeyboardShortcutsHelp />
      <MigrateDataWindow />
      <BackupWindow onPullLibrary={refreshLibrary} />
      <CacheManagerWindow />
      {isSettingsDialogOpen && <SettingsDialog bookKey={''} />}
      {failedImportsModal && (
        <FailedImportsDialog
          failedImports={failedImportsModal}
          onClose={() => setFailedImportsModal(null)}
        />
      )}
      {importFromFolderState && (
        <ImportFromFolderDialog
          initialDirectory={importFromFolderState.initialDirectory}
          initialFolderMode={importFromFolderState.initialFolderMode}
          initialSelectedGroupIds={importFromFolderState.initialSelectedGroupIds}
          initialMinSizeKB={importFromFolderState.initialMinSizeKB}
          initialReadInPlace={importFromFolderState.initialReadInPlace}
          initialAutoImport={importFromFolderState.initialAutoImport}
          isRegisteredExternalRoot={isRegisteredExternalRoot}
          watchedFolderCount={watchedFolderRows.length}
          resolveWatchedFolder={(directory) =>
            // Resolved (not raw) rule, and only for folders actually watched:
            // presence is what tells the dialog to tick the watch box. A folder
            // watched before per-folder rules existed has no stored entry but is
            // still watched, and must not be silently unwatched on confirm.
            isAutoImportFolder(directory)
              ? resolveWatchedFolderRule(directory, useSettingsStore.getState().settings)
              : undefined
          }
          onManageWatchedFolders={() => {
            setImportFromFolderState(null);
            openWatchedFolders();
          }}
          onPickDirectory={pickImportDirectory}
          onCancel={() => setImportFromFolderState(null)}
          onConfirm={(result) => {
            setImportFromFolderState(null);
            // Remember the folder + filters for next time. Done here
            // (rather than inside pickImportDirectory) so we only
            // persist values the user actually committed to, not
            // ones they cancelled out of.
            if (typeof window !== 'undefined') {
              if (result.directory) {
                window.localStorage.setItem(LAST_IMPORT_FOLDER_KEY, result.directory);
              }
              window.localStorage.setItem(LAST_IMPORT_FOLDER_MODE_KEY, result.folderMode);
              if (result.selectedGroupIds.length > 0) {
                window.localStorage.setItem(
                  LAST_IMPORT_FOLDER_FORMATS_KEY,
                  result.selectedGroupIds.join(','),
                );
              }
              window.localStorage.setItem(
                LAST_IMPORT_FOLDER_MIN_SIZE_KEY,
                String(result.minSizeKB),
              );
              window.localStorage.setItem(
                LAST_IMPORT_FOLDER_READ_IN_PLACE_KEY,
                result.readInPlace ? '1' : '0',
              );
            }
            void runFolderImport(result);
          }}
        />
      )}
      {isWatchedFoldersDialogOpen && (
        <WatchedFoldersDialog
          folders={watchedFolderRows}
          // `null` when idle; `'all'` while a refresh-all is running, otherwise
          // the path of the row being refreshed.
          refreshingPath={watchedFolderRefreshing}
          onAddFolder={addWatchedFolder}
          onRemoveFolder={(path) => void removeWatchedFolder(path)}
          onSetRule={(path, patch) => void updateWatchedFolderRule(path, patch)}
          onRefresh={(path) => void refreshWatchedFolders(path)}
          onClose={() => setWatchedFoldersDialogOpen(false)}
        />
      )}
      {versionConflicts && (
        <BookVersionConflictDialog
          // Remount on a new batch: `choices` is seeded at mount, so reusing the
          // instance would leave freshly added conflicts showing stale defaults.
          key={`${versionConflicts[0]?.incoming.hash ?? 'version-conflicts'}:${versionConflicts.length}`}
          conflicts={versionConflicts}
          comparisons={versionComparisons}
          onCancel={() => {
            // 「取消」＝都保留：这几条问过了，从队列里落定掉，再接着问队列里
            // 其余的（弹窗开着期间新攒进来的）。
            settleVersionConflicts(versionConflicts);
            openVersionConflicts(null);
            drainVersionConflicts();
          }}
          onConfirm={(choices) => {
            const pending = versionConflicts;
            settleVersionConflicts(pending);
            openVersionConflicts(null);
            void resolveVersionConflicts(pending, choices);
          }}
        />
      )}
      {guideItem && (
        <TxtChapterGuideDialog
          file={guideItem.file}
          filename={guideItem.filename}
          fallbackImported={guideItem.fallbackImported}
          onCancel={() => {
            setGuideItem(null);
            if (txtGuideQueueRef.current.length > 0) {
              setGuideItem(txtGuideQueueRef.current.shift()!);
            }
          }}
          onConfirm={(pattern) => {
            const current = guideItem;
            setGuideItem(null);
            void (async () => {
              if (!current) return;
              const toastMsg = (message: string, type: 'success' | 'error' = 'success') =>
                eventDispatcher.dispatch('toast', {
                  message,
                  timeout: type === 'success' ? 2000 : 5000,
                  type,
                });
              try {
                const app = await envConfig.getAppService();
                const settings = useSettingsStore.getState().settings;
                const result = await ingestFile(
                  {
                    file: current.file,
                    books: useLibraryStore.getState().library,
                    groupId: current.groupId,
                    groupName: current.groupName,
                    chapterPatterns: [pattern],
                  },
                  { appService: app, settings },
                );
                if (result) {
                  await updateBooks(envConfig, [result.book], { skipSave: true });
                  const finalLibrary = useLibraryStore.getState().library;
                  await app.saveLibraryBooks(finalLibrary);
                  if (result.txtFallbackFile) {
                    // 勾选生成的规则重切后仍一条标题都没匹配上：转换器再次
                    // 走段落兜底。不再次弹引导（避免循环），如实提示保留。
                    toastMsg(
                      `《${current.filename}》勾选的行未能识别出章节，已保留按段落分章的结果`,
                      'error',
                    );
                  } else {
                    toastMsg(
                      `《${current.filename}》已按勾选目录${current.fallbackImported ? '重新切分' : '导入'}`,
                    );
                  }
                } else {
                  toastMsg(`《${current.filename}》仍未识别出章节，已放弃`, 'error');
                }
              } catch (err) {
                toastMsg(
                  `《${current.filename}》导入失败：${err instanceof Error ? err.message : String(err)}`,
                  'error',
                );
              }
              if (txtGuideQueueRef.current.length > 0) {
                setGuideItem(txtGuideQueueRef.current.shift()!);
              }
            })();
          }}
        />
      )}
      <Toast />
    </div>
  );
};

const LibraryPage = () => {
  return (
    <Suspense fallback={<div className='full-height' />}>
      <LibraryPageWithSearchParams />
    </Suspense>
  );
};

export default LibraryPage;
