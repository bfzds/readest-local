import { Book, BooksGroup, ReadingStatus } from '@/types/book';
import {
  LibraryGroupByType,
  LibrarySecondarySortByType,
  LibrarySortByType,
  SystemSettings,
} from '@/types/settings';
import {
  formatAuthors,
  formatTitle,
  getContributorNames,
  isCurrentlyReadingBook,
} from '@/utils/book';
import { md5Fingerprint } from '@/utils/md5';
import { SIZE_PER_LOC, SIZE_PER_TIME_UNIT } from '@/services/constants';

/** Valid sort types for the library */
const VALID_SORT_TYPES: LibrarySortByType[] = Object.values(LibrarySortByType);

/** Valid group by types for the library */
const VALID_GROUP_BY_TYPES: LibraryGroupByType[] = Object.values(LibraryGroupByType);

/**
 * Safely cast a query parameter to LibrarySortByType with fallback.
 * Returns the value if valid, otherwise returns the fallback.
 */
export const ensureLibrarySortByType = (
  value: string | null | undefined,
  fallback: LibrarySortByType,
): LibrarySortByType => {
  if (value && VALID_SORT_TYPES.includes(value as LibrarySortByType)) {
    return value as LibrarySortByType;
  }
  return fallback;
};

/**
 * Safely cast a query parameter to LibrarySecondarySortByType with fallback.
 * Accepts any valid primary sort type plus the literal 'none'.
 */
export const ensureLibrarySecondarySortByType = (
  value: string | null | undefined,
  fallback: LibrarySecondarySortByType,
): LibrarySecondarySortByType => {
  if (value === 'none') return 'none';
  if (value && VALID_SORT_TYPES.includes(value as LibrarySortByType)) {
    return value as LibrarySortByType;
  }
  return fallback;
};

/**
 * Resolve the *effective* primary sort key, applying smart defaults derived
 * from the current `groupBy`. The stored `librarySortBy` is left unchanged;
 * this only substitutes a sensible implicit default when the user is still on
 * auto, so grouping by Series lands an alphabetical-by-series-name listing
 * without any extra clicks.
 *
 * - !isAuto                              -> use stored as-is
 * - groupBy=Series and isAuto            -> Series
 * - everything else                      -> stored
 */
export const resolveEffectivePrimarySort = (
  stored: LibrarySortByType,
  groupBy: LibraryGroupByType,
  isAuto: boolean,
): LibrarySortByType => {
  if (!isAuto) return stored;
  if (groupBy === LibraryGroupByType.Series) return LibrarySortByType.Series;
  return stored;
};

/**
 * Resolve the *effective* secondary sort key, applying smart defaults derived
 * from the current `groupBy`. The stored secondary stays whatever the user
 * picked; this only substitutes 'none' with a sensible implicit default so
 * users get useful behavior out of the box (e.g. drilling into an Author
 * group lands a series-ordered list without any extra clicks).
 *
 * - explicit secondary (any non-'none')  -> use as-is
 * - groupBy=Author and stored='none'     -> Series
 * - everything else                      -> 'none'
 *
 * groupBy=Series doesn't default to anything because `createWithinGroupSorter`
 * already orders by `seriesIndex` for series groups.
 */
export const resolveEffectiveSecondarySort = (
  secondary: LibrarySecondarySortByType,
  groupBy: LibraryGroupByType,
): LibrarySecondarySortByType => {
  if (secondary !== 'none') return secondary;
  if (groupBy === LibraryGroupByType.Author) return LibrarySortByType.Series;
  return 'none';
};

/**
 * Safely cast a query parameter to LibraryGroupByType with fallback.
 * Returns the value if valid, otherwise returns the fallback.
 */
export const ensureLibraryGroupByType = (
  value: string | null | undefined,
  fallback: LibraryGroupByType,
): LibraryGroupByType => {
  if (value && VALID_GROUP_BY_TYPES.includes(value as LibraryGroupByType)) {
    return value as LibraryGroupByType;
  }
  return fallback;
};

/**
 * Resolve the *effective* group-by for the current library view:
 *  - an explicit URL `groupBy` wins (used when navigating into a virtual
 *    author/series/tag/subject group);
 *  - otherwise a per-folder-group memory (keyed by the folder path; `''` is
 *    the top-level library) remembered from the user's last pick in that
 *    location, so changing it inside one folder never leaks into others;
 *  - otherwise the global {@link SystemSettings.libraryGroupBy} default.
 *
 * `folderGroupPath` comes from libraryStore.getGroupName — undefined when the
 * view is the top level or inside a virtual group (their ids are not in the
 * folder-groups map).
 */
export const resolveCurrentGroupBy = (
  searchParams: URLSearchParams | null,
  settings: SystemSettings,
  folderGroupPath?: string,
): LibraryGroupByType => {
  const urlGroupBy = searchParams?.get('groupBy');
  if (urlGroupBy) return ensureLibraryGroupByType(urlGroupBy, settings.libraryGroupBy);
  const key = folderGroupPath ?? '';
  return settings.libraryGroupByByGroup?.[key] ?? settings.libraryGroupBy;
};

/**
 * Find a group by ID from a list of bookshelf items.
 * Works for both manual groups and series/author groups.
 */
export const findGroupById = (
  items: (Book | BooksGroup)[],
  groupId: string,
): BooksGroup | undefined => {
  return items.find((item): item is BooksGroup => 'books' in item && item.id === groupId);
};

/**
 * Get the display name for a group, useful for breadcrumbs.
 */
export const getGroupDisplayName = (
  items: (Book | BooksGroup)[],
  groupId: string,
): string | undefined => {
  const group = findGroupById(items, groupId);
  return group?.displayName || group?.name;
};

/**
 * Expand a list of selection ids (book hashes or group ids from the rendered
 * bookshelf) into the unique book hashes those ids represent.
 *
 * Group ids resolve to every (non-soft-deleted) book in the group's visible
 * rollup — `generateBookshelfItems` already folds nested-folder books into
 * their top-level group, so the rendered `BooksGroup.books` is the source of
 * truth. Standalone book hashes (and any unknown ids) pass through unchanged,
 * letting callers like the bookshelf delete flow collect the right set up
 * front instead of re-deriving it later.
 */
export const expandBookshelfSelection = (ids: string[], items: (Book | BooksGroup)[]): string[] => {
  const hashes = new Set<string>();
  for (const id of ids) {
    const group = findGroupById(items, id);
    if (group) {
      for (const book of group.books) {
        if (!book.deletedAt) hashes.add(book.hash);
      }
    } else {
      hashes.add(id);
    }
  }
  return [...hashes];
};

