import clsx from 'clsx';
import React, { useState } from 'react';
import { Trans } from 'react-i18next';
import type { Insets } from '@/types/misc';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useBookDataStore } from '@/store/bookDataStore';
import { formatNumber, formatProgress, getReferencePageInfo } from '@/utils/progress';
import { footerInfoVisible, footerReservesBand } from '../utils/footerBand';
import StatusInfo from './StatusInfo.tsx';
import { convertPagesToTimeRemainingMinutes } from '@/app/library/utils/libraryUtils.ts';
import { useMedianPageDurationSecs } from '@/hooks/useMedianPageDurationSecs';

interface ProgressBarProps {
  bookKey: string;
  horizontalGap: number;
  contentInsets: Insets;
  gridInsets: Insets;
}

const ProgressBar: React.FC<ProgressBarProps> = ({
  bookKey,
  horizontalGap,
  contentInsets,
  gridInsets,
}) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const getBookData = useBookDataStore((s) => s.getBookData);
  const getViewSettings = useReaderStore((s) => s.getViewSettings);
  const getView = useReaderStore((s) => s.getView);
  const view = getView(bookKey);
  const bookData = getBookData(bookKey);
  const viewSettings = getViewSettings(bookKey)!;
  // Reactive: this is the on-screen footer that has to refresh on every
  // page turn. Reads from readerProgressStore only.
  const progress = useBookProgress(bookKey);
  const { section, pageinfo, sectionLabel } = progress || {};

  const showDoubleBorder = viewSettings.vertical && viewSettings.doubleBorder;
  const isVertical = viewSettings.vertical;
  const isEink = viewSettings.isEink;
  const { progressStyle: readingProgressStyle } = viewSettings;

  const template =
    readingProgressStyle === 'fraction'
      ? isVertical
        ? '{current} · {total}'
        : '{current} / {total}'
      : '{percent}%';

  const lang = localStorage?.getItem('i18nextLng') || '';
  const localize = isVertical && lang.toLowerCase().startsWith('zh');
  const pageInfo = bookData?.isFixedLayout ? section : pageinfo;
  const referenceInfo =
    readingProgressStyle === 'reference'
      ? getReferencePageInfo({
          pageList: bookData?.bookDoc?.pageList,
          pageItem: progress?.pageItem,
          fraction: pageInfo && pageInfo.total > 0 ? (pageInfo.current + 1) / pageInfo.total : 0,
          referencePageCount: viewSettings.referencePageCount,
        })
      : null;
  const progressInfo = referenceInfo
    ? `${referenceInfo.current}${isVertical ? ' · ' : ' / '}${referenceInfo.total}`
    : formatProgress(pageInfo?.current, pageInfo?.total, template, localize, lang);

  const { page: current = 0, pages: total = 0 } = view?.renderer || {};
  const pagesLeft = bookData?.isFixedLayout
    ? pageInfo
      ? Math.max(pageInfo.total - pageInfo.current, 1)
      : 0
    : Math.min(Math.max(total - current, 1), pageInfo ? pageInfo.total - pageInfo.current : total);
  const showPagesLeft = pagesLeft > 0 && (total > 0 || !!bookData?.isFixedLayout);
  const md5 = bookData?.book?.hash;
  const medianPageDurationSecs = useMedianPageDurationSecs(md5) ?? undefined;
  // Fixed-layout formats (CBZ, PDF) have no chapter structure — every page is
  // its own section — so the remaining count is the whole book, not a chapter.
  const remainingInBook = !!bookData?.isFixedLayout;
  const timeLeftStr = showPagesLeft
    ? remainingInBook
      ? _('{{time}} min left in book', {
          time: formatNumber(
            convertPagesToTimeRemainingMinutes(pagesLeft, medianPageDurationSecs),
            localize,
            lang,
          ),
        })
      : _('{{time}} min left in chapter', {
          time: formatNumber(
            convertPagesToTimeRemainingMinutes(pagesLeft, medianPageDurationSecs),
            localize,
            lang,
          ),
        })
    : '';
  const pagesLeftStr = showPagesLeft
    ? localize
      ? remainingInBook
        ? _('{{number}} pages left in book', {
            number: formatNumber(pagesLeft, localize, lang),
          })
        : _('{{number}} pages left in chapter', {
            number: formatNumber(pagesLeft, localize, lang),
          })
      : remainingInBook
        ? _('{{count}} pages left in book', {
            count: pagesLeft,
          })
        : _('{{count}} pages left in chapter', {
            count: pagesLeft,
          })
    : '';

  const hasRemainingInfo = viewSettings.showRemainingTime || viewSettings.showRemainingPages;
  const hasTimeInfo = viewSettings.showCurrentTime;
  const hasBatteryInfo = viewSettings.showCurrentBatteryStatus;

  // Tap to toggle (#5293): tapping the footer hides/shows the info without
  // touching layout or settings — the reserved band stays so the book text
  // never reflows, showFooter is never written, and the state resets when the
  // book reopens. The full-width container stays pointer-events-none so taps
  // and text selection over book content pass through; only the strip (or the
  // pills in scrolled mode, see below) is a tap target.
  const [dismissed, setDismissed] = useState(false);

  // Scrolled mode reserves a bottom band (footerReservesBand), so the footer
  // sits in its own strip below the text instead of floating over it. The
  // pills still keep each segment visually distinct; the strip is a tap
  // target only where it sits on reserved margin space (paginated band,
  // scrolled band, vertical side column).
  const hasFooterContent = footerInfoVisible(viewSettings) || !!sectionLabel;
  const stripTappable = hasFooterContent && (isVertical || footerReservesBand(viewSettings));
  const pillClass =
    viewSettings.scrolled &&
    !isVertical &&
    'progress-pill eink-bordered pointer-events-auto cursor-pointer rounded-md bg-base-100/85 px-1.5';
  const showStatusInfo = hasTimeInfo || hasBatteryInfo;

  return (
    <div
      role='presentation'
      className={clsx(
        'progressinfo pointer-events-none absolute bottom-0 z-10 flex items-center justify-between font-sans',
        isEink ? 'text-sm font-normal' : 'text-xs font-extralight',
        // The blend keeps the info legible over an unthemed fixed-layout page,
        // but it composites the whole container as a group -- with the pills on
        // it differences a white pill against the white page and paints it pure
        // black (#5342). The pill backdrop already guarantees legibility, so it
        // takes over from the blend whenever it is present.
        bookData?.isFixedLayout && !isEink && !pillClass
          ? 'text-white/75 mix-blend-difference'
          : 'text-base-content',
        isVertical ? 'writing-vertical-rl' : 'w-full',
      )}
      aria-label={[
        progress
          ? _('On {{current}} of {{total}} page', {
              current: current + 1,
              total: total,
            })
          : '',
        timeLeftStr,
        pagesLeftStr,
      ]
        .filter(Boolean)
        .join(', ')}
      style={
        isVertical
          ? {
              top: `${(contentInsets.top - gridInsets.top) * 1.5}px`,
              bottom: `${(contentInsets.bottom - gridInsets.bottom) * 1.5}px`,
              left: showDoubleBorder
                ? `calc(${contentInsets.left}px)`
                : `calc(${Math.max(0, contentInsets.left - 32)}px)`,
              width: showDoubleBorder ? '32px' : `${contentInsets.left}px`,
            }
          : {
              paddingInlineStart: `calc(${horizontalGap / 2}% + ${contentInsets.left / 2}px)`,
              paddingInlineEnd: `calc(${horizontalGap / 2}% + ${contentInsets.right / 2}px)`,
              paddingBottom: appService?.hasSafeAreaInset ? `${gridInsets.bottom * 0.33}px` : 0,
            }
      }
    >
      <div
        aria-hidden='true'
        onClick={hasFooterContent ? () => setDismissed((prev) => !prev) : undefined}
        className={clsx(
          'progress-strip flex items-center',
          stripTappable && 'pointer-events-auto cursor-pointer',
          dismissed && 'opacity-0',
          !isEink && 'transition-opacity duration-300',
          isVertical ? 'h-full' : 'w-full',
          'justify-between gap-x-2',
        )}
        style={isVertical ? {} : { height: `${viewSettings.marginBottomPx}px` }}
      >
        {!isVertical && sectionLabel && (
          <div
            data-testid='progress-section-label'
            className={clsx(
              'section-label min-w-0 text-start',
              // The pill backdrop belongs to the inner text span only; a
              // full-width flex child would paint a whole-row mask over the
              // page in scrolled mode. Cap the title so the pill stays
              // shrink-wrapped instead of swallowing the footer row.
              !pillClass && 'flex-1 truncate',
              pillClass && 'max-w-[min(55vw,36rem)]',
            )}
          >
            {pillClass ? (
              <span
                className={clsx('no-scrollbar block whitespace-nowrap overflow-x-auto', pillClass)}
                title={sectionLabel}
              >
                {sectionLabel}
              </span>
            ) : (
              sectionLabel
            )}
          </div>
        )}
        {hasRemainingInfo && (
          <div
            className={clsx('remaining-info text-start truncate', !pillClass && 'flex-1 min-w-0')}
          >
            {viewSettings.showRemainingTime ? (
              <span className={clsx('time-left-label text-start', pillClass)}>{timeLeftStr}</span>
            ) : viewSettings.showRemainingPages && showPagesLeft ? (
              <span className={clsx('text-start', pillClass)}>
                {localize ? (
                  remainingInBook ? (
                    <Trans
                      i18nKey='{{number}} pages left in book'
                      values={{ number: formatNumber(pagesLeft, localize, lang) }}
                    >
                      <span className='pages-left-number'>{'{{number}}'}</span>
                      <span className='pages-left-label'>{' pages left in book'}</span>
                    </Trans>
                  ) : (
                    <Trans
                      i18nKey='{{number}} pages left in chapter'
                      values={{ number: formatNumber(pagesLeft, localize, lang) }}
                    >
                      <span className='pages-left-number'>{'{{number}}'}</span>
                      <span className='pages-left-label'>{' pages left in chapter'}</span>
                    </Trans>
                  )
                ) : remainingInBook ? (
                  <Trans i18nKey='{{count}} pages left in book' count={pagesLeft}>
                    <span className='pages-left-number'>{'{{count}}'}</span>
                    <span className='pages-left-label'>{' pages left in book'}</span>
                  </Trans>
                ) : (
                  <Trans i18nKey='{{count}} pages left in chapter' count={pagesLeft}>
                    <span className='pages-left-number'>{'{{count}}'}</span>
                    <span className='pages-left-label'>{' pages left in chapter'}</span>
                  </Trans>
                )}
              </span>
            ) : null}
          </div>
        )}

        {showStatusInfo && (
          <StatusInfo
            showTime={hasTimeInfo}
            use24Hour={viewSettings.use24HourClock}
            showBattery={hasBatteryInfo}
            showBatteryPercentage={viewSettings.showBatteryPercentage}
            isVertical={isVertical}
            isEink={isEink}
            className={pillClass || undefined}
          />
        )}

        <div
          className={clsx(
            'progress-info items-center text-end tabular-nums truncate',
            !pillClass && 'flex-1 min-w-0',
          )}
        >
          {viewSettings.showProgressInfo && (
            <span
              className={clsx(
                'progress-info-label text-end',
                isVertical ? 'mt-auto' : 'ms-auto',
                pillClass,
              )}
            >
              {progressInfo}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export default ProgressBar;
