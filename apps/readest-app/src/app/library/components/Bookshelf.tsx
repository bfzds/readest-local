import clsx from 'clsx';
import { MdManageSearch } from 'react-icons/md';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PiPlus } from 'react-icons/pi';
import { useOverlayScrollbars } from 'overlayscrollbars-react';
import 'overlayscrollbars/overlayscrollbars.css';
import {
  Virtuoso,
  VirtuosoGrid,
  type Components,
  type GridComponents,
  type GridListProps,
  type ListProps,
} from 'react-virtuoso';
import { Book, BooksGroup, type LibrarySearchConfig, ReadingStatus } from '@/types/book';
import {
  LibraryCoverFitType,
  LibraryGroupByType,
  LibrarySortByType,
  LibraryViewModeType,
} from '@/types/settings';
import { useEnv } from '@/context/EnvContext';
import { saveSysSettings } from '@/helpers/settings';
import { useThemeStore } from '@/store/themeStore';
import { useAutoFocus } from '@/hooks/useAutoFocus';
import { useSettingsStore } from '@/store/settingsStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useResponsiveSize } from '@/hooks/useResponsiveSize';
import { navigateToLibrary, navigateToReader, showReaderWindow } from '@/utils/nav';
import {
  createBookFilter,
  createBookGroups,
  createBookSorter,
  createGroupSorter,
  createWithinGroupSorter,
  resolveCurrentGroupBy,
  ensureLibrarySortByType,
  ensureLibrarySecondarySortByType,
  expandBookshelfSelection,
  findGroupById,
  getBookSortValue,
  getGroupSortValue,
  compareSortValues,
  resolveEffectivePrimarySort,
  resolveEffectiveSecondarySort,
  resolveCurrentShelfBooks,
  selectRecentShelfBooks,
  withReadingStatus,
  withTimeRemainingLast,
  reassignToGroup,
  relabelPersistentGroups,
  resolveGroupDropKind,
  swapShelfUnits,
  assignEmptyGroupAnchors,
  rebaseLayerAfterGroupMerge,
  relabelAnchorMap,
} from '../utils/libraryUtils';
import { sameLibraryQuery } from '@/app/library/libraryQueryParams';
import { eventDispatcher } from '@/utils/event';
import { md5Fingerprint } from '@/utils/md5';
import { getLocalBookFilename } from '@/utils/book';
import { MIMETYPES, EXTS } from '@/libs/document';
import { makeSafeFilename } from '@/utils/misc';

import { useSpatialNavigation } from '../hooks/useSpatialNavigation';
import DeleteConfirmAlert from '@/components/DeleteConfirmAlert';
import Spinner from '@/components/Spinner';
import ModalPortal from '@/components/ModalPortal';
import BookCover from '@/components/BookCover';
import BookContextMenuPopup from './BookContextMenuPopup';
import BookshelfItem, { generateBookshelfItems } from './BookshelfItem';
import SelectModeActions from './SelectModeActions';
import GroupingModal from './GroupingModal';
import SetStatusAlert from './SetStatusAlert';
import RecentShelf, { RECENT_SHELF_BOOK_COUNT } from './RecentShelf';
import { useOpenBook } from '../hooks/useOpenBook';
import LibrarySearchResults from './LibrarySearchResults';

export interface ContentSearchRequest {
  query: string;
  config: LibrarySearchConfig;
}

interface BookshelfProps {
  libraryBooks: Book[];
  isSelectMode: boolean;
  isSelectAll: boolean;
  isSelectNone: boolean;
  onScrollerRef: (el: HTMLDivElement | null) => void;
  handleImportBooks: (anchor: HTMLElement) => void;
  handleBookDelete: (book: Book, syncBooks?: boolean) => Promise<boolean>;
  handleBookPurge: (book: Book, syncBooks?: boolean) => Promise<boolean>;
  handleSetSelectMode: (selectMode: boolean) => void;
  handleShowDetailsBook: (book: Book) => void;
  handleLibraryNavigation: (targetGroup: string) => void;
  contentSearch: ContentSearchRequest | null;
  onSearchContents: () => void;
  onSearchProgress?: (value: number | null) => void;
}

/**
 * Context passed to the custom Virtuoso `List` components so they can render
 * grid styles that depend on runtime settings without being re-created on
 * every Bookshelf render (which would break Virtuoso's component identity).
 */
type BookshelfListContext = {
  autoColumns: boolean;
  fixedColumns: number;
  /**
   * The recently-read shelf, rendered in the Virtuoso header so it scrolls with
   * the shelf content (not sticky). `null` when hidden. Passed through context
   * (rather than recreating the Header component) so Virtuoso keeps the Header
   * identity stable and does not reset its scroller on every Bookshelf render.
   */
  recentShelfHeader: React.ReactNode;
  /**
   * Height (px) of the trailing Footer spacer. Defaults to the baseline
   * breathing room, but grows to clear the fixed select-mode action bar so the
   * last book can scroll above it instead of hiding behind it (#5175).
   */
  footerHeight: number;
};

const DEFAULT_FOOTER_HEIGHT = 34;

const BookshelfFooter = ({ context }: { context?: BookshelfListContext }) => (
  <div style={{ height: context?.footerHeight ?? DEFAULT_FOOTER_HEIGHT }} />
);

const BOOKSHELF_GRID_CLASSES =
  'bookshelf-items transform-wrapper grid gap-x-4 px-4 sm:gap-x-0 sm:px-2 ' +
  'grid-cols-3 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-12';

const BOOKSHELF_LIST_CLASSES = 'bookshelf-items transform-wrapper flex flex-col';

const BookshelfGridList: GridComponents<BookshelfListContext>['List'] = React.forwardRef<
  HTMLDivElement,
  GridListProps & { context?: BookshelfListContext }
>(({ children, className, style, context, 'data-testid': testId }, ref) => (
  <div
    ref={ref}
    data-testid={testId}
    className={clsx(BOOKSHELF_GRID_CLASSES, className)}
    style={{
      ...style,
      gridTemplateColumns:
        context && !context.autoColumns
          ? `repeat(${context.fixedColumns}, minmax(0, 1fr))`
          : undefined,
    }}
  >
    {children}
  </div>
));
BookshelfGridList.displayName = 'BookshelfGridList';

const BookshelfLinearList: Components<unknown, BookshelfListContext>['List'] = React.forwardRef<
  HTMLDivElement,
  ListProps
>(({ children, style, 'data-testid': testId }, ref) => (
  <div ref={ref} data-testid={testId} className={BOOKSHELF_LIST_CLASSES} style={style}>
    {children}
  </div>
));
BookshelfLinearList.displayName = 'BookshelfLinearList';

const BookshelfHeader = ({ context }: { context?: BookshelfListContext }) => (
  <>{context?.recentShelfHeader ?? null}</>
);

const GRID_VIRTUOSO_COMPONENTS: GridComponents<BookshelfListContext> = {
  List: BookshelfGridList,
  Header: BookshelfHeader,
  Footer: BookshelfFooter,
};
const LIST_VIRTUOSO_COMPONENTS: Components<unknown, BookshelfListContext> = {
  List: BookshelfLinearList,
  Header: BookshelfHeader,
  Footer: BookshelfFooter,
};