/**
 * The books a bulk Download should actually fetch (#5244): the selection
 * expanded through {@link expandBookshelfSelection}, narrowed to the books that
 * live in the cloud but not on this device. The predicate matches the per-book
 * "Download Book" affordance — a feed book has no file to fetch (#5307), and a
 * book that was never uploaded or is already local has nothing to pull down.
 */

// Calibre custom column names and values, flattened for searching (#4811).
const getCalibreColumnsText = (item: Book) =>
  (item.metadata?.calibreColumns ?? [])
    .map(({ name, value }) => `${name} ${Array.isArray(value) ? value.join(' ') : value}`)
    .join(' ');

const normalizeValues = (values: string[]): string[] => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean)),
];

export const getBookSubjects = (book: Book): string[] => {
  return getContributorNames(book.metadata?.subject);
};

const getBookTags = (book: Book): string[] => normalizeValues(book.tags ?? []);

const getBookValuesText = (book: Book): string =>
  [...getBookTags(book), ...getBookSubjects(book)].join(' ');

export const createBookFilter = (queryTerm: string | null) => (item: Book) => {
  if (!queryTerm) return true;
  if (item.deletedAt) return false;
  let searchTerm: RegExp;
  try {
    searchTerm = new RegExp(queryTerm, 'i');
  } catch {
    const lowerQuery = queryTerm.toLowerCase();
    const title = formatTitle(item.title).toLowerCase();
    const authors = formatAuthors(item.author).toLowerCase();

    return (
      title.includes(lowerQuery) ||
      authors.includes(lowerQuery) ||
      item.format.toLowerCase().includes(lowerQuery) ||
      (item.groupName && item.groupName.toLowerCase().includes(lowerQuery)) ||
      (item.metadata?.description &&
        item.metadata.description.toLowerCase().includes(lowerQuery)) ||
      getBookValuesText(item).toLowerCase().includes(lowerQuery) ||
      getCalibreColumnsText(item).toLowerCase().includes(lowerQuery)
    );
  }
  const title = formatTitle(item.title);
  const authors = formatAuthors(item.author);
  return (
    searchTerm.test(title) ||
    searchTerm.test(authors) ||
    searchTerm.test(item.format) ||
    (item.groupName && searchTerm.test(item.groupName)) ||
    (item.metadata?.description && searchTerm.test(item.metadata?.description)) ||
    searchTerm.test(getBookValuesText(item)) ||
    searchTerm.test(getCalibreColumnsText(item))
  );
};

/**
 * Fraction of the book that has been read, in [0, 1]. `progress` is a 1-based
 * `[current, total]` page pair; books that have never been opened have no
 * progress and read 0 (they sort to the unread end).
 */
const getBookReadRatio = (book: Book): number => {
  const [current, total] = book.progress ?? [];
  if (!current || !total || total <= 0) return 0;
  return current / total;
};

export const getTimeRemainingMinutes = (
  book: Book,
  medianPageDurationSecs?: number,
): number | undefined => {
  const pagesLeft = book.progress ? book.progress[1] - book.progress[0] : undefined;
  if (!pagesLeft) return undefined;
  return convertPagesToTimeRemainingMinutes(pagesLeft, medianPageDurationSecs);
};

export const convertPagesToTimeRemainingMinutes = (
  pagesLeft: number,
  medianPageDurationSecs?: number,
): number => {
  // Prefer the reader's own pace; fall back to the coarse global estimate.
  const minutesPerPage = medianPageDurationSecs
    ? medianPageDurationSecs / 60
    : SIZE_PER_LOC / SIZE_PER_TIME_UNIT;
  return Math.max(1, Math.round(pagesLeft * minutesPerPage));
};

/**
 * Minutes a book still needs, or `undefined` when its tile shows no time at all.
 * Finished, on-hold and unread books render a status badge instead of a time (see
 * `ReadingProgress`), even when they still have pages left — so they have no time
 * to sort by. Sorting and the label must agree on this, hence the shared helper.
 */
export const getDisplayedTimeRemaining = (
  book: Book,
  medianPageDurationSecs?: number,
): number | undefined => {
  const { readingStatus } = book;
  if (readingStatus === 'finished' || readingStatus === 'abandoned' || readingStatus === 'unread') {
    return undefined;
  }
  return getTimeRemainingMinutes(book, medianPageDurationSecs);
};

/**
 * Remaining minutes for a shelf item, or `undefined` when its tile can show no
 * time at all — that includes every group, since a group tile renders no progress.
 */
const getShelfItemTimeRemaining = (item: Book | BooksGroup): number | undefined =>
  'books' in item ? undefined : getDisplayedTimeRemaining(item);

/**
 * Wrap a comparator that has *already* had the sort direction applied, so items
 * with no remaining time always land after the ones that have it — ascending and
 * descending alike. "No time" is a bucket, not a value: it must sit outside the
 * sort-order multiplier, otherwise descending would float those items to the top.
 */
export const withTimeRemainingLast =
  <T extends Book | BooksGroup>(sortBy: LibrarySortByType, compare: (a: T, b: T) => number) =>
  (a: T, b: T): number => {
    if (sortBy !== LibrarySortByType.TimeRemaining) return compare(a, b);
    const aTime = getShelfItemTimeRemaining(a);
    const bTime = getShelfItemTimeRemaining(b);
    if (aTime === undefined && bTime === undefined) return 0;
    if (aTime === undefined) return 1;
    if (bTime === undefined) return -1;
    return compare(a, b);
  };

