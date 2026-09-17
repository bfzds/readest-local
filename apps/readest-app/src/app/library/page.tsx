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
import { DEFAULT_NEARBY_WORDS } from '@/utils/searchConfig';
import { clearLibrarySearchHistory, loadLibrarySearchHistory } from './utils/searchHistory';
import { isStaleForwardTarget } from './utils/forwardStack';
import type { LibrarySearchTarget } from '@/types/book';
import { navigateToLibrary, navigateToReader } from '@/utils/nav';
import { getBookWithUpdatedMetadata, listFormater } from '@/utils/book';
import { startReaderWindowWatchdog } from '@/utils/readerWindowWatchdog';
import { getImportErrorMessage } from '@/services/errors';
import { ingestFile } from '@/services/ingestService';
import { replaceBookVersion, selectVersionReplacements } from '@/services/bookVersionService';
import { eventDispatcher } from '@/utils/event';
import { getFilename, getFolderImportGroupName, joinScannedPath } from '@/utils/path';
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

import { LibraryGroupByType } from '@/types/settings';
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
  ImportFromFolderResult,
} from './components/ImportFromFolderDialog';
import TxtChapterGuideDialog from './components/TxtChapterGuideDialog';
import BookVersionConflictDialog from './components/BookVersionConflictDialog';
import NowPlayingBar from './components/NowPlayingBar';
import { ttsSessionManager } from '@/services/tts';
import useShortcuts from '@/hooks/useShortcuts';
import { useCustomFonts } from '@/hooks/useCustomFonts';
import DropIndicator from '@/components/DropIndicator';
import SettingsDialog from '@/components/settings/SettingsDialog';

/** Skip tiny non-book artifacts during folder auto-scan (matches the manual import dialog default). */
const AUTO_IMPORT_MIN_SIZE_BYTES = 20 * 1024;
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
 * ('keep' vs 'flatten'). Restored as the default radio selection on
 * the next dialog open.
 */
