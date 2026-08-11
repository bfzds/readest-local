import clsx from 'clsx';
import React, { useCallback } from 'react';
import {
  RiArrowGoBackLine,
  RiArrowGoForwardLine,
  RiArrowLeftDoubleLine,
  RiArrowRightDoubleLine,
} from 'react-icons/ri';
import { useReaderStore } from '@/store/readerStore';
import { useTranslation } from '@/hooks/useTranslation';
import { viewPagination } from '../hooks/usePagination';
import { getNavigationIcon } from './footerbar/utils';

const ReaderNavFloatingButtons: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const { getView, getViewSettings } = useReaderStore();
  const view = getView(bookKey);
  const viewSettings = getViewSettings(bookKey);
  const showChapterNavigationButtons = viewSettings?.showChapterNavigationButtons;

  const handlePrevSection = useCallback(() => {
    viewPagination(view, viewSettings, 'left', 'section');
  }, [view, viewSettings]);

  const handleNextSection = useCallback(() => {
    viewPagination(view, viewSettings, 'right', 'section');
  }, [view, viewSettings]);

  const handleGoBack = useCallback(() => {
    view?.history.back();
  }, [view]);

  const handleGoForward = useCallback(() => {
    view?.history.forward();
  }, [view]);

  const buttonClass = clsx(
    'flex h-12 w-12 items-center justify-center rounded-full',
    'bg-base-100/90 text-base-content shadow-lg backdrop-blur-sm',
    'transition-transform active:scale-95',
    'disabled:pointer-events-none disabled:opacity-40',
  );

  return (
    <div className='absolute bottom-24 left-4 z-30 flex flex-col items-center gap-4 sm:bottom-16'>
      {showChapterNavigationButtons && (
        <>
          <button
            type='button'
            aria-label={_('Previous Section')}
            title={_('Previous Section')}
            onClick={handlePrevSection}
            className={buttonClass}
          >
            {getNavigationIcon(
              viewSettings?.rtl,
              <RiArrowLeftDoubleLine size={24} />,
              <RiArrowRightDoubleLine size={24} />,
            )}
          </button>
          <button
            type='button'
            aria-label={_('Next Section')}
            title={_('Next Section')}
            onClick={handleNextSection}
            className={buttonClass}
          >
            {getNavigationIcon(
              viewSettings?.rtl,
              <RiArrowRightDoubleLine size={24} />,
              <RiArrowLeftDoubleLine size={24} />,
            )}
          </button>
        </>
      )}
      <button
        type='button'
        aria-label={_('Go Back')}
        title={_('Go Back')}
        onClick={handleGoBack}
        disabled={!view?.history.canGoBack}
        className={buttonClass}
      >
        {getNavigationIcon(
          viewSettings?.rtl,
          <RiArrowGoBackLine size={24} />,
          <RiArrowGoForwardLine size={24} />,
        )}
      </button>
      <button
        type='button'
        aria-label={_('Go Forward')}
        title={_('Go Forward')}
        onClick={handleGoForward}
        disabled={!view?.history.canGoForward}
        className={buttonClass}
      >
        {getNavigationIcon(
          viewSettings?.rtl,
          <RiArrowGoForwardLine size={24} />,
          <RiArrowGoBackLine size={24} />,
        )}
      </button>
    </div>
  );
};

export default ReaderNavFloatingButtons;