const compareBookByKey = (a: Book, b: Book, sortBy: string, uiLanguage: string): number => {
  switch (sortBy) {
    case LibrarySortByType.Title: {
      const aTitle = formatTitle(a.title);
      const bTitle = formatTitle(b.title);
      return aTitle.localeCompare(bTitle, uiLanguage || navigator.language);
    }
    case LibrarySortByType.Author: {
      const aAuthors = formatAuthors(a.author, a?.primaryLanguage || 'en', true);
      const bAuthors = formatAuthors(b.author, b?.primaryLanguage || 'en', true);
      return aAuthors.localeCompare(bAuthors, uiLanguage || navigator.language);
    }
    case LibrarySortByType.Updated:
      return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
    case LibrarySortByType.Manual: {
      const aIndex = a.shelfIndex ?? Number.MAX_SAFE_INTEGER;
      const bIndex = b.shelfIndex ?? Number.MAX_SAFE_INTEGER;
      if (aIndex !== bIndex) return aIndex - bIndex;
      const aTitle = formatTitle(a.title);
      const bTitle = formatTitle(b.title);
      return aTitle.localeCompare(bTitle, uiLanguage || navigator.language);
    }
    case LibrarySortByType.Created:
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    case LibrarySortByType.Format:
      return a.format.localeCompare(b.format, uiLanguage || navigator.language);
    case LibrarySortByType.Progress:
      return getBookReadRatio(a) - getBookReadRatio(b);
    case LibrarySortByType.Series: {
      // Group by series name first so books of the same series stay consecutive,
      // then order within a series by index. Comparing index alone would interleave
      // series (all #1s, then all #2s) when this key is used as a secondary sort.
      const aSeries = a.metadata?.series || '';
      const bSeries = b.metadata?.series || '';
      const bySeries = aSeries.localeCompare(bSeries, uiLanguage || navigator.language);
      if (bySeries !== 0) return bySeries;
      return (a.metadata?.seriesIndex || 0) - (b.metadata?.seriesIndex || 0);
    }
    case LibrarySortByType.Published: {
      const aPublished = a.metadata?.published || '0001-01-01';
      const bPublished = b.metadata?.published || '0001-01-01';

      // Handle cases where published date might not exist
      if (!aPublished && !bPublished) return 0;
      if (!aPublished) return 1; // Books without published date go to the end
      if (!bPublished) return -1;

      // Try to parse dates - handle various date formats
      const aDate = new Date(aPublished).getTime();
      const bDate = new Date(bPublished).getTime();

      // If dates are invalid (NaN), fall back to string comparison
      if (isNaN(aDate) && isNaN(bDate)) {
        return aPublished.localeCompare(bPublished, uiLanguage || navigator.language);
      }
      if (isNaN(aDate)) return 1;
      if (isNaN(bDate)) return -1;

      return aDate - bDate;
    }
    case LibrarySortByType.TimeRemaining: {
      const aTime = getDisplayedTimeRemaining(a);
      const bTime = getDisplayedTimeRemaining(b);
      // Never subtract two Infinities here: NaN makes the comparator inconsistent
      // and Array.sort then scatters the no-time books through the shelf.
      if (aTime === undefined && bTime === undefined) return 0;
      if (aTime === undefined) return 1;
      if (bTime === undefined) return -1;
      return aTime - bTime;
    }
    default:
      return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
  }
};

/**
 * @param secondarySortBy - Optional tiebreaker key applied when the primary
 *   comparison returns 0. Pass `'none'` (or omit) to disable. A Series secondary
 *   orders by series name then index; ties on both fall through to the primary tie.
 * @param sortAscending - Direction of the primary key (default ascending).
 * @param secondaryAscending - Direction of the secondary key (default ascending).
 *   Independent of the primary direction (issue #5119), so callers must NOT apply
 *   their own direction multiplier on top of this comparator.
 */
export const createBookSorter =
  (
    sortBy: string,
    uiLanguage: string,
    secondarySortBy: LibrarySecondarySortByType = 'none',
    sortAscending: boolean = true,
    secondaryAscending: boolean = true,
  ) =>
  (a: Book, b: Book): number => {
    const primary = compareBookByKey(a, b, sortBy, uiLanguage);
    if (primary !== 0) return primary * (sortAscending ? 1 : -1);
    if (secondarySortBy === 'none') return 0;
    return compareBookByKey(a, b, secondarySortBy, uiLanguage) * (secondaryAscending ? 1 : -1);
  };

/**
 * Pick the books for the recently-read shelf: most-recently-read first, capped
 * at `count`. Only currently-reading books qualify (see `isCurrentlyReadingBook`):
 * finished, abandoned and freshly-imported books are left off. Recency uses
 * `updatedAt` (the library's "Updated" sort key) so the row matches the app's
 * existing sort convention. NB: `updatedAt` is last-modified (also bumped by
 * status/metadata edits and sync), not strictly last-read. Independent of the
 * main shelf's sort/grouping — always a flat, recency slice.
 */
export const selectRecentShelfBooks = (books: Book[], count: number): Book[] => {
  const byRecency = createBookSorter(LibrarySortByType.Updated, '');
  return books
    .filter(isCurrentlyReadingBook)
    .sort((a, b) => -byRecency(a, b))
    .slice(0, count);
};

/**
 * Build a `groupName -> max(book.updatedAt)` map for all groups touched by
 * the given books. Each book bumps both its direct group and every ancestor
 * group along its path (e.g. a book in "Literature/Fiction" also bumps
 * "Literature"), so parent groups don't sink just because their direct
 * members are stale.
 */
export const buildGroupNameUpdatedAt = (books: Book[]): Map<string, number> => {
  const map = new Map<string, number>();
  for (const book of books) {
    if (!book.groupName || !book.updatedAt) continue;
    let path: string | undefined = book.groupName;
    while (path) {
      const prev = map.get(path) ?? 0;
      if (book.updatedAt > prev) map.set(path, book.updatedAt);
      const slash = path.lastIndexOf('/');
      path = slash === -1 ? undefined : path.slice(0, slash);
    }
  }
  return map;
};

export const getBreadcrumbs = (currentPath: string) => {
  if (!currentPath) return [];
  const segments = currentPath.split('/');
  return segments.map((segment, index) => ({
    name: segment,
    path: segments.slice(0, index + 1).join('/'),
  }));
};

/**
 * Parse a combined author string into individual author names.
 * Handles common separators like ", ", " & ", " and ".
 */
export const parseAuthors = (authorString: string): string[] => {
  if (!authorString || !authorString.trim()) {
    return [];
  }

  // Split by common separators: comma, ampersand, "and"
  // Use regex to handle variations with different spacing
  const authors = authorString
    .split(/\s*(?:,|&|\band\b)\s*/i)
    .map((author) => author.trim())
    .filter((author) => author.length > 0);

  return authors;
};

/**
 * Create groups from books based on the groupBy setting.
 * Returns a mix of BooksGroup and ungrouped Book items.
 */
export const createBookGroups = (
  books: Book[],
  groupBy: LibraryGroupByType,
): (Book | BooksGroup)[] => {
  // Filter out deleted books
  const activeBooks = books.filter((book) => !book.deletedAt);

  if (groupBy === LibraryGroupByType.None) {
    return activeBooks;
  }

  if (groupBy === LibraryGroupByType.Series) {
    return createSeriesGroups(activeBooks);
  }

  if (groupBy === LibraryGroupByType.Author) {
    return createAuthorGroups(activeBooks);
  }

  if (groupBy === LibraryGroupByType.Tag) {
    return createValueGroups(activeBooks, 'tag', getBookTags);
  }

  if (groupBy === LibraryGroupByType.Subject) {
    return createValueGroups(activeBooks, 'subject', getBookSubjects);
  }

  // 'group' mode is handled separately by generateBookshelfItems
  return activeBooks;
};

