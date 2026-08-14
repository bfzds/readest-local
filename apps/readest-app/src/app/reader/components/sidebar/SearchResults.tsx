import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BookSearchMatch, BookSearchResult, SearchExcerpt } from '@/types/book';
import { useReaderStore } from '@/store/readerStore';
import { useSidebarStore } from '@/store/sidebarStore';
import { useTranslation } from '@/hooks/useTranslation';
import { findNearestCfi } from '@/utils/cfi';
import useScrollToItem from '../../hooks/useScrollToItem';
import clsx from 'clsx';

interface SearchResultItemProps {
  bookKey: string;
  cfi: string;
  excerpt: SearchExcerpt;
  isNearest?: boolean;
  onSelectResult: (cfi: string) => void;
}

// The excerpt stores ~50 chars of context per side, but the sidebar row clamps
// to three lines — clip both lead-in and tail so the match itself stays
// prominent instead of being buried in long context.
const PRE_DISPLAY_LIMIT = 10;
const clipPre = (pre: string) => {
  const points = Array.from(pre);
  return points.length > PRE_DISPLAY_LIMIT ? `…${points.slice(-PRE_DISPLAY_LIMIT).join('')}` : pre;
};
const clipPost = (post: string) => {
  const points = Array.from(post);
  return points.length > PRE_DISPLAY_LIMIT
    ? `${points.slice(0, PRE_DISPLAY_LIMIT).join('')}…`
    : post;
};

// Context (pre/post) rendered in the body color, same size as the match —
// the preview reads like a plain-text excerpt; the match carries the overlay.
const ContextSpan: React.FC<{ children: string }> = ({ children }) => (
  <span className='text-base-content'>{children}</span>
);

// Match term: the same amber overlay as in the body (--search-highlight-color,
// theme-adaptive), text keeps the body color and is bolded. boxDecorationBreak:
// clone makes every wrapped line carry its own background like a highlighter.
const MatchHighlight: React.FC<{ children: string }> = ({ children }) => (
  <span
    className='font-medium'
    style={{
      backgroundColor: 'color-mix(in srgb, var(--search-highlight-color) 45%, transparent)',
      borderRadius: '2px',
      boxDecorationBreak: 'clone',
      WebkitBoxDecorationBreak: 'clone',
    }}
  >
    {children}
  </span>
);

// nearby-words excerpts emphasize each matched word; other modes bold the single match span.
const ExcerptBody: React.FC<{ excerpt: SearchExcerpt }> = ({ excerpt }) => {
  if (excerpt.segments) {
    return (
      <>
        <ContextSpan>{clipPre(excerpt.pre)}</ContextSpan>
        {excerpt.segments.map((seg, i) =>
          seg.emphasized ? (
            <MatchHighlight key={i}>{seg.text}</MatchHighlight>
          ) : (
            <span key={i}>{seg.text}</span>
          ),
        )}
        <ContextSpan>{clipPost(excerpt.post)}</ContextSpan>
      </>
    );
  }
  return (
    <>
      <ContextSpan>{clipPre(excerpt.pre)}</ContextSpan>
      <MatchHighlight>{excerpt.match}</MatchHighlight>
      <ContextSpan>{clipPost(excerpt.post)}</ContextSpan>
    </>
  );
};

const SearchResultItem: React.FC<SearchResultItemProps> = ({
  bookKey,
  cfi,
  excerpt,
  isNearest,
  onSelectResult,
}) => {
  const { getProgress } = useReaderStore();
  const progress = getProgress(bookKey)!;
  const { isCurrent, viewRef } = useScrollToItem(cfi, progress, isNearest);

  return (
    <li
      // eslint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role
      role='button'
      ref={viewRef}
      className={clsx(
        'my-2 cursor-pointer rounded-lg p-2 text-[clamp(0.9rem,4.2cqw,1.2rem)]',
        isCurrent ? 'bg-base-300 hover:bg-gray-300/70' : 'hover:bg-base-300 bg-base-100',
      )}
      tabIndex={0}
      onClick={() => onSelectResult(cfi)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          onSelectResult(cfi);
        } else {
          e.stopPropagation();
        }
      }}
    >
      <div className='line-clamp-3'>
        <ExcerptBody excerpt={excerpt} />
      </div>
    </li>
  );
};

interface ChapterSectionProps {
  bookKey: string;
  label: string;
  subitems: BookSearchMatch[];
  nearestCfi: string | null;
  isExpanded: boolean;
  onToggle: () => void;
  onSelectResult: (cfi: string) => void;
}

