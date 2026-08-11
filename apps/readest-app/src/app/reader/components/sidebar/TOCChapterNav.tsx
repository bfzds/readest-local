import clsx from 'clsx';
import React, { useCallback } from 'react';
import { useReaderStore } from '@/store/readerStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useTranslation } from '@/hooks/useTranslation';
import { viewPagination } from '../../hooks/usePagination';

const TOCChapterNav: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const getView = useReaderStore((s) => s.getView);
  const getViewSettings = useReaderStore((s) => s.getViewSettings);
  const getBookData = useBookDataStore((s) => s.getBookData);
  const progress = useBookProgress(bookKey);
  const bookData = getBookData(bookKey);

  const sectionCount = progress?.section?.total ?? bookData?.bookDoc?.sections?.length ?? 0;
  const currentIndex = progress?.index ?? -1;
  const canGoPrev = currentIndex > 0;
  const canGoNext = currentIndex >= 0 && currentIndex < sectionCount - 1;

  const handlePrev = useCallback(() => {
    viewPagination(getView(bookKey), getViewSettings(bookKey), 'up', 'section');
  }, [bookKey, getView, getViewSettings]);

  const handleNext = useCallback(() => {
    viewPagination(getView(bookKey), getViewSettings(bookKey), 'down', 'section');
  }, [bookKey, getView, getViewSettings]);

  if (sectionCount <= 0) return null;

  return (
    <div className='border-base-300/50 flex items-center gap-x-2 border-t px-2 py-2'>
      <button
        type='button'
        disabled={!canGoPrev}
        onClick={handlePrev}
        className={clsx(
          'btn btn-ghost h-8 min-h-8 shrink-0 px-2 text-sm',
          !canGoPrev && 'cursor-default opacity-50',
        )}
      >
        {_('Previous Chapter')}
      </button>
      <div
        className='min-w-0 flex-1 truncate px-1 text-center text-xs'
        title={progress?.sectionLabel}
      >
        {progress?.sectionLabel || ''}
      </div>
      <button
        type='button'
        disabled={!canGoNext}
        onClick={handleNext}
        className={clsx(
          'btn btn-ghost h-8 min-h-8 shrink-0 px-2 text-sm',
          !canGoNext && 'cursor-default opacity-50',
        )}
      >
        {_('Next Chapter')}
      </button>
    </div>
  );
};

export default TOCChapterNav;