/**
 * Group books by series metadata.
 * Books without series appear as individual items.
 */
const createSeriesGroups = (books: Book[]): (Book | BooksGroup)[] => {
  const seriesMap = new Map<string, Book[]>();
  const ungroupedBooks: Book[] = [];

  for (const book of books) {
    const seriesName = book.metadata?.series?.trim();

    if (seriesName) {
      const existing = seriesMap.get(seriesName);
      if (existing) {
        existing.push(book);
      } else {
        seriesMap.set(seriesName, [book]);
      }
    } else {
      ungroupedBooks.push(book);
    }
  }

  const groups: BooksGroup[] = Array.from(seriesMap.entries()).map(([seriesName, seriesBooks]) => ({
    id: md5Fingerprint(`series:${seriesName}`),
    name: seriesName,
    displayName: seriesName,
    books: seriesBooks,
    updatedAt: Math.max(...seriesBooks.map((b) => b.updatedAt)),
  }));

  return [...groups, ...ungroupedBooks];
};

/**
 * Group books by author.
 * Books with multiple authors appear in ALL matching author groups.
 * Books without author appear as individual items.
 */
const createAuthorGroups = (books: Book[]): (Book | BooksGroup)[] => {
  const authorMap = new Map<string, Book[]>();
  const ungroupedBooks: Book[] = [];

  for (const book of books) {
    const authorString = book.author?.trim();

    if (!authorString) {
      ungroupedBooks.push(book);
      continue;
    }

    const authors = parseAuthors(authorString);

    if (authors.length === 0) {
      ungroupedBooks.push(book);
      continue;
    }

    // Add book to each author's group
    for (const author of authors) {
      const existing = authorMap.get(author);
      if (existing) {
        existing.push(book);
      } else {
        authorMap.set(author, [book]);
      }
    }
  }

  const groups: BooksGroup[] = Array.from(authorMap.entries()).map(([authorName, authorBooks]) => ({
    id: md5Fingerprint(`author:${authorName}`),
    name: authorName,
    displayName: authorName,
    books: authorBooks,
    updatedAt: Math.max(...authorBooks.map((b) => b.updatedAt)),
  }));

  return [...groups, ...ungroupedBooks];
};

const createValueGroups = (
  books: Book[],
  namespace: 'tag' | 'subject',
  getValues: (book: Book) => string[],
): (Book | BooksGroup)[] => {
  const valueMap = new Map<string, Book[]>();
  const ungroupedBooks: Book[] = [];
  for (const book of books) {
    const values = getValues(book);
    if (!values.length) {
      ungroupedBooks.push(book);
      continue;
    }
    for (const value of values) {
      const existing = valueMap.get(value);
      if (existing) existing.push(book);
      else valueMap.set(value, [book]);
    }
  }

  const groups = Array.from(
    valueMap,
    ([name, groupBooks]): BooksGroup => ({
      id: md5Fingerprint(`${namespace}:${name}`),
      name,
      displayName: name,
      books: groupBooks,
      updatedAt: Math.max(...groupBooks.map(({ updatedAt }) => updatedAt)),
    }),
  );
  return [...groups, ...ungroupedBooks];
};

export const resolveCurrentShelfBooks = (
  books: Book[],
  groupBy: LibraryGroupByType,
  groupId = '',
  manualGroupName?: string,
): Book[] => {
  const activeBooks = books.filter((book) => !book.deletedAt);
  if (!groupId) return activeBooks;
  // Inside a folder group (manualGroupName is its path): scope to that group
  // and its descendants regardless of the display dimension, so e.g. switching
  // to "by Author" inside a folder re-groups only that folder's books instead
  // of resolving against the whole library. This also covers the "Books"
  // (flat) view, which must stay scoped to the group and its descendants.
  if (manualGroupName) {
    const descendantPrefix = `${manualGroupName}/`;
    return activeBooks.filter(
      ({ groupName }) => groupName === manualGroupName || groupName?.startsWith(descendantPrefix),
    );
  }
  // Inside a virtual group: resolve its members by that grouping dimension.
  return findGroupById(createBookGroups(activeBooks, groupBy), groupId)?.books ?? [];
};

/**
 * Create a sorter for books within a group.
 * For series groups: sort by seriesIndex first (always ascending), then by global sort for items without index.
 * For other groupings: when a secondary key is supplied, sort by secondary key first (in its own
 *   direction), with the primary global sort as tiebreaker. Without secondary, follow global sort setting.
 * @param sortAscending - When true (default), sort direction is ascending. Series index is always
 *   ascending regardless of this flag; the flag affects the fallback / primary tiebreaker only.
 * @param secondarySortBy - When non-'none', acts as the *primary* within-group ordering for
 *   non-series groupings (matches the user's mental model: "group by author, then sort by series"
 *   should land series order inside each author).
 * @param secondaryAscending - Direction of the secondary key, independent of `sortAscending`
 *   (issue #5119).
 */
export const createWithinGroupSorter =
  (
    groupBy: LibraryGroupByType,
    sortBy: LibrarySortByType,
    uiLanguage: string,
    sortAscending: boolean = true,
    secondarySortBy: LibrarySecondarySortByType = 'none',
    secondaryAscending: boolean = true,
  ) =>
  (a: Book, b: Book): number => {
    const sortDirection = sortAscending ? 1 : -1;

    if (groupBy === LibraryGroupByType.Series) {
      const aIndex = a.metadata?.seriesIndex;
      const bIndex = b.metadata?.seriesIndex;

      // Both have series index - always sort ascending by index
      if (aIndex != null && bIndex != null) {
        return aIndex - bIndex;
      }

      // Only one has series index - the one with index comes first
      if (aIndex != null) return -1;
      if (bIndex != null) return 1;

      // Neither has series index - fall back to global sort with direction
      return createBookSorter(sortBy, uiLanguage)(a, b) * sortDirection;
    }

    // For author and other non-series groupings: when a secondary key is provided,
    // use it as the within-group primary order with the global key as tiebreaker.
    if (secondarySortBy !== 'none') {
      const bySecondary = compareBookByKey(a, b, secondarySortBy, uiLanguage);
      if (bySecondary !== 0) return bySecondary * (secondaryAscending ? 1 : -1);
      return createBookSorter(sortBy, uiLanguage)(a, b) * sortDirection;
    }

    return createBookSorter(sortBy, uiLanguage)(a, b) * sortDirection;
  };

/**
 * Get the sort value from a book for comparison with groups.
 */
