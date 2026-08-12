import clsx from 'clsx';
import React, { useEffect, useState } from 'react';

import { Book } from '@/types/book';
import { getBookWithUpdatedMetadata } from '@/utils/book';
import { BookMetadata } from '@/libs/document';
import { useEnv } from '@/context/EnvContext';
import { eventDispatcher } from '@/utils/event';
import { useTranslation } from '@/hooks/useTranslation';
import { useMetadataEdit } from './useMetadataEdit';
import Dialog from '@/components/Dialog';
import BookDetailView from './BookDetailView';
import BookDetailEdit from './BookDetailEdit';
import Spinner from '../Spinner';

interface BookDetailModalProps {
  book: Book;
  isOpen: boolean;
  onClose: () => void;
  handleBookDownload?: (book: Book, options?: { redownload?: boolean; queued?: boolean }) => void;
  handleBookUpload?: (book: Book) => void;
  handleBookMetadataUpdate?: (book: Book, updatedMetadata: BookMetadata, tags: string[]) => void;
  onMetadataValueClick?: (type: 'tag' | 'subject', value: string) => void;
}

const BookDetailModal: React.FC<BookDetailModalProps> = ({
  book,
  isOpen,
  onClose,
  handleBookDownload,
  handleBookUpload,
  handleBookMetadataUpdate,
  onMetadataValueClick,
}) => {
  const _ = useTranslation();
  const { envConfig, appService } = useEnv();
  const [isLoading, setIsLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [bookMeta, setBookMeta] = useState<BookMetadata | null>(null);
  const [bookTags, setBookTags] = useState<string[]>(book.tags ?? []);
  const [fileSize, setFileSize] = useState<number | null>(null);
  // The parent owns the `book` prop and does not re-pass it after a metadata
  // save, so the details view tracks the saved book locally to refresh its
  // cover/title/author immediately (otherwise it shows the stale prop).
  const [displayBook, setDisplayBook] = useState<Book>(book);

  // Initialize metadata edit hook
  const {
    editedMeta,
    editedTags,
    fieldSources,
    lockedFields,
    fieldErrors,
    handleFieldChange,
    handleToggleFieldLock,
    handleLockAll,
    handleUnlockAll,
    resetToOriginal,
  } = useMetadataEdit(bookMeta, bookTags);

  useEffect(() => {
    const fetchBookDetails = async () => {
      const appService = await envConfig.getAppService();
      try {
        let details = book.metadata || null;
        if (!details && book.downloadedAt) {
          details = await appService.fetchBookDetails(book);
        }
        setBookMeta(details);
        const size = await appService.getBookFileSize(book);
        setFileSize(size);
      } finally {
      }
    };
    fetchBookDetails();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book]);

  useEffect(() => {
    setDisplayBook(book);
    setBookTags(book.tags ?? []);
  }, [book]);

  const handleClose = () => {
    setBookMeta(null);
    setEditMode(false);
    onClose();
  };

  const handleEditMetadata = () => {
    setEditMode(true);
  };

  const handleCancelEdit = () => {
    resetToOriginal();
    setEditMode(false);
  };

  const handleSaveMetadata = () => {
    if (editedMeta && handleBookMetadataUpdate) {
      // The edit field keeps empty segments while typing; drop them and
      // dedupe on save.
      const savedTags = [...new Set(editedTags.map((tag) => tag.trim()).filter(Boolean))];
      setBookMeta({ ...editedMeta });
      setBookTags(savedTags);
      // Capture the updated book before handleBookMetadataUpdate clears the
      // temporary cover fields on editedMeta, so the view refreshes its cover.
      setDisplayBook(getBookWithUpdatedMetadata(book, editedMeta, savedTags));
      handleBookMetadataUpdate(book, editedMeta, savedTags);
      setEditMode(false);
    }
  };

  const handleBookExport = async () => {
    setIsLoading(true);
    setTimeout(async () => {
      const success = await appService?.exportBook(book);
      setIsLoading(false);
      eventDispatcher.dispatch('toast', {
        type: success ? 'info' : 'error',
        message: success ? _('Book exported successfully.') : _('Failed to export the book.'),
      });
    }, 0);
  };

  const handleRedownload = async () => {
    handleClose();
    if (handleBookDownload) {
      handleBookDownload(book, { redownload: true, queued: false });
    }
  };

  const handleReupload = async () => {
    handleClose();
    if (handleBookUpload) {
      handleBookUpload(book);
    }
  };

  return (
    <>
      <div className='fixed inset-0 z-50 flex items-center justify-center'>
        <Dialog
          title={editMode ? _('Edit Metadata') : _('Book Details')}
          isOpen={isOpen}
          onClose={handleClose}
          boxClassName={clsx(
            editMode ? 'sm:min-w-[600px] sm:max-w-[600px]' : 'sm:min-w-[480px] sm:max-w-[480px]',
            'sm:h-auto sm:max-h-[90%]',
          )}
          contentClassName='!px-6 !py-4'
        >
          <div className='flex w-full select-text items-start justify-center'>
            {editMode && bookMeta ? (
              <BookDetailEdit
                book={book}
                metadata={editedMeta}
                tags={editedTags}
                fieldSources={fieldSources}
                lockedFields={lockedFields}
                fieldErrors={fieldErrors}
                onFieldChange={handleFieldChange}
                onToggleFieldLock={handleToggleFieldLock}
                onLockAll={handleLockAll}
                onUnlockAll={handleUnlockAll}
                onCancel={handleCancelEdit}
                onReset={resetToOriginal}
                onSave={handleSaveMetadata}
              />
            ) : (
              <BookDetailView
                book={displayBook}
                metadata={bookMeta}
                fileSize={fileSize}
                onEdit={handleBookMetadataUpdate ? handleEditMetadata : undefined}
                onDownload={handleBookDownload ? handleRedownload : undefined}
                onUpload={handleBookUpload ? handleReupload : undefined}
                onExport={handleBookExport}
                onMetadataValueClick={onMetadataValueClick}
              />
            )}
          </div>
        </Dialog>

        {isLoading && (
          <div className='fixed inset-0 z-50 flex items-center justify-center'>
            <Spinner loading />
          </div>
        )}
      </div>
    </>
  );
};

export default BookDetailModal;