const ChapterSection: React.FC<ChapterSectionProps> = ({
  bookKey,
  label,
  subitems,
  nearestCfi,
  isExpanded,
  onToggle,
  onSelectResult,
}) => {
  const matchCount = subitems.length;
  const headerRef = useRef<HTMLHeadingElement>(null);
  const wasStuckRef = useRef<boolean>(false);

  const handleToggle = useCallback(() => {
    if (isExpanded && headerRef.current) {
      const header = headerRef.current;
      const container = header.closest('.search-results') as HTMLElement | null;
      if (container) {
        // Detect if the header is currently stuck at the top of the scroll container.
        // Compare visual positions (getBoundingClientRect) rather than offsetTop,
        // because sticky stacking can offset the header from the container's top.
        const headerRect = header.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        wasStuckRef.current = headerRect.top <= containerRect.top + 1;
      }
    }
    onToggle();
  }, [isExpanded, onToggle]);

  // useLayoutEffect runs synchronously after DOM mutations but before paint,
  // avoiding a visible flash when we adjust scroll position.
  useLayoutEffect(() => {
    if (isExpanded) return;
    if (!wasStuckRef.current) return;
    const header = headerRef.current;
    if (!header) return;
    const container = header.closest('.search-results') as HTMLElement | null;
    if (!container) return;
    // Recalculate the header's position after the collapse (DOM has already
    // updated) and scroll so the collapsed header sits at the top of the viewport.
    const headerRect = header.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const headerOffset = headerRect.top - containerRect.top + container.scrollTop;
    container.scrollTop = headerOffset;
  }, [isExpanded]);

  return (
    <ul>
      {/* The sticky band carries the surface color so results scrolling underneath
          stay occluded; the button inside owns the hover and focus affordances. */}
      <h3
        ref={headerRef}
        className='not-eink:bg-base-200 eink:bg-base-100 sticky top-0 z-10 font-normal'
      >
        <button
          type='button'
          className='not-eink:hover:bg-base-300 focus-visible:ring-base-content/15 flex w-full select-none items-center justify-between rounded px-1 py-1 text-start focus-visible:outline-none focus-visible:ring-2'
          onClick={handleToggle}
          aria-expanded={isExpanded}
        >
          <span className='flex min-w-0 items-center gap-1.5'>
            <svg
              viewBox='0 0 8 10'
              width='8'
              height='10'
              className={clsx(
                'text-base-content not-eink:transition-transform shrink-0',
                isExpanded ? 'rotate-90' : 'rotate-0',
              )}
              style={{ transformOrigin: 'center' }}
              fill='currentColor'
              aria-hidden='true'
              focusable='false'
            >
              <polygon points='0 0, 8 5, 0 10' />
            </svg>
            <span className='truncate'>{label}</span>
          </span>
          <span className='text-base-content/60 ms-2 shrink-0 whitespace-nowrap text-xs'>
            {matchCount}
          </span>
        </button>
      </h3>
      {isExpanded && (
        <ul>
          {subitems.map((item, index) => (
            <SearchResultItem
              key={`${index}-${item.cfi}`}
              bookKey={bookKey}
              cfi={item.cfi}
              excerpt={item.excerpt}
              isNearest={item.cfi === nearestCfi}
              onSelectResult={onSelectResult}
            />
          ))}
        </ul>
      )}
    </ul>
  );
};

interface SearchResultsProps {
  bookKey: string;
  results: BookSearchResult[] | BookSearchMatch[];
  onSelectResult: (cfi: string) => void;
}

const SearchResults: React.FC<SearchResultsProps> = ({ bookKey, results, onSelectResult }) => {
  const _ = useTranslation();
  const { getProgress } = useReaderStore();
  const { getSearchNavState } = useSidebarStore();
  const progress = getProgress(bookKey);
  const { searchProgress, searchError } = getSearchNavState(bookKey);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set());

  // Starting a search resets progress to 0 while the previous results stay
  // mounted until the first new hit arrives. Sections are keyed by index+label,
  // so a reused key would otherwise come back collapsed for results the reader
  // has never seen.
  useEffect(() => {
    if (searchProgress === 0) setCollapsedSections(new Set());
  }, [searchProgress]);

  const toggleSection = useCallback((sectionKey: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (!next.delete(sectionKey)) next.add(sectionKey);
      return next;
    });
  }, []);

  const nearestCfi = useMemo(() => {
    const allCfis: string[] = [];
    for (const result of results) {
      if ('subitems' in result) {
        for (const item of result.subitems) allCfis.push(item.cfi);
      } else {
        allCfis.push(result.cfi);
      }
    }
    return findNearestCfi(allCfis, progress?.location);
  }, [progress?.location, results]);

  const totalMatches = useMemo(
    () =>
      results.reduce((sum, result) => sum + ('subitems' in result ? result.subitems.length : 1), 0),
    [results],
  );

  // The error itself is surfaced in the search bar; once the search has finished
  // with no hits, say so instead of leaving a blank panel.
  if (results.length === 0) {
    if (searchError || searchProgress < 1) return null;
    return (
      <div className='search-results text-base-content/60 p-4 text-center text-sm'>
        {_('No results found')}
      </div>
    );
  }

  return (
    <div className='search-results @container overflow-y-auto px-2 font-sans text-sm font-light'>
      <ul className='px-2'>
        {results.map((result, index) => {
          if ('subitems' in result) {
            const sectionKey = `${index}-${result.label}`;
            return (
              <ChapterSection
                key={sectionKey}
                bookKey={bookKey}
                label={result.label}
                subitems={result.subitems}
                nearestCfi={nearestCfi}
                isExpanded={!collapsedSections.has(sectionKey)}
                onToggle={() => toggleSection(sectionKey)}
                onSelectResult={onSelectResult}
              />
            );
          } else {
            return (
              <SearchResultItem
                key={`${index}-${result.cfi}`}
                bookKey={bookKey}
                cfi={result.cfi}
                excerpt={result.excerpt}
                isNearest={result.cfi === nearestCfi}
                onSelectResult={onSelectResult}
              />
            );
          }
        })}
      </ul>
      {searchProgress >= 1 && (
        <div className='text-base-content/60 px-2 py-2 text-center text-xs'>
          {_('{{count}} results', { count: totalMatches })}
        </div>
      )}
    </div>
  );
};

export default SearchResults;