export const getBookSortValue = (book: Book, sortBy: LibrarySortByType): number | string => {
  switch (sortBy) {
    case LibrarySortByType.Title:
      return formatTitle(book.title);

    case LibrarySortByType.Author:
      return formatAuthors(book.author, book?.primaryLanguage || 'en', true);

    case LibrarySortByType.Updated:
      return book.updatedAt;

    case LibrarySortByType.Created:
      return book.createdAt;

    case LibrarySortByType.Format:
      return book.format;

    case LibrarySortByType.Progress:
      return getBookReadRatio(book);

    case LibrarySortByType.Published: {
      const published = book.metadata?.published;
      if (!published) return 0;
      const publishedTime = new Date(published).getTime();
      return isNaN(publishedTime) ? 0 : publishedTime;
    }

    case LibrarySortByType.TimeRemaining:
      // Return Infinity if a book does not have time remaining (ie. if the book is unread or finished) so it is sorted after books with time remaining
      return getTimeRemainingMinutes(book) ?? Infinity;

    default:
      return book.updatedAt;
  }
};

/**
 * Get the aggregate sort value from a group for sorting groups.
 */
export const getGroupSortValue = (
  group: BooksGroup,
  sortBy: LibrarySortByType,
  groupBy?: LibraryGroupByType,
): number | string => {
  const books = group.books;

  if (books.length === 0) {
    // Manual sort orders empty (persisted) groups by their shelf anchor
    // (libraryEmptyGroupOrder). The anchor is a float on the same ruler as
    // book-backed groups' min shelfIndex, so empty groups can interleave.
    if (sortBy === LibrarySortByType.Manual) {
      return group.manualOrder ?? 0;
    }
    return sortBy === LibrarySortByType.Title ||
      sortBy === LibrarySortByType.Series ||
      sortBy === LibrarySortByType.Author ||
      sortBy === LibrarySortByType.Format
      ? group.name
      : 0;
  }

  switch (sortBy) {
    case LibrarySortByType.Title:
    case LibrarySortByType.Series:
    case LibrarySortByType.Format:
      return group.name;

    case LibrarySortByType.Author: {
      if (groupBy === LibraryGroupByType.Author) {
        // Author group: format the group name (single author) with last-name-first
        return formatAuthors(group.name, 'en', true);
      }
      if (groupBy === LibraryGroupByType.Series) {
        // Series group: use the first book's author for sorting
        const firstBook = books[0]!;
        return formatAuthors(firstBook.author, firstBook.primaryLanguage || 'en', true);
      }
      // Custom/other groups: fall back to group name
      return group.name;
    }

    case LibrarySortByType.Updated:
      // Return the most recent updatedAt
      return Math.max(...books.map((b) => b.updatedAt));

    case LibrarySortByType.Manual: {
      // A group sorts by its earliest manually-placed book; groups with no
      // manual index sort last. (Empty groups are handled by the early
      // `books.length === 0` return above.)
      const minIndex = Math.min(
        ...books.map((b) => b.shelfIndex ?? Number.MAX_SAFE_INTEGER),
        Number.MAX_SAFE_INTEGER,
      );
      return minIndex === Number.MAX_SAFE_INTEGER ? 0 : minIndex;
    }

    case LibrarySortByType.Created:
      // Return the most recent createdAt
      return Math.max(...books.map((b) => b.createdAt));

    case LibrarySortByType.Progress:
      // Return the most-progressed book's read ratio
      return Math.max(...books.map((b) => getBookReadRatio(b)));

    case LibrarySortByType.Published: {
      // Return the most recent published date
      const publishedDates = books
        .map((b) => b.metadata?.published)
        .filter((d): d is string => !!d)
        .map((d) => new Date(d).getTime())
        .filter((t) => !isNaN(t));

      return publishedDates.length > 0 ? Math.max(...publishedDates) : 0;
    }

    case LibrarySortByType.TimeRemaining:
      // Return book with least amount of time remaining
      return Math.min(...books.map((b) => getTimeRemainingMinutes(b) ?? Infinity));

    default:
      return Math.max(...books.map((b) => b.updatedAt));
  }
};

/**
 * Compare two sort values (string or number) for sorting.
 */
export const compareSortValues = (
  aValue: number | string,
  bValue: number | string,
  uiLanguage: string,
): number => {
  // String comparison for text-based sorts
  if (typeof aValue === 'string' && typeof bValue === 'string') {
    return aValue.localeCompare(bValue, uiLanguage || navigator.language);
  }

  // Numeric comparison for date-based sorts
  if (typeof aValue === 'number' && typeof bValue === 'number') {
    return aValue - bValue;
  }

  return 0;
};

/**
 * Create a sorter for groups themselves based on sort criteria.
 */
export const createGroupSorter =
  (sortBy: LibrarySortByType, uiLanguage: string, groupBy?: LibraryGroupByType) =>
  (a: BooksGroup, b: BooksGroup): number => {
    const aValue = getGroupSortValue(a, sortBy, groupBy);
    const bValue = getGroupSortValue(b, sortBy, groupBy);

    // String comparison for text-based sorts
    if (typeof aValue === 'string' && typeof bValue === 'string') {
      return aValue.localeCompare(bValue, uiLanguage || navigator.language);
    }

    // Numeric comparison for date-based sorts
    if (typeof aValue === 'number' && typeof bValue === 'number') {
      return aValue - bValue;
    }

    return 0;
  };

export type BookContextMenuItemId =
  | 'select'
  | 'group'
  | 'markFinished'
  | 'markUnread'
  | 'markAbandoned'
  | 'clearStatus'
  | 'showDetails'
  | 'showInFinder'
  | 'delete';

/**
 * Build a new Book with an explicit reading status. Stamps both `updatedAt`
 * (so the library sync picks it up) and `readingStatusUpdatedAt` (so the
 * field-level merge resolves status independently of progress). Use this for
 * every deliberate status edit so the timestamp is never forgotten.
 */
export const withReadingStatus = (book: Book, status: ReadingStatus | undefined): Book => {
  const now = Date.now();
  return { ...book, readingStatus: status, readingStatusUpdatedAt: now, updatedAt: now };
};

type ReadingStatusFields = Pick<Book, 'readingStatus' | 'readingStatusUpdatedAt'>;

/**
 * Field-level last-writer-wins for reading status: return whichever side's
 * status was set more recently (ties → `a`). Missing timestamp = epoch 0.
 * The book row's `updatedAt` is dominated by page-turn progress, so status
 * must be resolved by its own timestamp or progress would clobber it.
 */
