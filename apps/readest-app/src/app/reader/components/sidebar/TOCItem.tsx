import clsx from 'clsx';
import React, { useCallback } from 'react';
import { FiBookOpen } from 'react-icons/fi';
import { TOCItem } from '@/libs/document';
import { isVirtualTocItem, isWholeBookTocItem } from '@/services/virtualToc/apply';
import { getContentMd5 } from '@/utils/misc';

const createExpanderIcon = (isExpanded: boolean) => {
  return (
    <svg
      viewBox='0 0 8 10'
      width='8'
      height='10'
      className={clsx(
        'text-base-content transform transition-transform',
        isExpanded ? 'rotate-90' : 'rotate-0',
      )}
      style={{ transformOrigin: 'center' }}
      fill='currentColor'
      aria-hidden='true'
      focusable='false'
    >
      <polygon points='0 0, 8 5, 0 10' />
    </svg>
  );
};

export interface FlatTOCItem {
  item: TOCItem;
  depth: number;
  index: number;
  isExpanded?: boolean;
}

/** location 区间的稳定标识（字符串，可直接进 React.memo 的 props）。 */
export const tocLocationKey = (location: TOCItem['location']): string | null =>
  location ? `${location.current}:${location.next}` : null;

/**
 * 虚拟条目的当前章节：按 location 区间判定。
 *
 * 虚拟条目的 href 是 CFI 串，而 `progress.sectionHref` 是 section 路径
 * （形如 `OEBPS/page-0.html`）→ href 相等永不成立，书本图标永远不出现。
 * `progress.fraction` 是全书 0..1 的 reading position，与 location 的
 * size-domain 同源（见 types/book.ts），所以 `round(fraction × total)` 落在
 * 条目的 `[current, next)` 里就是当前章节。total 从任意带 location 的虚拟条目取
 * （同一次生成的所有条目 total 相同）。
 *
 * **只对虚拟条目做区间匹配**：合并时真实条目被前置，nav 管线又给它们写了
 * `section.location`（样本书那几条无锚点条目的 href 就是 section href）→ 其区间
 * 覆盖整块 slab（如 `0:178`）。若在全表上 find，阅读位置一进 slab 就先命中真实
 * 条目、返回它的 key，虚拟条目永远拿不到自己的 key——C 要修的症状会原样保留。
 * 真实条目仍由 `isActiveTocItem` 的 href 相等那条路负责。
 *
 * 返回的是 location 区间 key（而不是条目对象）——`TOCItemView` 是 React.memo，
 * props 必须是值稳定的原始类型，否则每渲染都会失效。
 */
export const findActiveLocationKey = (
  items: ReadonlyArray<TOCItem>,
  fraction: number | null | undefined,
): string | null => {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return null;
  const virtual = items.filter(isVirtualTocItem);
  const total = virtual.find((item) => item.location?.total)?.location?.total;
  if (!total) return null;
  const currentLoc = Math.round(fraction * total);
  const active = virtual.find(
    (item) =>
      item.location && currentLoc >= item.location.current && currentLoc < item.location.next,
  );
  return active ? tocLocationKey(active.location) : null;
};

/** 真实条目按 href 相等判定（行为不变）；虚拟条目按 location 区间判定。
 *  两边都要判非空：没有 location 的条目 key 也是 null，只比相等会把无 location
 *  的真实条目全部点亮；判 isVirtualTocItem 是为了让**真实的**结构条目（在退化
 *  nav 里同样带 location）保留原 href 语义，不被区间判定顺带点亮。
 *  全书级条目（isWholeBookTocItem）从 href 分支排除：单 section 书里 foliate 的
 *  tocProgress 恒命中书名条目，若按 href 相等点亮它会永久高亮；这类条目没有章节
 *  粒度，只显示在列表里、永不参与「当前章节」高亮。 */
const isActiveTocItem = (
  item: TOCItem,
  activeHref: string | null,
  activeLocationKey: string | null,
): boolean => {
  if (activeHref && activeHref === item.href && !isWholeBookTocItem(item)) return true;
  if (!isVirtualTocItem(item)) return false;
  const key = tocLocationKey(item.location);
  return !!key && key === activeLocationKey;
};

