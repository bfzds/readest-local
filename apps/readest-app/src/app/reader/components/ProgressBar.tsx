import clsx from 'clsx';
import React, { useEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import type { Insets } from '@/types/misc';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useBookDataStore } from '@/store/bookDataStore';
import { formatNumber, formatProgress, getReferencePageInfo } from '@/utils/progress';
import { footerInfoVisible, footerReservesBand } from '../utils/footerBand';
import { createScrubThrottle, fractionToPageIndex, xToFraction } from '../utils/progressScrub';
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

  // --- Scrub-to-jump on the footer strip (horizontal layouts only) ---
  // Dragging the strip calls view.goToFraction with the pointer's fraction:
  // the only fraction-jump entry left on desktop after the hover toolbar was
  // removed. Hover gives just a resize cursor; the page bubble appears only
  // once the 8px threshold turns the press into a real drag, and Escape
  // restores the pre-drag position.
  //
  // Per-move visual updates (bubble position, bubble text, handle position)
  // are written STRAIGHT TO THE DOM via refs: a React setState per pointermove
  // re-renders the whole footer per event and is the jank source. Browsers
  // already coalesce pointermove to frame rate, so per-event DOM writes are
  // frame-aligned without an extra rAF layer. React state only gates mount
  // (bubble) / visibility (handle); the view jump itself is throttled and
  // skipped while the fraction stays within the same page, so relocations
  // happen only when they change something.
  const [scrubActive, setScrubActive] = useState(false);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const bubbleLabelRef = useRef<HTMLSpanElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const fillWidthRef = useRef(0);
  const fillLeftRef = useRef(0);
  // Pointer fraction while a scrub is in flight: the rendered style reads this
  // during re-renders so React and the ref writes agree on the same position.
  const scrubFractionRef = useRef(0);
  const scrubStateRef = useRef<{
    startX: number;
    startY: number;
    active: boolean;
    originFraction: number;
    fraction: number;
    rect: { left: number; width: number };
  } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const scrubLabelRef = useRef<(fraction: number) => string>(() => '');
  scrubLabelRef.current = (fraction) => {
    if (!pageInfo || pageInfo.total <= 0) return '';
    return formatProgress(
      fractionToPageIndex(fraction, pageInfo.total),
      pageInfo.total,
      template,
      localize,
      lang,
    );
  };
  const goToFractionRef = useRef((fraction: number) => {
    viewRef.current?.goToFraction(fraction);
  });
  const rtlRef = useRef(!!viewSettings.rtl);
  rtlRef.current = !!viewSettings.rtl;
  const handleLeftOfFractionRef = useRef((fraction: number) =>
    rtlRef.current ? (1 - fraction) * 100 : fraction * 100,
  );
  // Mirror of the idle handle position, so a cancelled drag can put the
  // handle back where React's style prop last placed it.
  const handleLeftRef = useRef(0);
  const lastScrubFractionRef = useRef(-1);
  const scrubThrottleRef = useRef<ReturnType<typeof createScrubThrottle> | null>(null);
  if (!scrubThrottleRef.current) {
    scrubThrottleRef.current = createScrubThrottle(
      (fraction) => goToFractionRef.current(fraction),
      80,
    );
  }

  const scrubEnabled = !isVertical && !!view?.goToFraction && !!pageInfo && pageInfo.total > 0;
  // A drag that starts and ends on the full-width strip makes the browser fire
  // a click on release — which would toggle the #5293 dismissed state and hide
  // the footer info after every scrub. Swallow that one click.
  const suppressClickRef = useRef(false);
  // Visual layer: hairline always on, expanding to a track on hover. Purely
  // decorative — pointer-events-none.
  const [scrubHovered, setScrubHovered] = useState(false);

  useEffect(() => {
    const DRAG_THRESHOLD = 8;
    const BUBBLE_MARGIN = 60;
    // Fractions within 0.1% of the last applied one can't move the view to a
    // different page — skip the relocation entirely.
    const FRACTION_EPSILON = 0.001;

    const clearScrub = () => {
      scrubStateRef.current = null;
      scrubThrottleRef.current?.cancel();
      setScrubActive(false);
      // The handle and fill stay mounted: undo our direct style writes so
      // React's style props (the idle progress geometry) show through again.
      if (handleRef.current) {
        handleRef.current.style.left = `${handleLeftRef.current}%`;
      }
      if (fillRef.current) {
        fillRef.current.style.width = `${fillWidthRef.current}%`;
        fillRef.current.style.left = fillLeftRef.current === 0 ? '0' : `${fillLeftRef.current}%`;
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      const state = scrubStateRef.current;
      if (!state) return;
      if (!state.active) {
        const dx = e.clientX - state.startX;
        const dy = e.clientY - state.startY;
        if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
        state.active = true;
        lastScrubFractionRef.current = state.originFraction;
        setScrubActive(true); // mounts the bubble, shows the handle
        e.preventDefault(); // hold off text selection once the drag is real
      }
      const raw = xToFraction(e.clientX, state.rect.left, state.rect.width);
      state.fraction = rtlRef.current ? 1 - raw : raw;
      scrubFractionRef.current = state.fraction;

      // Frame-aligned DOM writes — no React render per pointermove.
      const innerWidth = typeof window !== 'undefined' ? window.innerWidth : e.clientX;
      const clampedX = Math.min(
        Math.max(e.clientX, BUBBLE_MARGIN),
        Math.max(innerWidth - BUBBLE_MARGIN, BUBBLE_MARGIN),
      );
      if (bubbleRef.current) {
        bubbleRef.current.style.left = `${clampedX}px`;
      }
      if (bubbleLabelRef.current) {
        bubbleLabelRef.current.textContent = scrubLabelRef.current(state.fraction);
      }
      if (handleRef.current) {
        handleRef.current.style.left = `${handleLeftOfFractionRef.current(state.fraction)}%`;
      }
      // The fill rides WITH the pointer during a scrub (standard scrub
      // behavior): if it stayed on the view's applied position it would trail
      // the handle behind on fast drags — the "ghosting" artifact.
      if (fillRef.current) {
        const fillPct = handleLeftOfFractionRef.current(state.fraction);
        fillRef.current.style.width = `${rtlRef.current ? 100 - fillPct : fillPct}%`;
        fillRef.current.style.left = rtlRef.current ? `${fillPct}%` : '0';
      }

      if (Math.abs(state.fraction - lastScrubFractionRef.current) > FRACTION_EPSILON) {
        lastScrubFractionRef.current = state.fraction;
        scrubThrottleRef.current?.call(state.fraction);
      }
    };

    const restoreOrigin = () => {
      const state = scrubStateRef.current;
      if (state?.active) {
        suppressClickRef.current = true;
        lastScrubFractionRef.current = state.originFraction;
        goToFractionRef.current(state.originFraction);
      }
      clearScrub();
    };

    const onPointerUp = (e: PointerEvent) => {
      const state = scrubStateRef.current;
      if (!state) return;
      if (state.active) {
        suppressClickRef.current = true;
        const raw = xToFraction(e.clientX, state.rect.left, state.rect.width);
        state.fraction = rtlRef.current ? 1 - raw : raw;
        scrubThrottleRef.current?.cancel();
        goToFractionRef.current(state.fraction);
      }
      clearScrub();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && scrubStateRef.current) {
        restoreOrigin();
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', restoreOrigin);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', restoreOrigin);
      window.removeEventListener('keydown', onKeyDown);
      scrubThrottleRef.current?.cancel();
    };
  }, []);

  const onStripPointerDown = (e: React.PointerEvent) => {
    // A fresh press always re-arms the click: the suppression flag only lives
    // for the click that immediately follows a real scrub release (and if that
    // release happened off-strip, no click fires — clear it here instead of
    // swallowing the user's next genuine tap).
    suppressClickRef.current = false;
    if (!scrubEnabled || e.button !== 0) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    scrubStateRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      originFraction: (pageInfo.current + 1) / pageInfo.total,
      fraction: (pageInfo.current + 1) / pageInfo.total,
      rect: { left: rect.left, width: rect.width },
    };
  };

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

  // Scrub visual layer geometry: the fill/handle must match the drag mapping,
  // which measures x against the strip's own rect (RTL inverts the direction).
  //
  // While a scrub is active the rendered style must come from the POINTER
  // fraction, not the view's applied position: every throttled relocation
  // updates the progress store and re-renders this component, and a
  // view-position style prop would clobber our ref-written pointer-following
  // geometry mid-drag — the visible "ghosting" where the fill/handle snap
  // backward on every relocation.
  const trackFraction =
    pageInfo && pageInfo.total > 0 ? (pageInfo.current + 1) / pageInfo.total : 0;
  const renderFraction = scrubActive ? scrubFractionRef.current : trackFraction;
  const trackActive = scrubHovered || scrubActive;
  // Idle geometry (view position) — the refs mirror it so a cancelled or
  // finished scrub can reset the direct-written styles back to it.
  const idleHandleLeft = viewSettings.rtl ? (1 - trackFraction) * 100 : trackFraction * 100;
  handleLeftRef.current = idleHandleLeft;
  fillWidthRef.current = trackFraction * 100;
  fillLeftRef.current = viewSettings.rtl ? (1 - trackFraction) * 100 : 0;
  // Rendered geometry — pointer position while scrubbing, view position idle.
  const trackHandleLeft = viewSettings.rtl ? (1 - renderFraction) * 100 : renderFraction * 100;
  const trackFillLeft = viewSettings.rtl ? `${(1 - renderFraction) * 100}%` : 0;
  const trackFillWidth = renderFraction * 100;

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
        data-testid='progress-strip'
        onClick={
          stripTappable
            ? () => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                setDismissed((prev) => !prev);
              }
            : undefined
        }
        onPointerDown={onStripPointerDown}
        onMouseEnter={() => setScrubHovered(true)}
        onMouseLeave={() => setScrubHovered(false)}
        className={clsx(
          'progress-strip relative flex items-center',
          stripTappable && 'pointer-events-auto cursor-pointer',
          // Scrubbing needs the strip to receive pointer events even where
          // #5293 tap-toggle does not apply (desktop paginated mode).
          scrubEnabled && !stripTappable && 'pointer-events-auto cursor-ew-resize',
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
        {/* Hairline progress indicator along the bottom of the strip:
            always visible at 1px for static position sense, expands to a
            track on hover / while scrubbing. Raised 4px off the strip's
            bottom edge so the BooksGrid overflow-hidden cannot clip it and
            it does not glue to the window bezel. The handle appears only
            while actively scrubbing (an opaque dot parked over the text on
            mere hover reads as broken footer info). Decorative only — the
            whole strip remains the drag surface, and it fades with the
            dismissed state like the rest of the footer info. */}
        {!isVertical && (
          <div
            data-testid='progress-track'
            aria-hidden='true'
            className='pointer-events-none absolute inset-x-0 bottom-1'
          >
            <div
              className={clsx(
                'relative w-full bg-base-content/15',
                trackActive ? 'h-[3px]' : 'h-px',
                !isEink && 'transition-[height] duration-200',
              )}
            >
              <div
                ref={fillRef}
                className='absolute bottom-0 top-0 bg-base-content/35'
                style={{ width: `${trackFillWidth}%`, left: trackFillLeft }}
              />
              <div
                ref={handleRef}
                className={clsx(
                  'absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-base-content/70',
                  scrubActive ? 'opacity-100' : 'opacity-0',
                  !isEink && 'transition-opacity duration-200',
                )}
                style={{ left: `${trackHandleLeft}%` }}
              />
            </div>
          </div>
        )}
      </div>
      {/* Scrub position bubble: outside the aria-hidden strip so the live
          region actually announces; fixed-positioned, pointer-transparent.
          Mount/unmount is state-driven, but position and text are written
          straight to the DOM per pointermove (see the scrub effect above). */}
      {!isVertical && scrubActive && (
        <div
          ref={bubbleRef}
          role='status'
          aria-live='polite'
          className='pointer-events-none z-20 -translate-x-1/2 whitespace-nowrap rounded-md px-2 py-1 text-xs shadow-md eink-bordered bg-base-100/95 text-base-content'
          style={{ position: 'fixed', left: '50%', bottom: 56 }}
        >
          <span ref={bubbleLabelRef} />
        </div>
      )}
    </div>
  );
};

export default ProgressBar;
