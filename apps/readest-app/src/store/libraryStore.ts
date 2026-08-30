import { create } from 'zustand';
import { Book, BookGroupType, ReadingStatus } from '@/types/book';
import { EnvConfigType, isTauriAppPlatform } from '@/services/environment';
import { BOOK_UNGROUPED_NAME } from '@/services/constants';
import { md5Fingerprint } from '@/utils/md5';

interface LibraryState {
  library: Book[]; // might contain deleted books
  libraryLoaded: boolean;
  isSyncing: boolean;
  syncProgress: number;
  checkOpenWithBooks: boolean;
  checkLastOpenBooks: boolean;
  currentBookshelf: Book[];
  selectedBooks: Set<string>; // hashes for books, ids for groups
  groups: Record<string, string>;
  persistentGroupNames: string[];
  hashIndex: Map<string, number>; // hash -> array index for O(1) lookup
  visibleLibrary: Book[];
  setIsSyncing: (syncing: boolean) => void;
  setSyncProgress: (progress: number) => void;
  setSelectedBooks: (ids: string[]) => void;
  getSelectedBooks: () => string[];
  toggleSelectedBook: (id: string) => void;
  getVisibleLibrary: () => Book[];
  getBookByHash: (hash: string) => Book | undefined;
  setCheckOpenWithBooks: (check: boolean) => void;
  setCheckLastOpenBooks: (check: boolean) => void;
  setLibrary: (books: Book[]) => void;
  // The third parameter is required (no `?`) so a future caller cannot
  // accidentally clear `readingStatus` by omitting it. Pass the desired final
  // value explicitly: the existing `readingStatus`, `undefined` to clear, or
  // a new status like 'finished'.
  updateBookProgress: (
    hash: string,
    progress: [number, number],
    readingStatus: ReadingStatus | undefined,
  ) => void;
  updateBook: (envConfig: EnvConfigType, book: Book) => Promise<void>;
  updateBooks: (
    envConfig: EnvConfigType,
    books: Book[],
    options?: { skipSave?: boolean },
  ) => Promise<void>;
  setCurrentBookshelf: (bookshelf: Book[]) => void;
  refreshGroups: () => void;
  rebuildHashIndex: () => void;
  addGroup: (name: string) => BookGroupType;
  addPersistentGroup: (name: string) => BookGroupType;
  removePersistentGroups: (paths: string[]) => void;
  // Move one persisted group name just before/after another in the persisted
  // order (used by empty-group manual sorting). Returns false when the names
  // are absent or the move leaves the order unchanged.
  reorderPersistentGroup: (source: string, target: string, before: boolean) => boolean;
  getGroups: () => BookGroupType[];
  getGroupId: (path: string) => string | undefined;
  getGroupName: (id: string) => string | undefined;
  getParentPath: (path: string) => string | undefined;
  getGroupsByParent: (parentPath?: string) => BookGroupType[];
}