const Bookshelf: React.FC<BookshelfProps> = ({
  libraryBooks,
  isSelectMode,
  isSelectAll,
  isSelectNone,
  onScrollerRef,
  handleImportBooks,
  handleBookDelete,
  handleBookPurge,
  handleSetSelectMode,
  handleShowDetailsBook,
  handleLibraryNavigation,
  contentSearch,
  onSearchContents,
  onSearchProgress,
}) => {
  const _ = useTranslation();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { envConfig, appService } = useEnv();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const { safeAreaInsets } = useThemeStore();

  const groupId = searchParams?.get('group') || '';
  const queryTerm = searchParams?.get('q')?.trim() || null;
  const viewMode = searchParams?.get('view') || settings.libraryViewMode;
  const storedSortBy = ensureLibrarySortByType(searchParams?.get('sort'), settings.librarySortBy);
  // Resolve the display dimension: URL override (virtual groups), else the
  // per-folder-group memory, else the global default.
  const folderGroupPath = groupId ? useLibraryStore.getState().getGroupName(groupId) : undefined;
  const groupBy = resolveCurrentGroupBy(searchParams, settings, folderGroupPath);
  const sortByAuto = settings.librarySortByAuto ?? true;
  const sortBy = resolveEffectivePrimarySort(storedSortBy, groupBy, sortByAuto);
  // Manual sort is an absolute order the user drags out — ascending/descending
  // is meaningless there. Rendering it descending just shows the dragged
  // sequence backwards (e.g. 2,1,3… looks like 6,5,4,3,1,2), so always use asc.
  const isManualSort = storedSortBy === LibrarySortByType.Manual;
  const sortOrder = isManualSort
    ? 'asc'
    : searchParams?.get('order') || (settings.librarySortAscending ? 'asc' : 'desc');
  const thenSortByRaw = ensureLibrarySecondarySortByType(
    searchParams?.get('thenSort'),
    settings.libraryThenSortBy ?? 'none',
  );
  const thenSortBy = resolveEffectiveSecondarySort(thenSortByRaw, groupBy);
  const thenSortOrder =
    searchParams?.get('thenOrder') ||
    ((settings.libraryThenSortAscending ?? true) ? 'asc' : 'desc');
  const showTimeRemaining =
    sortBy === LibrarySortByType.TimeRemaining || thenSortBy === LibrarySortByType.TimeRemaining;
  const coverFit = searchParams?.get('cover') || settings.libraryCoverFit;

  const [loading, setLoading] = useState(false);
  const [showSelectModeActions, setShowSelectModeActions] = useState(false);
  const [selectModeActionsHeight, setSelectModeActionsHeight] = useState(0);
  const [bookIdsToDelete, setBookIdsToDelete] = useState<string[]>([]);
  const [showDeleteAlert, setShowDeleteAlert] = useState(false);
  const [showStatusAlert, setShowStatusAlert] = useState(false);
  const [showGroupingModal, setShowGroupingModal] = useState(false);
  const [emptyGroupsToDelete, setEmptyGroupsToDelete] = useState<string[]>([]);

  const abortDeletionRef = useRef(false);
  const iconSize15 = useResponsiveSize(15);
  const autofocusRef = useAutoFocus<HTMLDivElement>();
  useSpatialNavigation(autofocusRef);

  // Ctrl+wheel zooms the book-card grid (80%-120%, step 5%). Delta from a
  // single gesture accumulates in a ref and is consumed at 100px per step, so
  // a fast momentum scroll steps once per unit instead of saving settings on
  // every wheel event; steps per event are capped so one huge inertial delta
  // cannot jump the zoom in a single frame. CSS `zoom` reflows the grid, so
  // Virtuoso keeps card sizing correct as the container scales.
  const libraryWheelAccumRef = useRef(0);
  useEffect(() => {
    const threshold = 100;
    const step = 0.05;
    const clampZoom = (v: number) => Math.min(1.2, Math.max(0.8, v));
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      const target = e.target as HTMLElement | null;
      // Wheel dispatched on the window itself (not an element) has no `closest`
      // — only guard when the event originated on a real HTMLElement.
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable]')
      )
        return;
      e.preventDefault();
      libraryWheelAccumRef.current += e.deltaY;
      let steps = 0;
      while (Math.abs(libraryWheelAccumRef.current) >= threshold && steps < 4) {
        const sign = Math.sign(libraryWheelAccumRef.current);
        libraryWheelAccumRef.current -= sign * threshold;
        // Wheel up (deltaY<0, sign -1) grows the cards; down shrinks them.
        const direction = sign < 0 ? 1 : -1;
        const current = useSettingsStore.getState().settings.libraryZoom ?? 1;
        void saveSysSettings(envConfig, 'libraryZoom', clampZoom(current + direction * step));
        steps++;
      }
    };
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => window.removeEventListener('wheel', onWheel, { capture: true });
  }, [envConfig]);

  const { setCurrentBookshelf, updateBooks } = useLibraryStore();
  const { setSelectedBooks, getSelectedBooks, toggleSelectedBook } = useLibraryStore();
  // The raw Set from the store: its identity only changes when the selection
  // does, so memos keyed on it stay stable across unrelated re-renders
  // (getSelectedBooks() allocates a fresh array per call).
  const { selectedBooks: selectedBookSet } = useLibraryStore();
  const {
    getGroupName,
    addPersistentGroup,
    getGroups,
    removePersistentGroups,
    getGroupId,
    getParentPath,
  } = useLibraryStore();
  // Subscribe to the group-name map so a newly added (empty) group recomputes
  // the shelf items; getGroups() is a stable function reference otherwise.
  const shelfGroups = useLibraryStore((s) => s.groups);

  const uiLanguage = localStorage?.getItem('i18nextLng') || '';

  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      // 依赖稳定接口：只读全局 window.location，不依赖每次 render 换新的
      // searchParams 对象（C-1 防回调身份漂移导致的反复规范化导航）。
      const params = new URLSearchParams(window.location.search);

      Object.entries(updates).forEach(([key, value]) => {
        if (value === null || value === '') {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      });

      if (params.get('sort') === LibrarySortByType.Updated) params.delete('sort');
      if (params.get('order') === 'desc') params.delete('order');
      if (params.get('thenOrder') === 'asc') params.delete('thenOrder');
      if (params.get('groupBy') === LibraryGroupByType.Group) params.delete('groupBy');
      if (params.get('cover') === 'crop') params.delete('cover');
      if (params.get('view') === 'grid') params.delete('view');

      const newParamString = params.toString();
      const currentParamString = window.location.search.slice(1);

      // 语义等价比较（顺序/编码无关）——参数顺序变化不再触发重复导航（C-2）。
      if (!sameLibraryQuery(newParamString, currentParamString)) {
        navigateToLibrary(router, newParamString);
      }
    },
    [router],
  );

  const filteredBooks = useMemo(() => {
    const bookFilter = createBookFilter(queryTerm);
    return queryTerm ? libraryBooks.filter((book) => bookFilter(book)) : libraryBooks;
  }, [libraryBooks, queryTerm]);

  // A folder group's path when the current `group` id is a folder group
  // (undefined for the top level or a virtual author/series/tag group).
  const manualGroupName = groupId ? getGroupName(groupId) : undefined;
  const currentShelfBooks = useMemo(
    () => resolveCurrentShelfBooks(libraryBooks, groupBy, groupId, manualGroupName),
    [libraryBooks, groupBy, groupId, manualGroupName],
  );
  const filteredShelfBooks = useMemo(() => {
    const bookFilter = createBookFilter(queryTerm);
    return queryTerm ? currentShelfBooks.filter(bookFilter) : currentShelfBooks;
  }, [currentShelfBooks, queryTerm]);

  const currentBookshelfItems = useMemo(() => {
    if (groupBy === LibraryGroupByType.Group) {
      // Use existing generateBookshelfItems for group mode
      const groupName = manualGroupName || '';
      if (groupId && !manualGroupName) {
        return [];
      }
      const items = generateBookshelfItems(filteredShelfBooks, groupName);
      // Groups are derived from books, so a freshly created (still empty) group
      // would not show up. Re-surface empty-yet-existing groups at their level.
      const seen = new Set(items.filter((i): i is BooksGroup => 'books' in i).map((g) => g.name));
      const prefix = groupName ? `${groupName}/` : '';
      const added: BooksGroup[] = [];
      for (const g of getGroups()) {
        const rel = g.name.startsWith(prefix)
          ? g.name.slice(prefix.length)
          : groupName
            ? ''
            : g.name;
        if (!rel) continue;
        const direct = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : rel;
        if (!direct) continue;
        const full = prefix + direct;
        if (!seen.has(full) && !added.some((x) => x.name === full)) {
          added.push({
            id: md5Fingerprint(full),
            name: full,
            displayName: direct,
            books: [],
            updatedAt: 0,
            // Manual sort anchors the group on the same ruler as books; fall
            // back to persisted-name order (empty groups leading) until the
            // user drags it into place.
            manualOrder:
              settings.libraryEmptyGroupOrder?.[full] ??
              -1 - useLibraryStore.getState().persistentGroupNames.indexOf(full),
          });
        }
      }
      return added.length ? [...added, ...items] : items;
    } else {
      if (groupId) {
        // Inside a folder group with a non-Group dimension, re-group that
        // folder's books by the chosen dimension (e.g. "by Author" inside a
        // folder). Virtual groups keep their flat member list.
        if (manualGroupName) return createBookGroups(filteredShelfBooks, groupBy);
        return filteredShelfBooks;
      }
      return createBookGroups(filteredShelfBooks, groupBy);
    }
  }, [
    filteredShelfBooks,
    groupBy,
    groupId,
    manualGroupName,
    getGroups,
    shelfGroups,
    settings.libraryEmptyGroupOrder,
  ]);

  useEffect(() => {
    // Keep an existing (even empty) folder group in the URL so an empty group
    // can be opened; only clear the group param when it no longer resolves.
    if (groupId && currentShelfBooks.length === 0 && !manualGroupName) {
      updateUrlParams({ group: null });
    } else {
      updateUrlParams({});
    }
  }, [searchParams, groupId, currentShelfBooks.length, manualGroupName, updateUrlParams]);

  const sortedBookshelfItems = useMemo(() => {
    const sortOrderMultiplier = sortOrder === 'asc' ? 1 : -1;

    // Separate into ungrouped books and groups
    const ungroupedBooks = currentBookshelfItems.filter((item): item is Book => 'format' in item);
    const groups = currentBookshelfItems.filter((item): item is BooksGroup => 'books' in item);

    // Sort books within each group
    // For series groups, series index is always ascending; sort direction applies to fallback only
    const sortAscending = sortOrder === 'asc';
    const thenSortAscending = thenSortOrder === 'asc';
    const withinGroupSorter = withTimeRemainingLast<Book>(
      sortBy,
      createWithinGroupSorter(
        groupBy,
        sortBy,
        uiLanguage,
        sortAscending,
        thenSortBy,
        thenSortAscending,
      ),
    );
    groups.forEach((group) => {
      group.books.sort(withinGroupSorter);
    });

    // Sort ungrouped books - use within-group sorter if we're inside a group
    // (for series, this ensures books are sorted by series index)
    // `bookSorter` already carries both sort directions, so it is never multiplied
    // by `sortOrderMultiplier` — that would flip the secondary key too (#5119).
    const bookSorter = createBookSorter(
      sortBy,
      uiLanguage,
      thenSortBy,
      sortAscending,
      thenSortAscending,
    );
    // Virtual-group members are already flat books sorted by
    // withinGroupSorter — return them directly so the merge sort below cannot
    // override the within-group order. Folder groups re-grouped by a non-Group
    // dimension (manualGroupName set) produce GROUP items instead, so they must
    // go through the merge sort; returning only `ungroupedBooks` would drop
    // every group and blank the shelf.
    if (
      groupId &&
      !manualGroupName &&
      groupBy !== LibraryGroupByType.Group &&
      groupBy !== LibraryGroupByType.None
    ) {
      ungroupedBooks.sort(withinGroupSorter);
      return ungroupedBooks;
    } else {
      ungroupedBooks.sort(withTimeRemainingLast<Book>(sortBy, bookSorter));
    }

    // Merge groups and ungrouped books, then sort them together
    const allItems: (Book | BooksGroup)[] = [...groups, ...ungroupedBooks];
    const groupSorter = createGroupSorter(sortBy, uiLanguage, groupBy);
    // P-1：组排序键一次性预计算，比较器查表而非每次比较对整组 Math 聚合。
    const groupSortValues = new Map<BooksGroup, ReturnType<typeof getGroupSortValue>>();
    for (const group of groups) {
      groupSortValues.set(group, getGroupSortValue(group, sortBy, groupBy));
    }

    allItems.sort(
      withTimeRemainingLast<Book | BooksGroup>(sortBy, (a, b) => {
        const isAGroup = 'books' in a;
        const isBGroup = 'books' in b;

        // If both are groups, use group sorter
        if (isAGroup && isBGroup) {
          return groupSorter(a, b) * sortOrderMultiplier;
        }

        // If both are books, use book sorter
        if (!isAGroup && !isBGroup) {
          return bookSorter(a, b);
        }

        // For series/author groups: compare sort values to interleave properly
        if (isAGroup && !isBGroup) {
          const groupValue = groupSortValues.get(a)!;
          const bookValue = getBookSortValue(b, sortBy);
          return compareSortValues(groupValue, bookValue, uiLanguage) * sortOrderMultiplier;
        } else if (!isAGroup && isBGroup) {
          const bookValue = getBookSortValue(a, sortBy);
          const groupValue = groupSortValues.get(b)!;
          return compareSortValues(bookValue, groupValue, uiLanguage) * sortOrderMultiplier;
        }
        return 0;
      }),
    );

    return allItems;
  }, [
    sortOrder,
    thenSortOrder,
    sortBy,
    thenSortBy,
    groupBy,
    groupId,
    manualGroupName,
    uiLanguage,
    currentBookshelfItems,
  ]);

  useEffect(() => {
    setCurrentBookshelf(currentShelfBooks);
  }, [currentShelfBooks, setCurrentBookshelf]);

  const toggleSelection = useCallback(
    (id: string) => {
      toggleSelectedBook(id);
    },
    [toggleSelectedBook],
  );

  const openSelectedBooks = async () => {
    handleSetSelectMode(false);
    if (appService?.hasWindow && settings.openBookInNewWindow) {
      await showReaderWindow(appService, getSelectedBooks());
    } else {
      setTimeout(() => setLoading(true), 200);
      navigateToReader(router, getSelectedBooks());
    }
  };

  const openBookDetails = () => {
    handleSetSelectMode(false);
    const selectedBooks = getSelectedBooks();
    const book = libraryBooks.find((book) => book.hash === selectedBooks[0]);
    if (book) {
      handleShowDetailsBook(book);
    }
  };

  // `bookIdsToDelete` always holds book hashes by the time we get here —
  // group ids are expanded into their constituent hashes at intake (see
  // `deleteSelectedBooks` and `handleDeleteBooksIntent`), so a top-level
  // folder is now resolved against the rendered group's `books` rollup,
  // which already includes nested sub-folder books.
  const getBooksToDelete = () => {
    const wanted = new Set(bookIdsToDelete);
    return filteredBooks.filter((book) => wanted.has(book.hash) && !book.deletedAt);
  };

  const confirmDelete = async (purgeData: boolean) => {
    const books = getBooksToDelete();
    // Toggling "purge all reading data" on the confirmation routes the whole
    // batch through the purge path, which also wipes each book's reading-data
    // sidecars (config/nav) instead of leaving the metadata folder behind.
    const deleteBook = purgeData ? handleBookPurge : handleBookDelete;
    const concurrency = 20;

    for (let i = 0; i < books.length; i += concurrency) {
      if (abortDeletionRef.current) {
        abortDeletionRef.current = false;
        break;
      }
      const batch = books.slice(i, i + concurrency);
      await Promise.all(batch.map((book) => deleteBook(book, false)));
    }
    // Selected empty groups carry no books, so the book batch above is empty
    // for them — remove them through the persistent-group delete path instead.
    for (const name of emptyGroupsToDelete) {
      await deleteGroupByName(name, false);
    }
    setEmptyGroupsToDelete([]);
    setSelectedBooks([]);
    setShowDeleteAlert(false);
    setShowSelectModeActions(true);
  };

  const deleteSelectedBooks = () => {
    const ids = getSelectedBooks();
    // Empty groups in the selection have no books to expand into; remember
    // them so the delete step can drop the persisted group itself.
    const emptyGroups = ids
      .map((id) => findGroupById(sortedBookshelfItems, id))
      .filter((g): g is BooksGroup => g !== undefined && g.books.length === 0);
    setEmptyGroupsToDelete(emptyGroups.map((g) => g.name));
    // Expand any group ids in the selection into the book hashes they
    // visually represent — `generateBookshelfItems` rolls nested-folder
    // books into the parent group, and we want every one of them queued
    // for deletion, not just the books whose own `groupId` happens to
    // match the top-level group's id.
    setBookIdsToDelete(expandBookshelfSelection(ids, sortedBookshelfItems));
    setShowSelectModeActions(false);
    setShowDeleteAlert(true);
  };

  const groupSelectedBooks = () => {
    setShowSelectModeActions(false);
    setShowGroupingModal(true);
  };

  const showStatusSelection = () => {
    setShowSelectModeActions(false);
    setShowStatusAlert(true);
  };

  const sendSelectedBook = async () => {
    // "Send" hands the actual book file (epub/pdf/...) to the OS share
    // sheet (UIActivityViewController on iOS, Intent.ACTION_SEND on
    // Android, NSSharingServicePicker on macOS) so the user can fire it
    // off to Mail / Messages / WeChat / AirDrop / etc. Backed by
    // tauri-plugin-sharekit via appService.saveFile({ share: true }).
    //
    // This exports the local file to the system share sheet; no
    // network is involved.
    // Linux has no system share sheet, and Windows is intentionally
    // disabled (issue #4343 — WebView2's native share UI blocks the main
    // thread waiting on cancel/complete callbacks that may never fire).
    // We hide the button entirely on those platforms (see sendEnabled
    // in the JSX) so users don't see an action that can't be honoured.

    const ids = getSelectedBooks();
    if (ids.length !== 1) return;
    const book = filteredBooks.find((b) => b.hash === ids[0]);
    if (!book || !appService) return;

    // Anchor the macOS share popover to the selected book's cover, not
    // to the Send button — the user just tapped/clicked the book, so
    // their visual focus is on the cover. We look the cover up via the
    // `data-book-hash` attribute that BookshelfItem stamps on its root
    // div. The rect must be captured *before* setShowSelectModeActions
    // tears the popup down (the bookshelf itself stays mounted, but we
    // still want to grab it up front to keep the share-call site
    // simple). preferredEdge='bottom' maps to NSMinYEdge, which in
    // WKWebView's flipped coord space is the rect's top edge, so the
    // popover renders above the cover (and only auto-flips below when
    // there's no room above). On iOS / Android the share sheet is modal
    // and ignores sharePosition, so this work is harmless there.
    const coverEl = document.querySelector<HTMLElement>(`[data-book-hash="${book.hash}"]`);
    const anchorRect = coverEl?.getBoundingClientRect();
    const sharePosition = anchorRect
      ? {
          x: anchorRect.left + anchorRect.width / 2,
          y: anchorRect.top + anchorRect.height / 2,
          preferredEdge: 'bottom' as const,
        }
      : undefined;

    setShowSelectModeActions(false);
    handleSetSelectMode(false);

    try {
      // Resolve the file the same way bookContent.resolveBookContentSource
      // does, but via the public AppService surface (the underlying `fs`
      // is protected): managed copy under Books/<hash>/ first, then the
      // device-local in-place import path. A book with no readable local
      // file cannot be shared.
      const managedPath = getLocalBookFilename(book);
      let path: string;
      let base: 'Books' | 'None';
      if (await appService.exists(managedPath, 'Books')) {
        path = managedPath;
        base = 'Books';
      } else if (book.filePath && (await appService.exists(book.filePath, 'None'))) {
        path = book.filePath;
        base = 'None';
      } else {
        eventDispatcher.dispatch('toast', {
          type: 'warning',
          message: _('Book file is not available locally'),
          timeout: 2500,
        });
        return;
      }
      const ext = EXTS[book.format] ?? 'bin';
      const mimeType = MIMETYPES[book.format]?.[0] ?? 'application/octet-stream';
      const baseName = makeSafeFilename(book.sourceTitle || book.title || book.hash);
      const shareFilename = `${baseName}.${ext}`;

      // Native (Tauri) only — the Share button is hidden on web because
      // browsers can't surface a real "share to <app>" sheet for an
      // arbitrary local file. Hand the already-on-disk file straight to
      // the OS share sheet via `options.filePath`. Without it,
      // saveFile() falls back to writing a temp copy under
      // BaseDirectory.Temp, which on Android resolves to
      // /data/local/tmp/ — the app sandbox has no write permission
      // there and the call fails with EACCES ("failed to open file at
      // path: /data/local/tmp/...epub Permission denied (os error
      // 13)"). Passing the absolute path also avoids re-buffering the
      // whole epub/pdf into memory just to have saveFile write it back
      // to disk.
      const absoluteFilePath = await appService.resolveFilePath(path, base);
      // `null` content: there's nothing to write — the file already lives at
      // `filePath`, which the native share path reads directly.
      await appService.saveFile(shareFilename, null, {
        share: true,
        mimeType,
        filePath: absoluteFilePath,
        sharePosition,
      });
    } catch (err) {
      console.error('Failed to send book file:', err);
      eventDispatcher.dispatch('toast', {
        type: 'error',
        message: _('Failed to send book'),
        timeout: 2500,
      });
    }
  };

  const updateBooksStatus = async (status: ReadingStatus | undefined) => {
    const selectedIds = getSelectedBooks();
    const booksToUpdate: Book[] = [];

    for (const id of selectedIds) {
      const book = filteredBooks.find((b) => b.hash === id);
      if (book) {
        booksToUpdate.push(withReadingStatus(book, status));
      }
    }

    if (booksToUpdate.length > 0) {
      await updateBooks(envConfig, booksToUpdate);
    }

    setSelectedBooks([]);
    setShowStatusAlert(false);
    setShowSelectModeActions(true);
  };

  const handleUpdateReadingStatus = useCallback(
    async (book: Book, status: ReadingStatus | undefined) => {
      const updatedBook = withReadingStatus(book, status);
      await updateBooks(envConfig, [updatedBook]);
    },
    [envConfig, updateBooks],
  );

  const handleDeleteBooksIntent = (event: CustomEvent) => {
    const { ids } = event.detail;
    setBookIdsToDelete(ids);
    setShowSelectModeActions(false);
    setShowDeleteAlert(true);
  };

  useEffect(() => {
    if (isSelectMode) {
      setShowSelectModeActions(true);
      if (isSelectAll) {
        setSelectedBooks(
          currentBookshelfItems.map((item) => ('hash' in item ? item.hash : item.id)),
        );
      } else if (isSelectNone) {
        setSelectedBooks([]);
      }
    } else {
      setSelectedBooks([]);
      setShowSelectModeActions(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSelectMode, isSelectAll, isSelectNone, currentBookshelfItems]);

  useEffect(() => {
    eventDispatcher.on('delete-books', handleDeleteBooksIntent);
    return () => {
      eventDispatcher.off('delete-books', handleDeleteBooksIntent);
    };
  }, []);

  // OverlayScrollbars + Virtuoso integration: Virtuoso manages its own
  // scroller; OverlayScrollbars wraps it for overlay scrollbar rendering.
  const osRootRef = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [initialize, osInstance] = useOverlayScrollbars({
    defer: true,
    options: { scrollbars: { autoHide: 'scroll' } },
    events: {
      initialized(instance) {
        const { viewport } = instance.elements();
        viewport.style.overflowX = 'var(--os-viewport-overflow-x)';
        viewport.style.overflowY = 'var(--os-viewport-overflow-y)';
      },
    },
  });

  useEffect(() => {
    const root = osRootRef.current;
    if (scroller && root) {
      initialize({ target: root, elements: { viewport: scroller } });
    }
    return () => osInstance()?.destroy();
  }, [scroller, initialize, osInstance]);

  // Expose the Virtuoso scroller to the parent for pull-to-refresh & scroll save.
  const handleScrollerRef = useCallback(
    (el: HTMLElement | Window | null) => {
      const div = el instanceof HTMLElement ? el : null;
      setScroller(div);
      onScrollerRef(div as HTMLDivElement | null);
    },
    [onScrollerRef],
  );

  const selectedBooks = getSelectedBooks();

  const isGridMode = viewMode === 'grid';
  const hasItems = sortedBookshelfItems.length > 0;
  // In grid mode the Import-Books "+" tile is rendered as an extra grid cell
  // after all books. We represent it to Virtuoso as an extra index past the
  // last book; list mode doesn't have an import tile.
  const gridTotalCount = hasItems ? sortedBookshelfItems.length + 1 : 0;

  // Recently-read shelf: shares the availability-aware open path with per-item
  // Recently-read shelf: shares the availability-aware local-file open path
  // with per-item taps. `openBook` is
  // memoized inside the hook, keeping `openRecentBook` -> `recentShelfHeader`
  // -> `listContext` identities stable (no full-grid re-render churn).
  const { openBook } = useOpenBook();
  const openRecentBook = useCallback((book: Book) => openBook(book), [openBook]);
  const openSearchResult = useCallback(
    (book: Book, cfi: string) => openBook(book, cfi, { highlightSearchResult: true }),
    [openBook],
  );

  // Flat recency slice of the whole library, independent of the main shelf's
  // sort/grouping. Built from `libraryBooks` (not the sorted/filtered items).
  const recentBooks = useMemo(
    () => selectRecentShelfBooks(libraryBooks, RECENT_SHELF_BOOK_COUNT),
    [libraryBooks],
  );

  // A top-level quick-resume strip: hidden while searching, inside a group, or
  // when nothing has been read yet. It stays up in select mode so shelf books
  // can be selected in place, just like the grid.
  const showRecentShelf =
    settings.libraryRecentShelfEnabled && !queryTerm && !groupId && recentBooks.length > 0;

  const recentShelfHeader = useMemo(
    () =>
      showRecentShelf ? (
        <RecentShelf
          books={recentBooks}
          coverFit={coverFit as LibraryCoverFitType}
          autoColumns={settings.libraryAutoColumns}
          fixedColumns={settings.libraryColumns}
          isSelectMode={isSelectMode}
          selectedBooks={selectedBookSet}
          onOpenBook={openRecentBook}
          toggleSelection={toggleSelection}
          handleSetSelectMode={handleSetSelectMode}
          showBookDetailsModal={handleShowDetailsBook}
          handleBookPurge={handleBookPurge}
          showTimeRemaining={showTimeRemaining}
        />
      ) : null,
    [
      showRecentShelf,
      recentBooks,
      coverFit,
      settings.libraryAutoColumns,
      settings.libraryColumns,
      isSelectMode,
      selectedBookSet,
      openRecentBook,
      toggleSelection,
      handleSetSelectMode,
      handleShowDetailsBook,
      showTimeRemaining,
    ],
  );

  // Reserve enough trailing space for the fixed select-mode action bar so the
  // last book scrolls clear of it (#5175). `selectModeActionsHeight` already
  // includes the bar's safe-area padding and is 0 whenever the bar is hidden,
  // so the baseline breathing room applies at all other times.
  const footerHeight =
    selectModeActionsHeight > 0
      ? selectModeActionsHeight + DEFAULT_FOOTER_HEIGHT
      : DEFAULT_FOOTER_HEIGHT;

  const listContext = useMemo<BookshelfListContext>(
    () => ({
      autoColumns: settings.libraryAutoColumns,
      fixedColumns: settings.libraryColumns,
      recentShelfHeader,
      showTimeRemaining,
      footerHeight,
    }),
    [
      settings.libraryAutoColumns,
      settings.libraryColumns,
      recentShelfHeader,
      showTimeRemaining,
      footerHeight,
    ],
  );

  const commitDeleteGroup = (g: BooksGroup) => void deleteGroupByName(g.name, false);

  // --- Dev-only: capture/restore the current shelf layout (button cluster in
  // the bottom-right corner). Compiled out of production builds. ---
  const LAYOUT_SNAPSHOT_KEY = 'readest-layout-snapshot';
  const [hasLayoutSnapshot, setHasLayoutSnapshot] = useState(false);
  useEffect(() => {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(LAYOUT_SNAPSHOT_KEY)) {
      setHasLayoutSnapshot(true);
    }
  }, []);
  const captureLayout = () => {
    const snap = {
      books: libraryBooks.map((b) => ({
        hash: b.hash,
        groupName: b.groupName,
        groupId: b.groupId,
        shelfIndex: b.shelfIndex,
      })),
      persistent: useLibraryStore.getState().persistentGroupNames ?? [],
      emptyOrder: useSettingsStore.getState().settings.libraryEmptyGroupOrder ?? {},
      customGroups: useSettingsStore.getState().settings.libraryCustomGroups ?? [],
    };
    localStorage?.setItem(LAYOUT_SNAPSHOT_KEY, JSON.stringify(snap));
    setHasLayoutSnapshot(true);
    eventDispatcher.dispatch('toast', { type: 'success', message: _('Layout saved') });
  };
  const restoreLayout = async () => {
    const raw =
      typeof localStorage !== 'undefined' ? localStorage.getItem(LAYOUT_SNAPSHOT_KEY) : null;
    if (!raw) return;
    try {
      const snap = JSON.parse(raw) as {
        books: { hash: string; groupName?: string; groupId?: string; shelfIndex?: number }[];
        persistent: string[];
        emptyOrder: Record<string, number>;
        customGroups: string[];
      };
      // Empty groups exist purely as persisted names — restore the list first
      // so refreshGroups re-floats them at their saved paths (not the moved one).
      useLibraryStore.setState({ persistentGroupNames: snap.persistent ?? [] });
      const byHash = new Map(snap.books.map((s) => [s.hash, s]));
      const restored = libraryBooks.map((b) => {
        const s = byHash.get(b.hash);
        return s
          ? { ...b, groupName: s.groupName, groupId: s.groupId, shelfIndex: s.shelfIndex }
          : b;
      });
      await updateBooks(envConfig, restored);
      useLibraryStore.getState().refreshGroups();
      const live = useSettingsStore.getState().settings;
      const nextSettings = {
        ...live,
        libraryEmptyGroupOrder: snap.emptyOrder,
        libraryCustomGroups: snap.customGroups,
      };
      setSettings(nextSettings);
      void saveSettings(envConfig, nextSettings);
      updateUrlParams({ sort: LibrarySortByType.Manual });
      eventDispatcher.dispatch('toast', { type: 'success', message: _('Layout restored') });
    } catch {
      eventDispatcher.dispatch('toast', { type: 'warning', message: _('No layout snapshot') });
    }
  };
  const isDev = process.env.NODE_ENV === 'development';

  const renderBookshelfItem = useCallback(
    (index: number) => {
      if (isGridMode && index === sortedBookshelfItems.length) {
        return (
          <div
            className={clsx('bookshelf-import-item mx-0 my-2 sm:mx-4 sm:my-4')}
            style={
              coverFit === 'fit'
                ? { display: 'flex', paddingBottom: `${iconSize15 + 24}px` }
                : undefined
            }
          >
            <button
              aria-label={_('Import Books')}
              aria-haspopup='menu'
              className={clsx(
                'bookitem-main bg-base-100 hover:bg-base-300/50',
                'flex items-center justify-center',
                'aspect-[28/41] w-full',
              )}
              onClick={(event) => handleImportBooks(event.currentTarget)}
            >
              <div className='flex items-center justify-center'>
                <PiPlus className='size-10' color='gray' />
              </div>
            </button>
          </div>
        );
      }
      const item = sortedBookshelfItems[index];
      if (!item) return null;
      const itemSelected = selectedBookSet.has('hash' in item ? item.hash : item.id);
      return (
        <BookshelfItem
          item={item}
          mode={viewMode as LibraryViewModeType}
          coverFit={coverFit as LibraryCoverFitType}
          isSelectMode={isSelectMode}
          itemSelected={itemSelected}
          toggleSelection={toggleSelection}
          handleGroupBooks={groupSelectedBooks}
          handleBookDelete={handleBookDelete}
          handleBookPurge={handleBookPurge}
          handleSetSelectMode={handleSetSelectMode}
          handleShowDetailsBook={handleShowDetailsBook}
          handleLibraryNavigation={handleLibraryNavigation}
          handleUpdateReadingStatus={handleUpdateReadingStatus}
          onDeleteGroupCommit={commitDeleteGroup}
          showTimeRemaining={showTimeRemaining}
        />
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      sortedBookshelfItems,
      selectedBookSet,
      isGridMode,
      viewMode,
      coverFit,
      isSelectMode,
      iconSize15,
      handleImportBooks,
      commitDeleteGroup,
      toggleSelection,
      handleBookDelete,
      handleSetSelectMode,
      handleShowDetailsBook,
      handleLibraryNavigation,
      handleUpdateReadingStatus,
      showTimeRemaining,
    ],
  );

  const computeItemKey = useCallback(
    (index: number) => {
      if (isGridMode && index === sortedBookshelfItems.length) {
        return 'library-import-tile';
      }
      const item = sortedBookshelfItems[index];
      if (!item) return `library-item-${index}`;
      return `library-item-${'hash' in item ? item.hash : item.id}`;
    },
    [sortedBookshelfItems, isGridMode],
  );

  // Shelf drag-and-drop (book/group cell → group cell) is implemented with
  // Pointer Events instead of HTML5 DnD: WebView2 stops dispatching dragover/
  // drop over this virtualized container, so a self-drawn drag ghost + hit test
  // on pointerup is the reliable route (and gives the drag feedback the user
  // wants). OS file drags stay untouched (page-level useDragDropImport).
  const dragSourceRef = useRef<
    { kind: 'book'; hash: string } | { kind: 'group'; groupName: string } | null
  >(null);
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const dragActiveRef = useRef(false);
  const dragGhostRef = useRef<HTMLDivElement>(null);
  const [dragGhostLabel, setDragGhostLabel] = useState('');
  const [dragGhostBook, setDragGhostBook] = useState<Book | null>(null);
  const [showDragGhost, setShowDragGhost] = useState(false);
  // Live intent for the drop-under-the-pointer, rendered reactively so it
  // follows the app language; tracked via ref to avoid a setState per move.
  const [dragAction, setDragAction] = useState<'swap' | 'merge' | 'move' | null>(null);
  const dragActionRef = useRef<'swap' | 'merge' | 'move' | null>(null);
  // P-3：pointermove 只记最新坐标，由 rAF 帧内统一做 ghost 定位/命中测试/
  // 高亮更新，避免逐事件强制 reflow；ghost 尺寸在拖拽期间缓存避免每帧
  // getBoundingClientRect（窗口 resize 时失效）。
  const dragRafRef = useRef<number | null>(null);
  const pendingDragPosRef = useRef<{ x: number; y: number } | null>(null);
  const dragGhostSizeRef = useRef<{ width: number; height: number } | null>(null);
  const prevHoverElRef = useRef<HTMLElement | null>(null);
  // D-13：拖拽 effect 经 ref 读当前翻译函数，避免把 `_` 放进 deps 后随其
  // 身份变化重绑全局监听。
  const dragLangRef = useRef(_);
  dragLangRef.current = _;
  // Right-click on empty shelf space → "Create New Group".
  const [blankContextMenu, setBlankContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');

  const endShelfDrag = useCallback(() => {
    if (dragRafRef.current != null) {
      cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
    }
    pendingDragPosRef.current = null;
    dragGhostSizeRef.current = null;
    prevHoverElRef.current = null;
    dragSourceRef.current = null;
    dragStartPosRef.current = null;
    dragActiveRef.current = false;
    setShowDragGhost(false);
    setDragGhostBook(null);
    dragActionRef.current = null;
    setDragAction(null);
    document
      .querySelectorAll('.drag-over-group,.drag-over-merge')
      .forEach((node) => node.classList.remove('drag-over-group', 'drag-over-merge'));
  }, []);

  const deleteGroupByName = async (targetGroup: string, purgeData: boolean) => {
    // Delete the group's own books through the same book-delete path.
    const inGroupBooks = libraryBooks.filter(
      (b) =>
        !b.deletedAt && (b.groupName === targetGroup || b.groupName?.startsWith(targetGroup + '/')),
    );
    for (const book of inGroupBooks) {
      await (purgeData ? handleBookPurge(book, false) : handleBookDelete(book, false));
    }
    // Drop this group (and any persisted child groups) from bookkeeping.
    const live = useSettingsStore.getState().settings;
    const custom = live.libraryCustomGroups ?? [];
    const removed = [targetGroup, ...custom.filter((c) => c.startsWith(targetGroup + '/'))];
    removePersistentGroups(removed);
    const nextCustom = custom.filter((g) => g !== targetGroup && !g.startsWith(targetGroup + '/'));
    if (nextCustom.length !== custom.length) {
      const nextSettings = { ...live, libraryCustomGroups: nextCustom };
      setSettings(nextSettings);
      void saveSettings(envConfig, nextSettings);
    }
    // If we are currently inside this (or a child) group, back up a level.
    if (manualGroupName === targetGroup || manualGroupName?.startsWith(targetGroup + '/')) {
      const parentPath = getParentPath?.(targetGroup);
      const parentId = parentPath ? (getGroupId?.(parentPath) ?? '') : '';
      handleLibraryNavigation(parentId);
    }
  };

  // Move an empty (book-less) group by relabeling its persistent paths; after a
  // book-backed group move, also relabels any leftover persisted names so stale
  // empty-group records don't resurrect old paths on the next restart. Returns
  // false for cycle/no-op moves.
  const syncPersistentGroupMove = useCallback(
    (sourceName: string, targetGroupName?: string): boolean => {
      const live = useSettingsStore.getState().settings;
      const custom = live.libraryCustomGroups ?? [];
      const persisted = useLibraryStore.getState().persistentGroupNames ?? [];
      const names = Array.from(new Set([...persisted, ...custom]));
      const { relabeled, changed } = relabelPersistentGroups(names, sourceName, targetGroupName);
      if (!changed) return false;
      if (relabeled.size > 0) {
        useLibraryStore.getState().removePersistentGroups(Array.from(relabeled.keys()));
        for (const next of relabeled.values()) {
          useLibraryStore.getState().addPersistentGroup(next);
        }
        let nextCustom = custom;
        if (custom.length > 0) {
          const inCustom = new Map(
            Array.from(relabeled).filter(([oldName]) => custom.includes(oldName)),
          );
          nextCustom = custom.map((g) => inCustom.get(g) ?? g);
        }
        // Move manual-sort anchors along with their renamed paths, otherwise a
        // stale orphan anchor can resurrect the old empty group on refresh.
        const nextOrder = relabelAnchorMap(live.libraryEmptyGroupOrder, relabeled);
        if (nextCustom !== custom || nextOrder) {
          const nextSettings = nextOrder
            ? { ...live, libraryCustomGroups: nextCustom, libraryEmptyGroupOrder: nextOrder }
            : { ...live, libraryCustomGroups: nextCustom };
          setSettings(nextSettings);
          void saveSettings(envConfig, nextSettings);
        }
      }
      return true;
    },
    [envConfig, setSettings, saveSettings],
  );
  const handleShelfContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    // Book/group cells handle their own context menu; only empty shelf space
    // (not on an item or an editable) offers "Create New Group".
    if (target.closest('[data-book-hash],[data-group-name],input,textarea,[contenteditable]')) {
      return;
    }
    e.preventDefault();
    setBlankContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleCreateGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    const parentName = groupId ? getGroupName(groupId) : undefined;
    const fullName = parentName ? `${parentName}/${name}` : name;
    // Refuse duplicate names at the same level (book-derived groups and
    // already-persisted empty groups both live in the group map).
    const alreadyExists = useLibraryStore
      .getState()
      .getGroups()
      .some((g) => g.name === fullName);
    if (alreadyExists) {
      eventDispatcher.dispatch('toast', {
        type: 'warning',
        message: dragLangRef.current('A group with this name already exists'),
      });
      return;
    }
    // Note: no refreshGroups() here — it rebuilds the group map from books and
    // would drop the still-empty group we just added.
    addPersistentGroup(fullName);
    // Persist the (possibly still-empty) group so it survives restarts; the
    // group map itself is otherwise rebuilt from books on init.
    const currentSettings = useSettingsStore.getState().settings;
    if (!currentSettings.libraryCustomGroups?.includes(fullName)) {
      const next = {
        ...currentSettings,
        libraryCustomGroups: [...(currentSettings.libraryCustomGroups ?? []), fullName],
      };
      setSettings(next);
      void saveSettings(envConfig, next);
    }
    eventDispatcher.dispatch('toast', {
      type: 'success',
      message: dragLangRef.current('Group created: {{name}}', { name: fullName }),
    });
    setNewGroupName('');
    setCreateGroupOpen(false);
  };

  useEffect(() => {
    const DRAG_THRESHOLD = 8;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const el = e.target as HTMLElement | null;
      const bookEl = el?.closest?.('[data-book-hash]');
      const groupEl = bookEl ? null : (el?.closest?.('[data-group-name]') ?? null);
      const source = bookEl
        ? { kind: 'book' as const, hash: bookEl.getAttribute('data-book-hash') ?? '' }
        : groupEl
          ? { kind: 'group' as const, groupName: groupEl.getAttribute('data-group-name') ?? '' }
          : null;
      if (!source) return;
      dragSourceRef.current = source;
      dragStartPosRef.current = { x: e.clientX, y: e.clientY };
      dragActiveRef.current = false;
    };

    type DropTarget = {
      el: HTMLElement;
      unit: 'book' | 'group' | 'level';
      kind: 'swap' | 'merge' | 'move';
      id: string;
    };
    // Resolve what the pointer is over as a drop target. Priority:
    //  group cell (top half = swap order, bottom half = merge into the group),
    //  breadcrumb level node (any view; '' = "All" → move to that level),
    //  book cell (only a sort target).
    const resolveHoverTarget = (x: number, y: number): DropTarget | null => {
      const under = document.elementFromPoint(x, y);
      const g = (under?.closest?.('[data-group-name]') as HTMLElement | null) ?? null;
      if (g) {
        const rect = g.getBoundingClientRect();
        const kind = resolveGroupDropKind(
          dragSourceRef.current?.kind ?? null,
          y,
          rect.top,
          rect.height,
        );
        return { el: g, unit: 'group', kind, id: g.getAttribute('data-group-name') ?? '' };
      }
      const bc = (under?.closest?.('[data-drop-target-group]') as HTMLElement | null) ?? null;
      if (bc) {
        return {
          el: bc,
          unit: 'level',
          kind: 'move',
          id: bc.getAttribute('data-drop-target-group') ?? '',
        };
      }
      const b = (under?.closest?.('[data-book-hash]') as HTMLElement | null) ?? null;
      if (b)
        return { el: b, unit: 'book', kind: 'swap', id: b.getAttribute('data-book-hash') ?? '' };
      return null;
    };

    const scheduleDragFrame = () => {
      if (dragRafRef.current != null) return;
      dragRafRef.current = requestAnimationFrame(() => {
        dragRafRef.current = null;
        const pending = pendingDragPosRef.current;
        pendingDragPosRef.current = null;
        if (!pending) return;
        if (!dragSourceRef.current) return;
        if (!dragActiveRef.current) return;

        // Ghost 跟随：transform 平移 + 缓存尺寸，避免逐帧 getBoundingClientRect。
        const ghost = dragGhostRef.current;
        if (ghost) {
          if (!dragGhostSizeRef.current) {
            const rect = ghost.getBoundingClientRect();
            dragGhostSizeRef.current = {
              width: rect.width || 140,
              height: rect.height || 32,
            };
          }
          const gw = dragGhostSizeRef.current.width;
          const gh = dragGhostSizeRef.current.height;
          const gap = 14;
          let left = pending.x + gap;
          if (left + gw > window.innerWidth - 8) left = pending.x - gw - gap;
          let top = pending.y + gap;
          if (top + gh > window.innerHeight - 8) top = pending.y - gh - gap;
          ghost.style.transform = `translate3d(${Math.max(8, left)}px, ${Math.max(8, top)}px, 0)`;
        }

        // 命中测试与高亮更新：只清上帧元素，不再全文档扫描高亮类。
        const hoverTarget = resolveHoverTarget(pending.x, pending.y);
        const prevHover = prevHoverElRef.current;
        if (prevHover && prevHover !== hoverTarget?.el) {
          prevHover.classList.remove('drag-over-group', 'drag-over-merge');
        }
        if (hoverTarget) {
          hoverTarget.el.classList.add(
            hoverTarget.kind === 'merge' ? 'drag-over-merge' : 'drag-over-group',
          );
        }
        prevHoverElRef.current = hoverTarget?.el ?? null;

        const action = hoverTarget?.kind ?? null;
        if (action !== dragActionRef.current) {
          dragActionRef.current = action;
          setDragAction(action);
        }
      });
    };

    const onPointerMove = (e: PointerEvent) => {
      const source = dragSourceRef.current;
      if (!source) return;
      if (!dragActiveRef.current) {
        const start = dragStartPosRef.current;
        if (!start) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
        dragActiveRef.current = true;
        e.preventDefault(); // hold off text selection / native link drag
        const draggedBook =
          source.kind === 'group'
            ? (libraryBooks.find(
                (b) =>
                  b.groupName === source.groupName ||
                  b.groupName?.startsWith(source.groupName + '/'),
              ) ?? null)
            : (libraryBooks.find((b) => b.hash === source.hash) ?? null);
        setDragGhostBook(draggedBook);
        setDragGhostLabel(source.kind === 'group' ? source.groupName : (draggedBook?.title ?? ''));
        setShowDragGhost(true);
      } else {
        e.preventDefault();
      }
      pendingDragPosRef.current = { x: e.clientX, y: e.clientY };
      scheduleDragFrame();
    };

    const onPointerUp = async (e: PointerEvent) => {
      const wasDragging = dragActiveRef.current;
      const source = dragSourceRef.current;
      const target = resolveHoverTarget(e.clientX, e.clientY);
      endShelfDrag();
      if (!wasDragging || !source || !target) return;

      const sourceHasBooks =
        source.kind === 'book' ||
        libraryBooks.some(
          (b) =>
            !b.deletedAt &&
            (b.groupName === source.groupName || b.groupName?.startsWith(source.groupName + '/')),
        );

      // Manual-sort key for a shelf unit — used to rebuild remaining order after
      // a merge regardless of the currently displayed view (a non-manual view
      // would otherwise feed its own order into the rebase).
      const manualKeyOf = (it: Book | BooksGroup): number =>
        'format' in it
          ? ((it as Book).shelfIndex ?? Number.MAX_SAFE_INTEGER)
          : (it as BooksGroup).books.length
            ? Math.min(
                ...(it as BooksGroup).books.map((b) => b.shelfIndex ?? Number.MAX_SAFE_INTEGER),
              )
            : ((it as BooksGroup).manualOrder ?? Number.MAX_SAFE_INTEGER);

      // --- 排序（互换）：书→书；组→组格子「上半」---
      const layerGroupNames = new Set(
        sortedBookshelfItems.filter((i): i is BooksGroup => 'books' in i).map((g) => g.name),
      );
      const isBookSwap =
        source.kind === 'book' && target.unit === 'book' && target.id !== source.hash;
      const isGroupSwap =
        source.kind === 'group' &&
        target.unit === 'group' &&
        target.kind === 'swap' &&
        target.id !== source.groupName &&
        layerGroupNames.has(target.id);
      if (isBookSwap || isGroupSwap) {
        const { updated, changed, ordered } = swapShelfUnits(
          sortedBookshelfItems,
          source.kind === 'book' ? source.hash : source.groupName,
          target.id,
        );
        if (changed) {
          // Anchor-before-index so both land in the same render batch (no
          // mid-swap flicker like 4,1,2,3 → 4,2,3,1).
          const anchors = assignEmptyGroupAnchors(
            ordered,
            new Map(updated.map((b) => [b.hash, b.shelfIndex ?? 0])),
          );
          if (anchors.size > 0) {
            const live = useSettingsStore.getState().settings;
            const nextOrder = {
              ...(live.libraryEmptyGroupOrder ?? {}),
              ...Object.fromEntries(anchors),
            };
            setSettings({ ...live, libraryEmptyGroupOrder: nextOrder });
          }
          const originals = new Map(libraryBooks.map((b) => [b.hash, b.shelfIndex] as const));
          const toWrite = updated.filter((b) => b.shelfIndex !== originals.get(b.hash));
          if (toWrite.length > 0) {
            await updateBooks(envConfig, toWrite);
          } else {
            void saveSettings(envConfig, useSettingsStore.getState().settings);
          }
          // Not in manual sort? Flip that view to manual so the freshly
          // dragged order is shown immediately (otherwise the current sort
          // key masks the shelfIndex change and the drag looks dead).
          if (sortBy !== LibrarySortByType.Manual) {
            updateUrlParams({ sort: LibrarySortByType.Manual });
          }
        }
        return;
      }

      // --- 归组/移动：书→组格（并入）；组→组格「下半」并入；书/组→面包屑层级 ---
      if (target.unit !== 'group' && target.unit !== 'level') return;
      const targetGroupName = target.unit === 'level' && target.id === '' ? undefined : target.id;
      if (source.kind === 'group' && !sourceHasBooks) {
        if (!syncPersistentGroupMove(source.groupName, targetGroupName)) {
          eventDispatcher.dispatch('toast', {
            type: 'warning',
            message: dragLangRef.current('Cannot move here: same or nested group'),
          });
          return;
        }
        // Empty groups carry no books to rebase; re-anchor the remaining layer
        // so the rest keep their pre-move relative order.
        const remaining = sortedBookshelfItems
          .filter((it) => ('books' in it ? (it as BooksGroup).name !== source.groupName : true))
          .sort((a, b) => manualKeyOf(a) - manualKeyOf(b));
        const anchors = assignEmptyGroupAnchors(remaining);
        if (anchors.size > 0) {
          const live = useSettingsStore.getState().settings;
          const nextOrder = {
            ...(live.libraryEmptyGroupOrder ?? {}),
            ...Object.fromEntries(anchors),
          };
          setSettings({ ...live, libraryEmptyGroupOrder: nextOrder });
          void saveSettings(envConfig, { ...live, libraryEmptyGroupOrder: nextOrder });
        }
        useLibraryStore.getState().refreshGroups();
        return;
      }
      const { updated, changed } = reassignToGroup(libraryBooks, source, targetGroupName);
      if (!changed) {
        eventDispatcher.dispatch('toast', {
          type: 'warning',
          message: dragLangRef.current('Cannot move here: same or nested group'),
        });
        return;
      }
      // Group merged into another group: the source books keep their old small
      // shelfIndex, which drags the target's min-sort key to the front. Rebase
      // to remaining-layer order (source books appended after the target's) so
      // the other groups keep their place, and re-anchor empty groups.
      let booksToWrite = updated;
      if (source.kind === 'group' && target.unit === 'group' && targetGroupName) {
        const remaining = sortedBookshelfItems
          .filter((it) => ('books' in it ? (it as BooksGroup).name !== source.groupName : true))
          .sort((a, b) => manualKeyOf(a) - manualKeyOf(b));
        const { books, anchors } = rebaseLayerAfterGroupMerge(
          remaining,
          updated,
          `${targetGroupName}/${source.groupName}`,
        );
        booksToWrite = books;
        if (anchors.size > 0) {
          const live = useSettingsStore.getState().settings;
          const nextOrder = {
            ...(live.libraryEmptyGroupOrder ?? {}),
            ...Object.fromEntries(anchors),
          };
          setSettings({ ...live, libraryEmptyGroupOrder: nextOrder });
          void saveSettings(envConfig, { ...live, libraryEmptyGroupOrder: nextOrder });
        }
      }
      await updateBooks(envConfig, booksToWrite);
      // A book-backed move can leave stale persisted names for empty records
      // that shadow the group under its old path; relabel them to match, then
      // hard-clean the source group's old path and rebuild the group map so no
      // ghost empty group survives at its former slot.
      if (source.kind === 'group') {
        syncPersistentGroupMove(source.groupName, targetGroupName);
        useLibraryStore.getState().removePersistentGroups([source.groupName]);
        useLibraryStore.getState().refreshGroups();
      }
      // After a merge, flip a non-manual view to manual so the rebased order is
      // visible immediately (otherwise the current sort key masks the change).
      if (
        source.kind === 'group' &&
        target.unit === 'group' &&
        sortBy !== LibrarySortByType.Manual
      ) {
        updateUrlParams({ sort: LibrarySortByType.Manual });
      }
    };

    const onPointerCancel = () => endShelfDrag();
    // 拖拽中改窗口尺寸会让缓存的 ghost 尺寸失效，重读一次。
    const onWindowResize = () => {
      dragGhostSizeRef.current = null;
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('resize', onWindowResize);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('resize', onWindowResize);
      // P-3 复核：统一走幂等 endShelfDrag —— 清 rAF/ghost/高亮/引用，
      // 拖拽中途 effect 重跑或组件卸载不残留状态。endShelfDrag(useCallback
      // 空依赖) 身份稳定，不引起重挂。
      endShelfDrag();
    };
  }, [
    endShelfDrag,
    groupBy,
    libraryBooks,
    envConfig,
    updateBooks,
    settings,
    sortedBookshelfItems,
    syncPersistentGroupMove,
    sortBy,
    updateUrlParams,
  ]);

  return (
    <div
      ref={autofocusRef}
      tabIndex={-1}
      role='main'
      aria-label={_('Bookshelf')}
      className='bookshelf flex min-h-0 flex-grow flex-col focus:outline-none'
      style={{ zoom: settings.libraryZoom ?? 1 }}
      onContextMenu={handleShelfContextMenu}
    >
      {!contentSearch?.query.trim() && queryTerm && (
        <div className='flex shrink-0 justify-center px-4 pb-2'>
          <button
            type='button'
            onClick={onSearchContents}
            className={clsx(
              'eink-bordered border-base-200 bg-base-100 hover:border-base-300 hover:bg-base-300/40',
              'text-base-content/80 hover:text-base-content not-eink:transition-colors',
              'flex h-9 items-center gap-2 rounded-lg border px-4 text-sm font-medium duration-150',
              'focus-visible:ring-base-content/15 focus-visible:outline-none focus-visible:ring-2',
            )}
          >
            <MdManageSearch aria-hidden='true' className='h-5 w-5' />
            {_('Search in book contents')}
          </button>
        </div>
      )}
      {contentSearch?.query.trim() && appService ? (
        <LibrarySearchResults
          appService={appService}
          books={currentShelfBooks}
          query={contentSearch.query.trim()}
          config={contentSearch.config}
          onSelectResult={openSearchResult}
          onProgress={onSearchProgress}
        />
      ) : (
        // The OverlayScrollbars root and the search results are siblings on
        // purpose: OS decorates this subtree with its own DOM, and letting
        // React swap children inside it caused NotFoundError crashes on
        // WebKit when a search was cleared.
        <div ref={osRootRef} data-overlayscrollbars-initialize='' className='min-h-0 flex-1'>
          {!contentSearch?.query.trim() && hasItems && isGridMode && (
            <VirtuosoGrid<unknown, BookshelfListContext>
              overscan={200}
              totalCount={gridTotalCount}
              components={GRID_VIRTUOSO_COMPONENTS}
              context={listContext}
              computeItemKey={computeItemKey}
              itemContent={renderBookshelfItem}
              scrollerRef={handleScrollerRef}
            />
          )}
          {!contentSearch?.query.trim() && hasItems && !isGridMode && (
            <Virtuoso<unknown, BookshelfListContext>
              overscan={200}
              totalCount={sortedBookshelfItems.length}
              components={LIST_VIRTUOSO_COMPONENTS}
              context={listContext}
              computeItemKey={computeItemKey}
              itemContent={renderBookshelfItem}
              scrollerRef={handleScrollerRef}
            />
          )}
        </div>
      )}
      {showDragGhost &&
        createPortal(
          <div ref={dragGhostRef} className='shelf-drag-ghost' role='presentation'>
            {dragGhostBook && (
              <div className='shelf-drag-ghost-cover'>
                <BookCover
                  book={dragGhostBook}
                  isPreview
                  imageClassName='h-full w-full rounded-[2px]'
                />
              </div>
            )}
            <div className='shelf-drag-ghost-title'>{dragGhostLabel}</div>
            <span className='shelf-drag-hint' aria-hidden='true'>
              {dragAction === 'swap'
                ? _('Swap order')
                : dragAction === 'merge'
                  ? _('Move into group')
                  : dragAction === 'move'
                    ? _('Move to here')
                    : ''}
            </span>
          </div>,
          document.body,
        )}
      {blankContextMenu && (
        <BookContextMenuPopup
          position={blankContextMenu}
          items={[
            {
              text: _('Create New Group'),
              action: () => {
                setBlankContextMenu(null);
                setNewGroupName('');
                setCreateGroupOpen(true);
              },
            },
          ]}
          onClose={() => setBlankContextMenu(null)}
        />
      )}
      {createGroupOpen && (
        <ModalPortal>
          <div
            className='fixed inset-0 z-50 flex items-center justify-center bg-black/30'
            onClick={() => setCreateGroupOpen(false)}
          >
            <div
              className='modal-box bg-base-100 w-[95%] max-w-[360px] rounded-2xl p-6'
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className='text-center text-lg font-bold'>{_('Create New Group')}</h2>
              <div className='mt-4 flex items-center gap-2'>
                <input
                  autoFocus
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateGroup();
                    if (e.key === 'Escape') setCreateGroupOpen(false);
                  }}
                  className='input input-ghost w-full border-0 px-2 text-base !outline-none'
                />
                <button
                  className='text-primary shrink-0 rounded-md px-2 py-1 hover:bg-base-300/50'
                  onClick={handleCreateGroup}
                >
                  {_('Save')}
                </button>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
      {isDev && (
        <div className='fixed bottom-4 right-4 z-50 flex items-center gap-2'>
          <button
            type='button'
            onClick={captureLayout}
            className='border-base-300 hover:border-base-content/40 bg-base-100/90 hover:bg-base-300/50 text-base-content/80 hover:text-base-content rounded-lg border px-3 py-1.5 text-xs font-medium shadow transition-colors'
          >
            {_('Save layout')}
          </button>
          <button
            type='button'
            onClick={() => void restoreLayout()}
            disabled={!hasLayoutSnapshot}
            className='border-base-300 hover:border-base-content/40 bg-base-100/90 hover:bg-base-300/50 text-base-content/80 hover:text-base-content rounded-lg border px-3 py-1.5 text-xs font-medium shadow transition-colors disabled:cursor-not-allowed disabled:opacity-50'
          >
            {_('Restore layout')}
          </button>
        </div>
      )}
      {loading && (
        <div className='fixed inset-0 z-50 flex items-center justify-center'>
          <Spinner loading />
        </div>
      )}
      {!showGroupingModal && isSelectMode && showSelectModeActions && (
        <SelectModeActions
          selectedBooks={selectedBooks}
          safeAreaBottom={safeAreaInsets?.bottom || 0}
          onHeightChange={setSelectModeActionsHeight}
          // Native send targets: iOS, Android, macOS — route through
          // tauri-plugin-sharekit (UIActivityViewController /
          // Intent.ACTION_SEND / NSSharingServicePicker). Linux has no
          // system share sheet, Windows WebView2 share UI is disabled
          // upstream (issue #4343 — deadlocks the main thread), and web
          // browsers don't expose a real "send file to <app>" sheet, so
          // the button is hidden on those platforms.
          sendEnabled={!!appService?.isMacOSApp}
          onOpen={openSelectedBooks}
          onGroup={groupSelectedBooks}
          onDetails={openBookDetails}
          onStatus={showStatusSelection}
          onSend={sendSelectedBook}
          onDelete={deleteSelectedBooks}
          onCancel={() => handleSetSelectMode(false)}
        />
      )}
      {showGroupingModal && selectedBooks.length > 0 && (
        <ModalPortal>
          <GroupingModal
            libraryBooks={libraryBooks}
            selectedBooks={selectedBooks}
            parentGroupName={getGroupName(groupId) || ''}
            onCancel={() => {
              setShowGroupingModal(false);
              setShowSelectModeActions(true);
            }}
            onConfirm={() => {
              setShowGroupingModal(false);
              handleSetSelectMode(false);
            }}
          />
        </ModalPortal>
      )}
      {showDeleteAlert && (
        <div
          className={clsx('delete-alert fixed bottom-0 left-0 right-0 z-50 flex justify-center')}
          style={{
            paddingBottom: `${(safeAreaInsets?.bottom || 0) + 16}px`,
          }}
        >
          <DeleteConfirmAlert
            title={_('Confirm Deletion')}
            message={_('Are you sure to delete {{count}} selected book(s)?', {
              count: getBooksToDelete().length,
            })}
            showPurgeToggle
            onCancel={() => {
              abortDeletionRef.current = true;
              setShowDeleteAlert(false);
              setShowSelectModeActions(true);
            }}
            onConfirm={confirmDelete}
          />
        </div>
      )}
      {showStatusAlert && (
        <SetStatusAlert
          selectedCount={getSelectedBooks().length}
          safeAreaBottom={safeAreaInsets?.bottom || 0}
          onCancel={() => {
            setShowStatusAlert(false);
            setShowSelectModeActions(true);
          }}
          onUpdateStatus={updateBooksStatus}
        />
      )}
    </div>
  );
};

export default Bookshelf;