export const pickFresherReadingStatus = (
  a: ReadingStatusFields,
  b: ReadingStatusFields,
): ReadingStatusFields => {
  const at = (x: ReadingStatusFields) => x.readingStatusUpdatedAt ?? 0;
  const winner = at(a) >= at(b) ? a : b;
  return {
    readingStatus: winner.readingStatus,
    readingStatusUpdatedAt: winner.readingStatusUpdatedAt,
  };
};

type CoverFields = Pick<Book, 'coverHash' | 'coverUpdatedAt'>;
type CoverSyncFields = Pick<
  Book,
  'coverHash' | 'coverUpdatedAt' | 'coverDownloadedAt' | 'deletedAt' | 'uploadedAt'
>;

const coverMs = (t?: number | null) => t ?? 0;

/**
 * Decide whether a peer should (re)download a book's cover from the cloud
 * (issue #4544). True when the synced book is in the cloud AND either:
 *  - this device has never fetched the cover (first download), or
 *  - a newer cover edit exists (synced `coverUpdatedAt` strictly newer) whose
 *    content hash differs from the local one.
 *
 * Gating on `coverUpdatedAt` (not just the hash) prevents two failure modes:
 *  - churn: once a device adopts the synced `coverUpdatedAt` after downloading,
 *    the comparison stops firing on every subsequent sync;
 *  - the unpushed-local-edit race: a device that just edited its cover (newer
 *    local `coverUpdatedAt`) is not made to overwrite it with the stale cloud
 *    copy before its own push lands.
 */
export const needsCoverRefresh = (local: CoverSyncFields, synced: CoverSyncFields): boolean => {
  if (synced.deletedAt || !synced.uploadedAt) return false;
  if (!local.coverDownloadedAt) return true; // first download
  if (!synced.coverHash) return false; // nothing to compare (legacy book)
  if (coverMs(synced.coverUpdatedAt) <= coverMs(local.coverUpdatedAt)) return false;
  return synced.coverHash !== local.coverHash;
};

/**
 * Field-level last-writer-wins for the cover, by `coverUpdatedAt` (ties →
 * `local`, which already holds the file). Mirrors {@link pickFresherReadingStatus}:
 * the row's `updatedAt` is dominated by page-turn progress, so the cover must be
 * resolved by its own timestamp or progress would clobber a cover edit.
 */
export const pickFresherCover = (local: CoverFields, synced: CoverFields): CoverFields =>
  coverMs(synced.coverUpdatedAt) > coverMs(local.coverUpdatedAt)
    ? { coverHash: synced.coverHash, coverUpdatedAt: synced.coverUpdatedAt }
    : { coverHash: local.coverHash, coverUpdatedAt: local.coverUpdatedAt };

type MetadataFields = Pick<Book, 'title' | 'author' | 'tags' | 'metadata' | 'metadataUpdatedAt'>;

/**
 * Field-level last-writer-wins for the metadata group (title, author, tags,
 * metadata), by `metadataUpdatedAt` (issue #5438). Mirrors
 * {@link pickFresherReadingStatus} / {@link pickFresherCover}: the row's
 * `updatedAt` is dominated by page-turn progress, so a metadata edit must be
 * resolved by its own timestamp or reading the book on another device would
 * clobber it. Returns null when neither side's stamp is strictly fresher —
 * notably the unstamped legacy case — so the caller keeps the row-level
 * winner's fields (legacy behavior) instead of grafting.
 */
export const pickFresherMetadata = (
  local: MetadataFields,
  synced: MetadataFields,
): MetadataFields | null => {
  const localMs = local.metadataUpdatedAt ?? 0;
  const syncedMs = synced.metadataUpdatedAt ?? 0;
  if (localMs === syncedMs) return null;
  const winner = localMs > syncedMs ? local : synced;
  return {
    title: winner.title,
    author: winner.author,
    tags: winner.tags,
    metadata: winner.metadata,
    metadataUpdatedAt: winner.metadataUpdatedAt,
  };
};

/**
 * Resolve the ordered list of context-menu item ids for a book from its state.
 *
 * The native menu MUST be built from this list in a single `Menu.new({ items })`
 * call. Appending items one at a time with un-awaited `Menu.append()` promises
 * races on the Tauri IPC boundary, so the items land in a non-deterministic
 * order and the menu appears to shuffle on every open (issue #4389).
 */
export const getBookContextMenuItemIds = (book: Book): BookContextMenuItemId[] => {
  const ids: BookContextMenuItemId[] = ['select', 'group'];
  ids.push(book.readingStatus === 'finished' ? 'markUnread' : 'markFinished');
  if (book.readingStatus !== 'abandoned') ids.push('markAbandoned');
  // "Clear Status" is offered only when the book has an explicit status set.
  if (
    book.readingStatus === 'finished' ||
    book.readingStatus === 'unread' ||
    book.readingStatus === 'abandoned'
  ) {
    ids.push('clearStatus');
  }
  ids.push('showDetails', 'showInFinder');
  ids.push('delete');
  return ids;
};

/** A drag source on the library shelf: a single book or a whole group subtree. */
export type GroupSource = { kind: 'book'; hash: string } | { kind: 'group'; groupName: string };

/**
 * Move a book — or an entire group subtree — into `targetGroupName`, rewriting
 * `groupId`/`groupName` (and bumping `updatedAt`) for every affected book.
 * `targetGroupName === undefined` moves to the top level ("All"): the book is
 * ungrouped, or the group is kept intact as a top-level folder (not unpacked).
 * Returns the same array reference when nothing changes (no-op / cycle) so
 * callers can skip persistence and keep React memo comparisons intact.
 */