const LAST_IMPORT_FOLDER_MODE_KEY = 'readest:lastImportFolderMode';
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
const MAX_PENDING_VERSION_CONFLICTS = 20;

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
  const { isSettingsDialogOpen, setSettingsDialogOpen } = useSettingsStore();

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
    initialFolderMode: 'keep' | 'flatten';
    initialSelectedGroupIds?: string[];
    initialMinSizeKB?: number;
    initialReadInPlace?: boolean;
    initialAutoImport?: boolean;
  } | null>(null);
  // TXT 目录识别失败的引导队列（一次处理一个文件）。
  const txtGuideQueueRef = useRef<TxtGuideItem[]>([]);
  const [guideItem, setGuideItem] = useState<TxtGuideItem | null>(null);
  // 导入疑似命中书库旧版本的队列（同样一次处理一批）。入库顺序就是展示
  // 顺序：批次结束后统一弹一次让用户逐条决定是否覆盖。
  const versionConflictQueueRef = useRef<BookVersionConflictInfo[]>([]);
  // 本批冲突数超过上限、有冲突没被询问过时置位（一次导入只提示一次）。
  const versionConflictOverflowRef = useRef(false);
  const [versionConflicts, setVersionConflicts] = useState<BookVersionConflictInfo[] | null>(null);
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
      if (externalRoots.length > 0 && appService.allowPathsInScopes) {
        await appService.allowPathsInScopes(externalRoots, true);
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
    options: { silent?: boolean } = {},
  ): Promise<{ failedPaths: string[] }> => {
    // Reject concurrent imports: two interleaved batch runs would overwrite
    // each other's progress and interleave store writes. The auto-import path
    // already had this guard; the manual paths get it here.
    if (loading) return { failedPaths: [] };
    setLoading(true);
    try {
      return await runImportBooks(files, groupId, options);
    } finally {
      // 保存/收尾任一步抛错（如 Tauri ACL 拒绝、磁盘失败）都不能把全屏
      // 加载遮罩留在最上层卡死书库——复位必须发生在 finally 里。
      setLoading(false);
      setImportProgress(null);
    }
  };

  const runImportBooks = async (
    files: SelectedFile[],
    groupId?: string,
    options: { silent?: boolean } = {},
  ): Promise<{ failedPaths: string[] }> => {
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
        if (resolvedGroupId === undefined && path && basePath) {
          resolvedGroupName = getFolderImportGroupName(path, basePath);
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
        const liveSettings = useSettingsStore.getState().settings;
        const result = await ingestFile(
          {
            file,
            books: library,
            lookupIndex,
            groupId: resolvedGroupId,
            groupName: resolvedGroupName,
            // 静默重扫（受监视文件夹）不弹确认框：那是窗口重新获得焦点时的
            // 后台动作，弹模态框会打断用户正在做的事——保持既有行为（不注册
            // 回调即无冲突识别）。手动导入/拖放/文件选择器才收集冲突。
            ...(options.silent
              ? {}
              : {
                  onVersionConflict: (info) => {
                    if (versionConflictQueueRef.current.length < MAX_PENDING_VERSION_CONFLICTS) {
                      versionConflictQueueRef.current.push(info);
                    } else if (!versionConflictOverflowRef.current) {
                      // The cap only exists to keep one batch's dialog readable;
                      // silently dropping the rest would hide real conflicts, so
                      // say it once per batch.
                      versionConflictOverflowRef.current = true;
                    }
                  },
                }),
          },
          { appService, settings: liveSettings, appBooksPrefix },
        );
        if (!result) return null;
        if (result.existed) {
          existingImports.push(result.book.title);
        } else {
          successfulImports.push(result.book.title);
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

    for (const batch of batches) {
      const importedBooks = (await Promise.all(batch.map(processFile))).filter((book) => !!book);
      // Update store state per batch (so the UI can render imported books
      // incrementally) but defer disk persistence until the entire batch is
      // done — saving library.json once per batch of 4 books was the dominant
      // cost for large imports.
      if (importedBooks.length > 0) {
        await updateBooks(envConfig, importedBooks, { skipSave: true });
      }
      processedFiles += batch.length;
      setImportProgress({ done: processedFiles, total: totalFiles });
    }

    // Persist the full library once after every file in the batch is done.
    let saveFailed = false;
    if (successfulImports.length > 0) {
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
          newCount: successfulImports.length,
          existingCount: existingImports.length,
          failedCount: failedImports.length,
          saveFailed,
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
    // 有疑似旧版本的冲突 → 整批一次弹窗。此时两条记录都已入库落盘，用户
    // 关掉窗口不做选择的结果就是"两本都留着"，不会有任何东西被删。
    if (versionConflictOverflowRef.current) {
      versionConflictOverflowRef.current = false;
      eventDispatcher.dispatch('toast', {
        message: `同名书籍较多，本次只询问了前 ${MAX_PENDING_VERSION_CONFLICTS} 本，其余已按独立书目保留`,
        timeout: 6000,
        type: 'info',
      });
    }
    if (versionConflictQueueRef.current.length > 0) {
      setVersionConflicts(versionConflictQueueRef.current.splice(0));
    }
    return { failedPaths };
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
    const { replacements, skipped } = selectVersionReplacements(conflicts, choices);
    if (replacements.length === 0) return;
    setLoading(true);
    setImportProgress({ done: 0, total: replacements.length });
    const app = appService ?? (await envConfig.getAppService());
    let done = 0;
    const failed: string[] = [];
    try {
      for (const conflict of replacements) {
        try {
          const { library } = useLibraryStore.getState();
          const result = await replaceBookVersion(app, {
            oldBook: conflict.existing,
            newBook: conflict.incoming,
            books: library,
          });
          setLibrary(result.library);
        } catch (error) {
          console.error('Failed to replace book version:', conflict.incoming.title, error);
          failed.push(conflict.incoming.title);
        }
        done += 1;
        setImportProgress({ done, total: replacements.length });
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
    if (failed.length > 0) {
      eventDispatcher.dispatch('toast', {
        message: `《${failed.join('》《')}》替换失败，旧版本已保留`,
        timeout: 6000,
        type: 'error',
      });
    }
    // Only report the ones the user actually asked to replace — the default
    // "keep" choices are not worth mentioning.
    const lostToSameOldBook = conflicts.filter(
      (conflict, index) =>
        choices[index] === 'replace' && skipped.includes(conflict) && replacements.length > 0,
    );
    if (lostToSameOldBook.length > 0) {
      eventDispatcher.dispatch('toast', {
        message: `《${lostToSameOldBook
          .map((conflict) => conflict.incoming.title)
          .join('》《')}》指向的旧版本已被另一本替换，这两本保留为独立书目`,
        timeout: 6000,
        type: 'info',
      });
    }
  };

  /**
   * Re-scan the given watched folders (the user's `autoImportFolders`) and
   * import any newly-added books. Reuses the same in-place import + dedup as
   * manual folder import, but stays quiet: unreadable folders are skipped (no
   * toast), and `importBooks` runs only when genuinely-new files exist (its
   * success toast then fires).
   */
  const autoImportFromWatchedFolders = async (folders: string[]) => {
    if (!appService || loading) return;
    const { library } = useLibraryStore.getState();
    const osPlatform = appService.osPlatform;
    // Known local source paths — live AND soft-deleted (files the user deleted
    // but whose in-place source is still on disk), plus paths that already failed
    // to import this session — so we neither resurrect a deleted book nor
    // re-parse/re-toast a bad file on every focus.
    const existingPaths = collectKnownSourcePaths(library, osPlatform);
    for (const key of autoImportFailedPathsRef.current) existingPaths.add(key);
    const newFiles: SelectedFile[] = [];
    for (const folder of folders) {
      try {
        if (!autoImportGrantedFoldersRef.current.has(folder)) {
          await appService.allowPathsInScopes?.([folder], true);
          autoImportGrantedFoldersRef.current.add(folder);
        }
        const items = await appService.readDirectory(folder, 'None', SUPPORTED_BOOK_EXTS);
        const entries = items.map((item) => ({
          fullPath: joinScannedPath(folder, item.path),
          size: item.size,
        }));
        const fresh = selectNewImportableFiles(entries, {
          extensions: SUPPORTED_BOOK_EXTS,
          minSizeBytes: AUTO_IMPORT_MIN_SIZE_BYTES,
          existingPaths,
          osPlatform,
        });
        // Reproduce the folder's own "Folder Structure" choice: unless it was
        // imported flat, each file carries the watched folder as `basePath` so
        // `importBooks` seats the book in the group its subfolder implies —
        // the same group the folder's initial import used (issue #5423).
        newFiles.push(
          ...toWatchedFolderImports(folder, fresh, isFlattenedAutoImportFolder(folder)),
        );
        for (const entry of fresh) {
          // Prevent the same file matching again via a later overlapping folder.
          const key = normalizeFilePathForIndex(entry.fullPath, osPlatform);
          if (key) existingPaths.add(key);
        }
      } catch (e) {
        // One unreadable/temporarily-missing folder must not abort the others
        // or nag the user (unlike the manual path, which nudges a re-pick).
        console.error('Auto-import: failed to scan folder', folder, e);
      }
    }
    if (newFiles.length > 0) {
      const { failedPaths } = await importBooks(newFiles, undefined, { silent: true });
      for (const p of failedPaths) {
        const key = normalizeFilePathForIndex(p, osPlatform);
        if (key) autoImportFailedPathsRef.current.add(key);
      }
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
      await runFolderImport({
        directory: dirPath,
        extensions: SUPPORTED_BOOK_EXTS.slice(),
        // The non-dialog path is invoked by URL ingress / drag-drop
        // replay, where the user never picked any filter — keep the
        // synthetic values minimal and non-restrictive.
        selectedGroupIds: [],
        minSizeKB: 0,
        flatten: false,
        // URL ingress / drag-drop don't go through the dialog and so
        // can't set this. Default to the legacy "copy" behaviour;
        // already-registered external roots will still be detected
        // by `runFolderImport` itself via the prefix check, so books
        // under a registered folder are imported in-place either way.
        readInPlace: false,
        // Non-dialog path never opts into auto-import.
        autoImport: false,
      });
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
    setImportFromFolderState({
      initialDirectory: storedDirectory,
      initialFolderMode: storedMode === 'flatten' ? 'flatten' : 'keep',
      initialSelectedGroupIds: parsedFormats,
      initialMinSizeKB:
        parsedMinSize !== undefined && Number.isFinite(parsedMinSize) && parsedMinSize >= 0
          ? parsedMinSize
          : undefined,
      initialReadInPlace: storedReadInPlace === '1',
      initialAutoImport: isAutoImportFolder(storedDirectory),
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
   * `true` when auto-imports from `directory` should go straight to the library
   * root because the user imported it with "Import all into library". Read from
   * the live store: the scan runs long after the dialog wrote the setting, and
   * the component closure can still hold the pre-write snapshot. A folder
   * watched before this list existed isn't in it and therefore keeps the
   * dialog's default, "Create groups from subfolders".
   */
  /**
   * The watched folders as the Import-from-Folder dialog's management sub-page
   * wants them. Derived from `settings` (not the store snapshot) so removing or
   * re-pointing a folder re-renders the list immediately.
   */
  const watchedFolders = (settings.autoImportFolders ?? []).map((path) => ({
    path,
    flatten: (settings.autoImportFlattenFolders ?? []).some(
      (r) => normalizeRoot(r) === normalizeRoot(path),
    ),
  }));

  const isFlattenedAutoImportFolder = (directory: string): boolean => {
    const target = normalizeRoot(directory);
    if (!target) return false;
    const roots = useSettingsStore.getState().settings.autoImportFlattenFolders ?? [];
    return roots.some((r) => normalizeRoot(r) === target);
  };

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
   * `flatten` records the same import's "Folder Structure" pick so later scans
   * can group newly-found books exactly like this import did — it is tracked in
   * a parallel list because only flattened folders need an entry. A no-op when
   * the folder is already in the desired state. Errors are swallowed — the
   * import itself still succeeds; we just won't watch (or stop watching) the
   * folder until the next successful settings write.
   */
  const setAutoImportFolder = async (
    directory: string,
    enabled: boolean,
    flatten: boolean,
  ): Promise<void> => {
    const target = normalizeRoot(directory);
    if (!target) return;
    const liveSettings = useSettingsStore.getState().settings;
    const existing = liveSettings.autoImportFolders ?? [];
    const existingFlatten = liveSettings.autoImportFlattenFolders ?? [];
    const present = existing.some((r) => normalizeRoot(r) === target);
    const flattenPresent = existingFlatten.some((r) => normalizeRoot(r) === target);
    const flattenWanted = enabled && flatten;
    if (enabled === present && flattenWanted === flattenPresent) return;
    // Append only when the folder isn't listed yet: re-adding an existing entry
    // would move it to the end and shuffle the Watched Folders list under the
    // user's finger every time they flip a row's structure.
    const without = (roots: string[]) => roots.filter((r) => normalizeRoot(r) !== target);
    const next = enabled ? (present ? existing : [...existing, directory]) : without(existing);
    const nextFlatten = flattenWanted
      ? flattenPresent
        ? existingFlatten
        : [...existingFlatten, directory]
      : without(existingFlatten);
    const nextSettings = {
      ...liveSettings,
      autoImportFolders: next,
      autoImportFlattenFolders: nextFlatten,
    };
    setSettings(nextSettings);
    try {
      await saveSettings(envConfig, nextSettings);
    } catch (e) {
      console.error('Failed to persist autoImportFolders update:', e);
    }
  };

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
   * The two flatten/keep modes use these signals as follows:
   *   - keep    → omit basePath? no, *include* basePath; pass
   *               groupId=undefined so basePath wins.
   *   - flatten → omit basePath AND pass an explicit groupId equal to
   *               the user's currently-viewed group ('' = root). The
   *               omitted basePath alone wouldn't be enough on a
   *               re-import, since deduped books carry stale groupIds
   *               from prior sessions; the explicit groupId is what
   *               actually reseats them. Dropping basePath in flatten
   *               mode is therefore belt-and-suspenders.
   */
  const runFolderImport = async (result: ImportFromFolderResult) => {
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
    // checkbox. `result.autoImport` already implies `readInPlace` (the dialog
    // gates it), so registration above has run; unchecking removes the folder
    // from the watched set while leaving it registered as read-in-place.
    await setAutoImportFolder(result.directory, result.autoImport, result.flatten);

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
    const toImportFiles = toWatchedFolderImports(result.directory, entries, result.flatten);
    if (toImportFiles.length === 0) {
      eventDispatcher.dispatch('toast', {
        type: 'info',
        message: _('No matching books found in the selected folder.'),
      });
      return;
    }
    // When flattening, route the books into whichever group the user
    // is currently viewing (empty string == library root). When
    // preserving structure we leave groupId undefined so importBooks
    // derives nested groupNames from each file's basePath.
    const targetGroupId = result.flatten ? searchParams?.get('group') || '' : undefined;
    importBooks(toImportFiles, targetGroupId);
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
  const awaitingInitNavigation =
    !!pendingNavigationBookIds && (checkOpenWithBooks || checkLastOpenBooks);
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
            appService?.canReadExternalDir ? handleImportBooksFromDirectory : undefined
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
          watchedFolders={watchedFolders}
          onUnwatchFolder={(path) => void setAutoImportFolder(path, false, false)}
          onSetWatchedFolderFlatten={(path, flatten) =>
            void setAutoImportFolder(path, true, flatten)
          }
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
              window.localStorage.setItem(
                LAST_IMPORT_FOLDER_MODE_KEY,
                result.flatten ? 'flatten' : 'keep',
              );
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
      {versionConflicts && (
        <BookVersionConflictDialog
          // Remount on a new batch: `choices` is seeded at mount, so reusing the
          // instance would leave freshly added conflicts showing stale defaults.
          key={versionConflicts[0]?.incoming.hash ?? 'version-conflicts'}
          conflicts={versionConflicts}
          onCancel={() => setVersionConflicts(null)}
          onConfirm={(choices) => {
            const pending = versionConflicts;
            setVersionConflicts(null);
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
