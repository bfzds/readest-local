import clsx from 'clsx';
import { memo, useCallback, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useLongPress } from '@/hooks/useLongPress';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { eventDispatcher } from '@/utils/event';
import { getOSPlatform } from '@/utils/misc';
import { throttle } from '@/utils/throttle';
import { LibraryCoverFitType, LibraryViewModeType } from '@/types/settings';
import { BOOK_UNGROUPED_ID, BOOK_UNGROUPED_NAME } from '@/services/constants';
import { FILE_REVEAL_LABELS, FILE_REVEAL_PLATFORMS } from '@/utils/os';
import { Book, BooksGroup, ReadingStatus } from '@/types/book';
import {
  getBookContextMenuItemIds,
  type BookContextMenuItemId,
} from '@/app/library/utils/libraryUtils';
import { md5Fingerprint } from '@/utils/md5';
import BookItem from './BookItem';
import GroupItem from './GroupItem';
import BookContextMenuPopup, { type BookContextMenuItem } from './BookContextMenuPopup';
import { useOpenBook } from '../hooks/useOpenBook';
import { MdDelete } from 'react-icons/md';

export const generateBookshelfItems = (
  books: Book[],
  parentGroupName: string,
): (Book | BooksGroup)[] => {
  const groupsMap = new Map<string, BooksGroup>();

  for (const book of books) {
    if (book.deletedAt) continue;

    const groupName = book.groupName || BOOK_UNGROUPED_NAME;
    if (
      parentGroupName &&
      groupName !== parentGroupName &&
      !groupName.startsWith(parentGroupName + '/')
    ) {
      continue;
    }

    const relativePath = parentGroupName ? groupName.slice(parentGroupName.length + 1) : groupName;
    // Get the immediate child group name (or empty if book is directly in parent)
    const slashIndex = relativePath.indexOf('/');
    const immediateChild = slashIndex > 0 ? relativePath.slice(0, slashIndex) : relativePath;
    // Determine if this book belongs directly to the parent group
    const isDirectChild =
      groupName === parentGroupName || (groupName === BOOK_UNGROUPED_NAME && !parentGroupName);
    // Build the full group name for this level
    const fullGroupName = isDirectChild
      ? BOOK_UNGROUPED_NAME
      : parentGroupName
        ? `${parentGroupName}/${immediateChild}`
        : immediateChild;

    const mapKey = fullGroupName;
    const existingGroup = groupsMap.get(mapKey);
    if (existingGroup) {
      existingGroup.books.push(book);
      existingGroup.updatedAt = Math.max(existingGroup.updatedAt, book.updatedAt);
    } else {
      groupsMap.set(mapKey, {
        id: isDirectChild ? BOOK_UNGROUPED_ID : md5Fingerprint(fullGroupName),
        name: fullGroupName,
        displayName: isDirectChild ? BOOK_UNGROUPED_NAME : immediateChild,
        books: [book],
        updatedAt: book.updatedAt,
      });
    }
  }

  for (const group of groupsMap.values()) {
    group.books.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  const ungroupedGroup = groupsMap.get(BOOK_UNGROUPED_NAME);
  const ungroupedBooks = ungroupedGroup?.books || [];
  const groupedBooks = Array.from(groupsMap.values()).filter(
    (group) => group.name !== BOOK_UNGROUPED_NAME,
  );

  return [...ungroupedBooks, ...groupedBooks].sort((a, b) => b.updatedAt - a.updatedAt);
};

interface BookshelfItemProps {
  mode: LibraryViewModeType;
  item: Book | BooksGroup;
  coverFit: LibraryCoverFitType;
  isSelectMode: boolean;
  itemSelected: boolean;
  toggleSelection: (hash: string) => void;
  handleGroupBooks: () => void;
  handleBookDelete: (book: Book, syncBooks?: boolean) => Promise<boolean>;
  handleBookPurge: (book: Book, syncBooks?: boolean) => Promise<boolean>;
  handleSetSelectMode: (selectMode: boolean) => void;
  handleShowDetailsBook: (book: Book) => void;
  handleLibraryNavigation: (targetGroup: string) => void;
  handleUpdateReadingStatus: (book: Book, status: ReadingStatus | undefined) => void;
  showTimeRemaining: boolean;
  // Two-step group delete: first click arms the button (it turns red), the
  // second click commits the deletion.
  onDeleteGroupCommit?: (group: BooksGroup) => void;
}

const BookshelfItem: React.FC<BookshelfItemProps> = ({
  mode,
  item,
  coverFit,
  isSelectMode,
  itemSelected,
  toggleSelection,
  handleGroupBooks,
  handleBookPurge,
  handleSetSelectMode,
  handleShowDetailsBook,
  handleLibraryNavigation,
  handleUpdateReadingStatus,
  showTimeRemaining,
  onDeleteGroupCommit,
}) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const { openBook } = useOpenBook();
  const [deleteArmed, setDeleteArmed] = useState(false);

  const showBookDetailsModal = useCallback(async (book: Book) => {
    handleShowDetailsBook(book);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleBookClick = useCallback(
    async (book: Book) => {
      if (isSelectMode) {
        toggleSelection(book.hash);
        return;
      }
      await openBook(book);
    },
    [isSelectMode, openBook, toggleSelection],
  );

  const handleGroupClick = useCallback(
    (group: BooksGroup) => {
      if (isSelectMode) {
        toggleSelection(group.id);
      } else {
        handleLibraryNavigation(group.id);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isSelectMode, handleLibraryNavigation],
  );

  const buildBookMenuItems = (book: Book): BookContextMenuItem[] => {
    const osPlatform = getOSPlatform();
    const fileRevealLabel =
      FILE_REVEAL_LABELS[osPlatform as FILE_REVEAL_PLATFORMS] || FILE_REVEAL_LABELS.default;
    // Build every item up front, then create the menu from the ordered subset
    // in a single Menu.new({ items }) call. Appending items one-by-one with
    // un-awaited Menu.append() promises races on the Tauri IPC boundary and
    // shuffles the order on every open (issue #4389).
    const itemOptions: Record<BookContextMenuItemId, BookContextMenuItem> = {
      select: {
        text: itemSelected ? _('Deselect Book') : _('Select Book'),
        action: async () => {
          if (!isSelectMode) handleSetSelectMode(true);
          toggleSelection(book.hash);
        },
      },
      group: {
        text: _('Group Books'),
        action: async () => {
          if (!isSelectMode) handleSetSelectMode(true);
          if (!itemSelected) {
            toggleSelection(book.hash);
          }
          handleGroupBooks();
        },
      },
      markFinished: {
        text: _('Mark as Finished'),
        action: async () => {
          handleUpdateReadingStatus(book, 'finished');
        },
      },
      markUnread: {
        text: _('Mark as Unread'),
        action: async () => {
          handleUpdateReadingStatus(book, 'unread');
        },
      },
      markAbandoned: {
        text: _('Mark as On hold'),
        action: async () => {
          handleUpdateReadingStatus(book, 'abandoned');
        },
      },
      clearStatus: {
        text: _('Clear Status'),
        action: async () => {
          handleUpdateReadingStatus(book, undefined);
        },
      },
      showDetails: {
        text: _('Show Book Details'),
        action: async () => {
          showBookDetailsModal(book);
        },
      },
      showInFinder: {
        text: _(fileRevealLabel),
        action: async () => {
          const folder = `${settings.localBooksDir}/${book.hash}`;
          revealItemInDir(folder);
        },
      },
      delete: {
        text: _('Delete'),
        action: async () => {
          eventDispatcher.dispatch('delete-books', { ids: [book.hash] });
        },
      },
    };
    return getBookContextMenuItemIds(book).map((id) => itemOptions[id]);
  };

  const buildGroupMenuItems = (group: BooksGroup): BookContextMenuItem[] => {
    // Single Menu.new({ items }) call keeps the order deterministic — see the
    // note in bookContextMenuHandler about the Menu.append() IPC race (#4389).
    return [
      {
        text: itemSelected ? _('Deselect Group') : _('Select Group'),
        action: async () => {
          if (!isSelectMode) handleSetSelectMode(true);
          toggleSelection(group.id);
        },
      },
      {
        text: _('Group Books'),
        action: async () => {
          if (!isSelectMode) handleSetSelectMode(true);
          if (!itemSelected) {
            toggleSelection(group.id);
          }
          handleGroupBooks();
        },
      },
      {
        text: _('Delete'),
        action: async () => {
          // Dispatch the constituent book hashes — `group.books` is the
          // rendered rollup and already includes books from nested sub-
          // folders, so the deletion path doesn't need to re-derive what
          // belongs to the group from the id alone.
          const ids = group.books.filter((book) => !book.deletedAt).map((book) => book.hash);
          eventDispatcher.dispatch('delete-books', { ids });
        },
      },
    ];
  };

  const buildMenuItems = () =>
    'format' in item ? buildBookMenuItems(item as Book) : buildGroupMenuItems(item as BooksGroup);

  // All platforms render the context menu in-app: the OS-native menu (Tauri's
  // Menu.new) is drawn by the system, so its styling can't match Readest's
  // Adwaita language. A self-drawn <BookContextMenuPopup> keeps the look
  // consistent across platforms.
  const [inAppMenuPosition, setInAppMenuPosition] = useState<{ x: number; y: number } | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleSelectItem = useCallback(
    throttle(() => {
      if (!isSelectMode) {
        handleSetSelectMode(true);
      }
      if ('format' in item) {
        toggleSelection((item as Book).hash);
      } else {
        toggleSelection((item as BooksGroup).id);
      }
    }, 100),
    [isSelectMode],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleOpenItem = useCallback(
    throttle(() => {
      if (isSelectMode) {
        handleSelectItem();
        return;
      }
      if ('format' in item) {
        handleBookClick(item as Book);
      } else {
        handleGroupClick(item as BooksGroup);
      }
    }, 100),
    [handleSelectItem, handleBookClick, handleGroupClick],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleContextMenu = useCallback(
    throttle((position: { x: number; y: number }) => {
      if (!appService?.hasContextMenu) return;
      setInAppMenuPosition(position);
    }, 100),
    [],
  );

  const { pressing, handlers } = useLongPress(
    {
      onLongPress: () => {
        handleSelectItem();
      },
      onTap: () => {
        handleOpenItem();
      },
      onContextMenu: (e) => {
        if (appService?.hasContextMenu) {
          handleContextMenu({ x: e.clientX, y: e.clientY });
        }
      },
    },
    [isSelectMode, handleSelectItem, handleOpenItem, handleContextMenu],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleOpenItem();
    }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      handleContextMenu({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    }
  };

  // Tag the rendered DOM with the book/group identity so feature code
  // (e.g. the Send action's macOS share-popover anchor) can locate the
  // exact bookshelf cell the user is acting on without threading refs
  // through every parent. Books carry their content-hash; groups carry
  // their full group name.
  const itemDataAttrs =
    'format' in item ? { 'data-book-hash': item.hash } : { 'data-group-name': item.name };

  return (
    <div
      className={clsx(
        'group relative',
        mode === 'grid' ? 'h-full' : 'sm:hover:bg-base-300/50 px-4 sm:px-6',
      )}
    >
      <div
        className={clsx(
          'visible-focus-inset-2 group',
          mode === 'grid' &&
            'sm:hover:bg-base-300/50 flex h-full flex-col px-0 py-2 sm:rounded-md sm:px-4 sm:py-4',
          mode === 'list' && 'border-base-300 flex flex-col border-b py-2',
          pressing && mode === 'grid' ? 'not-eink:scale-95' : 'scale-100',
        )}
        role='button'
        tabIndex={0}
        aria-label={'format' in item ? item.title : item.name}
        style={{
          transition: 'transform 0.2s',
        }}
        onKeyDown={handleKeyDown}
        {...itemDataAttrs}
        {...handlers}
      >
        <div className='flex h-full flex-col justify-end'>
          {'format' in item ? (
            <BookItem
              mode={mode}
              book={item}
              coverFit={coverFit}
              isSelectMode={isSelectMode}
              bookSelected={itemSelected}
              showBookDetailsModal={showBookDetailsModal}
              handleBookPurge={handleBookPurge}
              showTimeRemaining={showTimeRemaining}
            />
          ) : (
            <GroupItem
              mode={mode}
              group={item}
              isSelectMode={isSelectMode}
              groupSelected={itemSelected}
            />
          )}
        </div>
      </div>
      {'books' in item && onDeleteGroupCommit && (
        <button
          type='button'
          aria-label={deleteArmed ? _('Confirm delete') : _('Delete Group')}
          title={deleteArmed ? _('Confirm delete') : _('Delete Group')}
          onMouseLeave={() => setDeleteArmed(false)}
          onPointerLeave={() => setDeleteArmed(false)}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            if (deleteArmed) onDeleteGroupCommit(item);
            else setDeleteArmed(true);
          }}
          className={clsx(
            'absolute bottom-1 right-1 z-10 flex h-6 w-6 items-center justify-center rounded-full shadow transition-colors',
            deleteArmed
              ? 'bg-error text-white'
              : 'bg-base-100/90 text-base-content/70 hover:text-error opacity-0 transition-opacity group-hover:opacity-100 hover:!opacity-100',
          )}
        >
          <MdDelete size={14} />
        </button>
      )}
      {inAppMenuPosition && (
        <BookContextMenuPopup
          position={inAppMenuPosition}
          items={buildMenuItems()}
          onClose={() => setInAppMenuPosition(null)}
        />
      )}
    </div>
  );
};

export default memo(BookshelfItem);