export const reassignToGroup = (
  library: Book[],
  source: GroupSource,
  targetGroupName?: string,
): { updated: Book[]; changed: boolean } => {
  const rename = (book: Book, nextGroupName: string | undefined): Book => ({
    ...book,
    groupName: nextGroupName,
    groupId: nextGroupName ? md5Fingerprint(nextGroupName) : undefined,
    updatedAt: Date.now(),
  });

  if (source.kind === 'book') {
    const book = library.find((b) => b.hash === source.hash);
    if (!book || book.groupName === targetGroupName) {
      return { updated: library, changed: false };
    }
    return {
      updated: library.map((b) => (b.hash === source.hash ? rename(b, targetGroupName) : b)),
      changed: true,
    };
  }

  const src = source.groupName;
  if (!targetGroupName) {
    // Top level ("All"): hoist the dragged group to a top-level folder — the
    // group itself is preserved, its members keep their relative structure.
    if (!src.includes('/')) {
      // Already a top-level group.
      return { updated: library, changed: false };
    }
    const topName = src.slice(src.lastIndexOf('/') + 1);
    const hasMembers = library.some(
      (b) => b.groupName === src || b.groupName?.startsWith(src + '/'),
    );
    if (!hasMembers) return { updated: library, changed: false };
    return {
      updated: library.map((book) => {
        if (book.groupName === src) return rename(book, topName);
        if (book.groupName?.startsWith(src + '/')) {
          // A/C/X -> C/X (drop the ancestor prefix).
          return rename(book, topName + book.groupName.slice(src.length));
        }
        return book;
      }),
      changed: true,
    };
  }

  const dst = targetGroupName;
  // Moving a group into itself, into its own descendant (cycle), or into its
  // own ancestor (a no-op rename) is rejected.
  if (src === dst || dst.startsWith(src + '/') || src.startsWith(dst + '/')) {
    return { updated: library, changed: false };
  }
  const hasMembers = library.some((b) => b.groupName === src || b.groupName?.startsWith(src + '/'));
  if (!hasMembers) return { updated: library, changed: false };

  return {
    updated: library.map((book) => {
      if (book.groupName === src) {
        // Keep the dragged group as its own nested folder under the target
        // (A dragged into B becomes B/A), rather than scattering its members.
        return rename(book, `${dst}/${src}`);
      }
      if (book.groupName?.startsWith(src + '/')) {
        // Preserve the relative path under the source, e.g. A/B/C -> B/A/B/C.
        return rename(book, `${dst}/${src}${book.groupName.slice(src.length)}`);
      }
      return book;
    }),
    changed: true,
  };
};

/**
 * The relabeling that {@link reassignToGroup} applies to books, but for a list
 * of persistent group *names*. Empty groups carry no books, so their path lives
 * only in `persistentGroupNames` / `libraryCustomGroups` — moving one must
 * rewrite those names, not any book rows. Mirrors the same cycle/no-op rules as
 * the book path: yes to nesting elsewhere, no to self / own descendant / own
 * ancestor / hoisting a top-level group.
 */
export const relabelPersistentGroups = (
  names: readonly string[],
  source: string,
  target?: string,
): { relabeled: Map<string, string>; changed: boolean } => {
  const relabeled = new Map<string, string>();
  if (!target) {
    // Top level: hoist the source's leaf segment, dropping its parent prefix.
    if (!source.includes('/')) return { relabeled, changed: false };
    const topName = source.slice(source.lastIndexOf('/') + 1);
    for (const name of names) {
      if (name === source) relabeled.set(name, topName);
      else if (name.startsWith(source + '/'))
        relabeled.set(name, topName + name.slice(source.length));
    }
    return { relabeled, changed: relabeled.size > 0 };
  }
  if (source === target || target.startsWith(source + '/') || source.startsWith(target + '/')) {
    return { relabeled, changed: false };
  }
  for (const name of names) {
    if (name === source) relabeled.set(name, `${target}/${source}`);
    else if (name.startsWith(source + '/'))
      relabeled.set(name, `${target}/${source}${name.slice(source.length)}`);
  }
  return { relabeled, changed: relabeled.size > 0 };
};

/**
 * Reorder the items of one bookshelf layer for manual sorting. `items` is the
 * layer's rendered shelf (books and/or groups). `sourceId` is either a book
 * hash or a group's full name; the whole source unit — for a group, every one
 * of its books as one contiguous block, inner order preserved — moves to sit
 * just before (`before: true`) or just after (`before: false`) the target
 * unit. Reassigns the whole layer's `shelfIndex` 0..n-1 in the new order.
 * Returns `changed: false` with an empty list when the move leaves the order
 * unchanged (already sitting right next to the target).
 */
export const reorderShelfLayer = (
  items: readonly (Book | BooksGroup)[],
  sourceId: string,
  targetId: string,
  before: boolean,
): { updated: Book[]; changed: boolean; ordered: (Book | BooksGroup)[] } => {
  const idOf = (item: Book | BooksGroup): string =>
    'format' in item ? (item as Book).hash : (item as BooksGroup).name;
  const srcIdx = items.findIndex((i) => idOf(i) === sourceId);
  const tgtIdx = items.findIndex((i) => idOf(i) === targetId);
  if (srcIdx === -1 || tgtIdx === -1 || srcIdx === tgtIdx) {
    return { updated: [], changed: false, ordered: [] };
  }
  const original = items.map(idOf);
  const moving = items[srcIdx]!;
  const rest = items.filter((_, i) => i !== srcIdx);
  // Target index after the source unit is removed.
  const t = srcIdx < tgtIdx ? tgtIdx - 1 : tgtIdx;
  const insertAt = before ? t : t + 1;
  const next = [...rest.slice(0, insertAt), moving, ...rest.slice(insertAt)];
  const toUpdated = (units: readonly (Book | BooksGroup)[]): Book[] =>
    units
      .flatMap((it) => ('format' in it ? [it as Book] : (it as BooksGroup).books))
      .map((b, i) => (b.shelfIndex === i ? b : { ...b, shelfIndex: i }));

  if (next.length === original.length && next.every((it, i) => idOf(it) === original[i])) {
    // The move left the order unchanged. For adjacent units the drop almost
    // always means "swap these two" (e.g. dragging 1 onto the top of 2 to get
    // 2,1,3,…), so swap instead of silently doing nothing.
    if (Math.abs(srcIdx - tgtIdx) === 1) {
      const swapped = items.slice();
      const lo = Math.min(srcIdx, tgtIdx);
      const hi = Math.max(srcIdx, tgtIdx);
      [swapped[lo]!, swapped[hi]!] = [swapped[hi]!, swapped[lo]!];
      return { updated: toUpdated(swapped), changed: true, ordered: swapped };
    }
    return { updated: [], changed: false, ordered: [] };
  }
  return { updated: toUpdated(next), changed: true, ordered: next };
};

/**
 * Swap two units of a shelf layer in place — the drag model the user expects
 * ("drag 1 onto 4 to get 4,2,3,1"), where the units trade positions regardless
 * of whether the pointer landed on the top or bottom half. Same rebasing of the
 * whole layer's shelfIndex and `ordered` output as {@link reorderShelfLayer}.
 */
export type GroupDropKind = 'swap' | 'merge';

/**
 * 拖入组格的落点语义：书拖进组格一律归入（merge）；只有“组拖组”且落在
 * 上半区才是换序（swap）。下半区一律 merge，与高亮提示保持一致（B-4）。
 */
export const resolveGroupDropKind = (
  sourceKind: 'book' | 'group' | null,
  pointerY: number,
  rectTop: number,
  rectHeight: number,
): GroupDropKind =>
  sourceKind === 'group' && pointerY < rectTop + rectHeight / 2 ? 'swap' : 'merge';