const TOCItemView = React.memo<{
  bookKey: string;
  flatItem: FlatTOCItem;
  itemSize?: number;
  isActive: boolean;
  onToggleExpand: (item: TOCItem) => void;
  onItemClick: (item: TOCItem) => void;
}>(({ flatItem, itemSize, isActive, onToggleExpand, onItemClick }) => {
  const { item, depth } = flatItem;

  const pageNumber = item.location
    ? item.location.current + 1
    : item.index !== undefined
      ? item.index + 1
      : null;
  const ariaLabel = item.label
    ? pageNumber !== null
      ? `${item.label}, ${pageNumber}`
      : item.label
    : undefined;

  const handleToggleExpand = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onToggleExpand(item);
    },
    [item, onToggleExpand],
  );

  const handleClickItem = useCallback(
    (event: React.MouseEvent | React.KeyboardEvent) => {
      event.preventDefault();
      onItemClick(item);
    },
    [item, onItemClick],
  );

  return (
    <div
      tabIndex={0}
      role='treeitem'
      onClick={item.href ? handleClickItem : undefined}
      onKeyDown={item.href ? (e) => e.key === 'Enter' && handleClickItem(e) : undefined}
      aria-label={ariaLabel}
      aria-current={isActive ? 'page' : undefined}
      aria-expanded={item.subitems?.length ? (flatItem.isExpanded ? 'true' : 'false') : undefined}
      aria-selected={isActive ? 'true' : 'false'}
      data-href={item.href ? getContentMd5(item.href) : undefined}
      className={clsx(
        'flex w-full cursor-pointer items-center rounded-md py-4 sm:py-2 sm:hover:bg-base-300/75',
      )}
      style={{
        height: itemSize ? `${itemSize}px` : 'auto',
        paddingInlineStart: `${(depth + 1) * 12}px`,
      }}
    >
      {!!item.subitems?.length && (
        <button
          onClick={handleToggleExpand}
          onKeyDown={(e) => {
            e.stopPropagation();
          }}
          aria-label={flatItem.isExpanded ? `Collapse ${item.label}` : `Expand ${item.label}`}
          className='inline-block cursor-pointer'
          style={{
            padding: '12px',
            margin: '-12px',
          }}
        >
          {createExpanderIcon(flatItem.isExpanded || false)}
        </button>
      )}
      {isActive && (
        <FiBookOpen aria-hidden='true' className='text-base-content/70 ms-2 h-3.5 w-3.5 shrink-0' />
      )}
      <div className='ms-2 min-w-0 break-words'>{item.label}</div>
      {(item.location || item.index !== undefined) && (
        <div
          aria-hidden='true'
          className='text-base-content/50 ms-auto shrink-0 ps-1 text-xs sm:pe-1'
        >
          {item.location ? item.location.current + 1 : item.index + 1}
        </div>
      )}
    </div>
  );
});

TOCItemView.displayName = 'TOCItemView';

interface ListRowProps {
  bookKey: string;
  flatItem: FlatTOCItem;
  itemSize?: number;
  activeHref: string | null;
  activeLocationKey: string | null;
  onToggleExpand: (item: TOCItem) => void;
  onItemClick: (item: TOCItem) => void;
}

export const StaticListRow: React.FC<ListRowProps> = ({
  bookKey,
  flatItem,
  itemSize,
  activeHref,
  activeLocationKey,
  onToggleExpand,
  onItemClick,
}) => {
  const isActive = isActiveTocItem(flatItem.item, activeHref, activeLocationKey);

  return (
    <div
      className={clsx(
        'border-base-300 w-full border-b sm:border-none',
        'pe-4 ps-2 pt-[1px] sm:pe-2',
      )}
      title={flatItem.item.label || ''}
    >
      <TOCItemView
        bookKey={bookKey}
        flatItem={flatItem}
        itemSize={itemSize}
        isActive={isActive}
        onToggleExpand={onToggleExpand}
        onItemClick={onItemClick}
      />
    </div>
  );
};