function buildHashIndex(books: Book[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < books.length; i++) {
    index.set(books[i]!.hash, i);
  }
  return index;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  library: [],
  libraryLoaded: false,
  isSyncing: false,
  syncProgress: 0,
  currentBookshelf: [],
  selectedBooks: new Set(),
  groups: {},
  persistentGroupNames: [],
  hashIndex: new Map(),
  visibleLibrary: [],
  checkOpenWithBooks: isTauriAppPlatform(),
  checkLastOpenBooks: isTauriAppPlatform(),

  setIsSyncing: (syncing: boolean) => set({ isSyncing: syncing }),
  setSyncProgress: (progress: number) => set({ syncProgress: progress }),
  getVisibleLibrary: () => get().visibleLibrary,
  getBookByHash: (hash: string) => {
    const { library, hashIndex } = get();
    const idx = hashIndex.get(hash);
    return idx !== undefined ? library[idx] : undefined;
  },

  setCurrentBookshelf: (bookshelf: Book[]) => {
    set({ currentBookshelf: bookshelf });
  },

  setCheckOpenWithBooks: (check) => set({ checkOpenWithBooks: check }),
  setCheckLastOpenBooks: (check) => set({ checkLastOpenBooks: check }),
  setLibrary: (books) => {
    set({
      library: books,
      libraryLoaded: true,
      hashIndex: buildHashIndex(books),
      visibleLibrary: books.filter((b) => !b.deletedAt),
    });
    get().refreshGroups();
  },

  // Immutable lightweight progress update — skips refreshGroups (which is the
  // expensive O(n) MD5 path) but still creates new array references for
  // `library` and `visibleLibrary` so Zustand subscribers re-render correctly
  // and the visibleLibrary cache stays in sync.
  updateBookProgress: (hash, progress, readingStatus) => {
    const { library, hashIndex } = get();
    const idx = hashIndex.get(hash);
    if (idx === undefined) return;
    const book = library[idx]!;
    const statusChanged = readingStatus !== book.readingStatus;
    const updatedBook: Book = {
      ...book,
      progress,
      readingStatus,
      readingStatusUpdatedAt: statusChanged ? Date.now() : book.readingStatusUpdatedAt,
      updatedAt: Date.now(),
    };
    const newLibrary = library.slice();
    newLibrary[idx] = updatedBook;
    set({
      library: newLibrary,
      visibleLibrary: newLibrary.filter((b) => !b.deletedAt),
    });
  },

  rebuildHashIndex: () => {
    set({ hashIndex: buildHashIndex(get().library) });
  },

  updateBook: async (envConfig: EnvConfigType, book: Book) => {
    const appService = await envConfig.getAppService();
    const { library, hashIndex } = get();
    const idx = hashIndex.get(book.hash);
    // Build the new library immutably — never mutate the previous-state array.
    const newLibrary =
      idx !== undefined
        ? [...library.slice(0, idx), book, ...library.slice(idx + 1)]
        : library.slice();
    set({
      library: newLibrary,
      hashIndex: buildHashIndex(newLibrary),
      visibleLibrary: newLibrary.filter((b) => !b.deletedAt),
    });
    await appService.saveLibraryBooks(newLibrary);
  },
  updateBooks: async (
    envConfig: EnvConfigType,
    books: Book[],
    options?: { skipSave?: boolean },
  ) => {
    if (!books?.length) return;

    // Hardening: if a caller (e.g. /send, the inbox drainer) hits us before
    // `setLibrary` has populated the store, merging against the empty
    // in-memory array would persist `books` as the *entire* library and
    // clobber whatever is on disk. Load the real library first.
    let { library } = get();
    const { libraryLoaded, refreshGroups } = get();
    if (!libraryLoaded) {
      const appService = await envConfig.getAppService();
      library = await appService.loadLibraryBooks();
      set({
        library,
        libraryLoaded: true,
        hashIndex: buildHashIndex(library),
        visibleLibrary: library.filter((b) => !b.deletedAt),
      });
    }

    const newLibrary = Array.from(new Map([...library, ...books].map((b) => [b.hash, b])).values());
    set({
      library: newLibrary,
      hashIndex: buildHashIndex(newLibrary),
      visibleLibrary: newLibrary.filter((b) => !b.deletedAt),
    });
    refreshGroups();

    if (!options?.skipSave) {
      const appService = await envConfig.getAppService();
      await appService.saveLibraryBooks(newLibrary);
    }
  },

  setSelectedBooks: (ids: string[]) => {
    set({ selectedBooks: new Set(ids) });
  },

  getSelectedBooks: () => {
    return Array.from(get().selectedBooks);
  },

  toggleSelectedBook: (id: string) => {
    set((state) => {
      const newSelection = new Set(state.selectedBooks);
      if (newSelection.has(id)) {
        newSelection.delete(id);
      } else {
        newSelection.add(id);
      }
      return { selectedBooks: newSelection };
    });
  },

  refreshGroups: () => {
    const { library } = get();
    const groups: Record<string, string> = {};

    library.forEach((book) => {
      if (book.groupName && book.groupName !== BOOK_UNGROUPED_NAME && !book.deletedAt) {
        groups[md5Fingerprint(book.groupName)] = book.groupName;
        let nextSlashIndex = book.groupName.indexOf('/', 0);
        while (nextSlashIndex > 0) {
          const groupName = book.groupName.substring(0, nextSlashIndex);
          groups[md5Fingerprint(groupName)] = groupName;
          nextSlashIndex = book.groupName.indexOf('/', nextSlashIndex + 1);
        }
      }
    });

    // Keep explicitly-created (possibly still-empty) groups alive no matter
    // how often the map is rebuilt from books.
    for (const name of get().persistentGroupNames ?? []) {
      let prefix = '';
      for (const segment of name.split('/')) {
        prefix = prefix ? `${prefix}/${segment}` : segment;
        groups[md5Fingerprint(prefix)] = prefix;
      }
    }

    set({ groups });
  },

  addGroup: (name: string) => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error('Group name cannot be empty');
    }

    const id = md5Fingerprint(trimmedName);
    const { groups } = get();

    // Register every ancestor prefix too (e.g. "A/B" also registers "A"), so
    // nested groups resolve through getGroupName even before any book carries
    // that path. Mirrors what refreshGroups does for book-derived groups.
    const nextGroups = { ...groups, [id]: trimmedName };
    let slashIndex = trimmedName.indexOf('/');
    while (slashIndex > 0) {
      const prefix = trimmedName.slice(0, slashIndex);
      const prefixId = md5Fingerprint(prefix);
      if (!nextGroups[prefixId]) nextGroups[prefixId] = prefix;
      slashIndex = trimmedName.indexOf('/', slashIndex + 1);
    }

    set({ groups: nextGroups });

    return { id, name: trimmedName };
  },

  addPersistentGroup: (name: string) => {
    const result = get().addGroup(name);
    const names = get().persistentGroupNames ?? [];
    if (!names.includes(result.name)) {
      set({ persistentGroupNames: [...names, result.name] });
    }
    return result;
  },

  removePersistentGroups: (paths: string[]) => {
    const { persistentGroupNames, groups } = get();
    const victim = paths.map((p) => p.trim()).filter(Boolean);
    if (victim.length === 0) return;
    const nextNames = (persistentGroupNames ?? []).filter(
      (n) => !victim.includes(n) && !victim.some((p) => n.startsWith(p + '/')),
    );
    const nextGroups: Record<string, string> = {};
    for (const [id, name] of Object.entries(groups)) {
      const removed = victim.includes(name) || victim.some((p) => name.startsWith(p + '/'));
      if (!removed) nextGroups[id] = name;
    }
    set({ persistentGroupNames: nextNames, groups: nextGroups });
  },

  reorderPersistentGroup: (source: string, target: string, before: boolean) => {
    const { persistentGroupNames } = get();
    const srcIdx = persistentGroupNames.indexOf(source);
    const tgtIdx = persistentGroupNames.indexOf(target);
    if (srcIdx === -1 || tgtIdx === -1 || srcIdx === tgtIdx) return false;
    const rest = persistentGroupNames.filter((n) => n !== source);
    const t = srcIdx < tgtIdx ? tgtIdx - 1 : tgtIdx;
    const insertAt = before ? t : t + 1;
    const next = [...rest.slice(0, insertAt), source, ...rest.slice(insertAt)];
    if (
      next.length === persistentGroupNames.length &&
      next.every((n, i) => n === persistentGroupNames[i])
    ) {
      // Same as book drags: dropping one group onto an adjacent one almost
      // always means "swap them" (e.g. dragging 1 onto the top of 2).
      if (Math.abs(srcIdx - tgtIdx) === 1) {
        const swapped = persistentGroupNames.slice();
        const lo = Math.min(srcIdx, tgtIdx);
        const hi = Math.max(srcIdx, tgtIdx);
        [swapped[lo]!, swapped[hi]!] = [swapped[hi]!, swapped[lo]!];
        set({ persistentGroupNames: swapped });
        return true;
      }
      return false;
    }
    set({ persistentGroupNames: next });
    return true;
  },

  getGroups: () => {
    const { groups } = get();
    return Object.entries(groups)
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },

  getGroupId: (path: string) => {
    const { groups } = get();

    const directId = Object.entries(groups).find(([_, name]) => name === path)?.[0];
    if (directId) {
      return directId;
    }

    return md5Fingerprint(path);
  },

  getGroupName: (id: string) => {
    const direct = get().groups[id];
    if (direct) return direct;
    // Fallback: the persisted group map can miss a nested group (e.g. hash
    // drift or a map built before that path was registered). Re-derive from a
    // book that actually carries the same path, keyed by the same fingerprint.
    const { library } = get();
    const match = library.find(
      (b) => !b.deletedAt && b.groupName && md5Fingerprint(b.groupName) === id,
    );
    return match?.groupName ?? undefined;
  },

  getParentPath: (path: string) => {
    const lastSlashIndex = path.lastIndexOf('/');
    if (lastSlashIndex === -1) return '';
    return path.slice(0, lastSlashIndex);
  },

  getGroupsByParent: (parentPath?: string) => {
    const { groups } = get();
    const result: BookGroupType[] = [];
    Object.entries(groups).forEach(([id, name]) => {
      const groupParentPath = get().getParentPath(name);
      if (groupParentPath === (parentPath || '')) {
        result.push({ id, name });
      }
    });
    return result;
  },
}));