export const swapShelfUnits = (
  items: readonly (Book | BooksGroup)[],
  sourceId: string,
  targetId: string,
): { updated: Book[]; changed: boolean; ordered: (Book | BooksGroup)[] } => {
  const idOf = (item: Book | BooksGroup): string =>
    'format' in item ? (item as Book).hash : (item as BooksGroup).name;
  const srcIdx = items.findIndex((i) => idOf(i) === sourceId);
  const tgtIdx = items.findIndex((i) => idOf(i) === targetId);
  if (srcIdx === -1 || tgtIdx === -1 || srcIdx === tgtIdx) {
    return { updated: [], changed: false, ordered: [] };
  }
  const swapped = items.slice();
  const lo = Math.min(srcIdx, tgtIdx);
  const hi = Math.max(srcIdx, tgtIdx);
  [swapped[lo]!, swapped[hi]!] = [swapped[hi]!, swapped[lo]!];
  const original = items.map(idOf);
  if (swapped.every((it, i) => idOf(it) === original[i])) {
    return { updated: [], changed: false, ordered: [] };
  }
  const updated = swapped
    .flatMap((it) => ('format' in it ? [it as Book] : (it as BooksGroup).books))
    .map((b, i) => (b.shelfIndex === i ? b : { ...b, shelfIndex: i }));
  return { updated, changed: true, ordered: swapped };
};

/**
 * Recompute the manual-sort anchor for every empty group in a layer after a
 * reorder, so empty groups can sit anywhere book-backed groups do. Each empty
 * group takes a slot in the gap between the neighbouring book "min" keys — the
 * earliest book's shelfIndex (a loose book counts as a single-book "group").
 * Empty groups in front of everything get a key below the first min, after
 * everything they take lastMin + 0.5·(k+1), and a run of empty groups splits
 * one gap evenly in the order they appeared. Returns full name -> anchor.
 */
export const assignEmptyGroupAnchors = (
  ordered: readonly (Book | BooksGroup)[],
  indices?: ReadonlyMap<string, number>,
): Map<string, number> => {
  // `ordered` still holds the pre-reorder book objects; the caller passes the
  // rebased 0..n-1 indices so the anchor gaps use the keys the books will sort
  // by after the move, not the stale ones.
  const idxOf = (b: Book) => indices?.get(b.hash) ?? b.shelfIndex ?? Number.MAX_SAFE_INTEGER;
  type U = { name: string; min: number | null };
  const units: U[] = [];
  for (const it of ordered) {
    if ('format' in it) {
      const b = it as Book;
      units.push({ name: b.hash, min: idxOf(b) });
    } else {
      const g = it as BooksGroup;
      units.push({
        name: g.name,
        min: g.books.length ? Math.min(...g.books.map(idxOf)) : null,
      });
    }
  }
  const anchors = new Map<string, number>();
  let i = 0;
  while (i < units.length) {
    if (units[i]!.min !== null) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < units.length && units[i]!.min === null) i += 1;
    const n = i - start;
    const prevMin = start > 0 && units[start - 1]!.min !== null ? units[start - 1]!.min : null;
    const nextMin = i < units.length && units[i]!.min !== null ? units[i]!.min : null;
    for (let k = 0; k < n; k++) {
      const u = units[start + k]!;
      let anchor: number;
      if (prevMin === null && nextMin === null) {
        // Every unit is an empty group — no book key to reference. Anchor by
        // the group's own position in the dragged order (start + slot), so the
        // layer stays in the order the user just dragged it into.
        anchor = start + k;
      } else if (prevMin === null) {
        anchor = (nextMin as number) - (n - k);
      } else if (nextMin === null) {
        anchor = prevMin + 0.5 * (k + 1);
      } else {
        anchor = prevMin + ((nextMin - prevMin) * (k + 1)) / (n + 1);
      }
      anchors.set(u.name, anchor);
    }
  }
  return anchors;
};

/**
 * Rebase a shelf layer after one group is merged into another, so the
 * remaining groups keep their pre-merge order. Merging keeps the source book's
 * old small shelfIndex, which drags the target group's min-shelfIndex sort key
 * to the front (e.g. merging 1 into 5 turns 1,2,3,4,5,6 into 5,2,3,4,6). This
 * rebases the remaining books to 0..n-1 in remaining-layer order and appends
 * the merged-in source books after the target's books, then re-anchors every
 * empty group in the same order.
 */
export const rebaseLayerAfterGroupMerge = (
  remainingItems: readonly (Book | BooksGroup)[],
  updated: readonly Book[],
  sourceFold: string, // e.g. "1/2" — merged source group's folded path
): { books: Book[]; anchors: Map<string, number> } => {
  // The folded source books belong *inside* the target group: append them to
  // its slot so the target keeps its pre-merge position. Appending them to the
  // very end of the whole layer instead would push an empty-shell target group
  // (one with no direct books, only nested ones) to the back.
  const targetName = sourceFold.split('/')[0] ?? sourceFold;
  const foldBooks = updated.filter(
    (b) => b.groupName === sourceFold || b.groupName?.startsWith(sourceFold + '/'),
  );
  const flat: Book[] = [];
  for (const it of remainingItems) {
    if ('format' in it) flat.push(it);
    else {
      flat.push(...it.books);
      if ((it as BooksGroup).name === targetName) flat.push(...foldBooks);
    }
  }
  const idx = new Map(flat.map((b, i) => [b.hash, i] as const));
  const books = updated.map((b) => {
    const i = idx.get(b.hash);
    return i !== undefined && b.shelfIndex !== i ? { ...b, shelfIndex: i } : b;
  });
  const finalIdx = new Map(books.map((b) => [b.hash, b.shelfIndex ?? 0] as const));
  const anchors = assignEmptyGroupAnchors(remainingItems, finalIdx);
  return { books, anchors };
};

/**
 * Follow the manual-sort anchor map when persisted group paths are relabelled
 * (a group moved to another level). Keys matching an old path move their value
 * to the new path, so stale orphan anchors can't resurrect the old empty group.
 * Returns null when nothing moved.
 */
export const relabelAnchorMap = (
  order: Record<string, number> | undefined,
  relabeled: ReadonlyMap<string, string>,
): Record<string, number> | null => {
  if (!order) return null;
  let next: Record<string, number> | null = null;
  for (const [oldName, newName] of relabeled) {
    if (oldName in order) {
      next ??= { ...order };
      next[newName] = order[oldName]!;
      delete next[oldName];
    }
  }
  return next;
};
