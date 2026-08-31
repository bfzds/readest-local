'use client';

import clsx from 'clsx';
import React, { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { FiSearch } from 'react-icons/fi';
import { MdClose } from 'react-icons/md';
import { useTranslation } from '@/hooks/useTranslation';
import { useCommandPalette } from './CommandPaletteProvider';
import { CommandSearchResult, getCategoryLabel, CommandCategory } from '@/services/commandRegistry';
import HighlightChars from './HighlightChars';

const CommandPalette: React.FC = () => {
  const _ = useTranslation();
  const { isOpen, close, query, setQuery, results, groupedResults, recentItems, executeCommand } =
    useCommandPalette();

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  // flatten results for keyboard navigation
  const flattenedResults = useMemo(() => {
    if (query.trim()) {
      return results;
    }
    // show recent items when no query
    return recentItems.map((item) => ({
      item,
      score: 0,
      positions: new Set<number>(),
      highlightIndices: new Set<number>(),
    }));
  }, [query, results, recentItems]);

  // reset selection when results change - legitimate derived state reset
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting UI state on data change is intended
    setSelectedIndex(0);
  }, [flattenedResults.length]);

  // focus input and reset selection on open
  useEffect(() => {
    if (isOpen) {
      previousActiveElementRef.current = document.activeElement as HTMLElement;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting UI state on modal open is intended
      setSelectedIndex(0);
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    } else {
      if (previousActiveElementRef.current) {
        previousActiveElementRef.current.focus();
        previousActiveElementRef.current = null;
      }
    }
  }, [isOpen]);

  // scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selectedItem = listRef.current.querySelector('[data-selected="true"]');
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // The palette traps its own keyboard navigation. Without this, once the
      // input loses focus (e.g. after clicking a result) arrow keys and Enter
      // bubble to the window-level shortcut handler and move the page below.
      e.stopPropagation();
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, flattenedResults.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          {
            const selected = flattenedResults[selectedIndex];
            if (selected) {
              executeCommand(selected.item);
            }
          }
          break;
        case 'Escape':
          e.preventDefault();
          close();
          break;
        case 'w':
          // Ctrl/Cmd+W closes the palette (like Esc) instead of the whole
          // window — the palette traps global shortcuts while open.
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            close();
          }
          break;
        case 'Tab': {
          // 焦点陷阱（Task7）：Tab/Shift+Tab 在 input、clear 与结果按钮之间
          // 循环移动真实 DOM 焦点；当落点是结果项时同步 selectedIndex 高亮。
          e.preventDefault();
          const list = listRef.current;
          const input = inputRef.current;
          const options = list
            ? Array.from(list.querySelectorAll<HTMLButtonElement>('button[role="option"]'))
            : [];
          const clearBtn =
            list?.parentElement?.querySelector<HTMLButtonElement>('button[aria-label]');
          const focusables: HTMLElement[] = [];
          if (input) focusables.push(input);
          if (clearBtn && query) focusables.push(clearBtn);
          focusables.push(...options);
          if (focusables.length === 0) break;
          const active = document.activeElement as HTMLElement | null;
          const idx = active ? focusables.indexOf(active) : -1;
          const next = e.shiftKey
            ? idx <= 0
              ? focusables.length - 1
              : idx - 1
            : idx >= focusables.length - 1
              ? 0
              : idx + 1;
          focusables[next]?.focus();
          const optionFocus = options.indexOf(focusables[next] as HTMLButtonElement);
          if (optionFocus >= 0) setSelectedIndex(optionFocus);
          break;
        }
      }
    },
    [flattenedResults, selectedIndex, executeCommand, close],
  );

  const handleItemClick = useCallback(
    (result: CommandSearchResult) => {
      executeCommand(result.item);
    },
    [executeCommand],
  );

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        close();
      }
    },
    [close],
  );

  if (!isOpen) return null;

  const showEmptyState = query.trim() && flattenedResults.length === 0;
  const showRecentState = !query.trim() && recentItems.length > 0;
  const showNoRecentState = !query.trim() && recentItems.length === 0;

  // group results by category for display
  const orderedCategories: CommandCategory[] = ['settings', 'actions', 'navigation'];

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div
      className='fixed inset-0 z-[120] flex items-start justify-center bg-black/50 pt-[15vh]'
      onClick={handleBackdropClick}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        className='bg-base-100 mx-4 w-full max-w-lg overflow-hidden rounded-xl shadow-2xl'
        role='dialog'
        aria-modal='true'
        aria-label={_('Command Palette')}
        onKeyDown={handleKeyDown}
      >
        {/* search input */}
        <div className='border-base-300 flex items-center border-b px-4'>
          <FiSearch className='text-base-content/50 mr-3 h-5 w-5 shrink-0' />
          <input
            ref={inputRef}
            type='text'
            className='placeholder:text-base-content/50 h-12 w-full bg-transparent text-base outline-none'
            placeholder={_('Search settings and actions...')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onBlur={() => {
              // Focus 仍在 dialog 内时尊重 Tab 移动到的目标；仅当焦点真正
              // 离开 dialog（点击空白/页面）时才把焦点拉回 input，避免 blur
              // 的 rAF 在 Tab 到结果后把焦点抢回 input。
              if (!isOpen || !document.hasFocus()) return;
              requestAnimationFrame(() => {
                const input = inputRef.current;
                const dialog = input?.closest<HTMLElement>('[role="dialog"]');
                if (input && dialog && !dialog.contains(document.activeElement)) {
                  input.focus();
                }
              });
            }}
            spellCheck={false}
            autoComplete='off'
            autoCorrect='off'
            autoCapitalize='off'
          />
          {query && (
            <button
              className='btn btn-ghost btn-circle btn-sm ml-2'
              onClick={() => setQuery('')}
              aria-label={_('Clear search')}
            >
              <MdClose className='h-4 w-4' />
            </button>
          )}
        </div>

        {/* results list */}
        <div ref={listRef} className='max-h-80 overflow-y-auto p-2' role='listbox'>
          {showEmptyState && (
            <div className='text-base-content/60 px-4 py-8 text-center text-sm'>
              {_('No results found for')} &quot;{query}&quot;
            </div>
          )}

          {showNoRecentState && (
            <div className='text-base-content/60 px-4 py-8 text-center text-sm'>
              {_('Type to search settings and actions')}
            </div>
          )}

          {showRecentState && (
            <div className='mb-1'>
              <div className='text-base-content/50 px-3 py-1.5 text-xs font-medium uppercase'>
                {_('Recent')}
              </div>
              {flattenedResults.map((result, index) => (
                <CommandResultItem
                  key={result.item.id}
                  result={result}
                  isSelected={index === selectedIndex}
                  onClick={() => handleItemClick(result)}
                  onMouseEnter={() => setSelectedIndex(index)}
                  _={_}
                />
              ))}
            </div>
          )}

          {query.trim() && flattenedResults.length > 0 && (
            <>
              {/* C-9：commandId → 全局索引。跨类交错命中时不再用"分类起始索引 +
                   类内偏移"推导（会被交错顺序打乱），改由扁平结果的真实下标决定
                   高亮与 Enter 执行一致性。 */}
              {(() => {
                const indexByCommandId = new Map(
                  flattenedResults.map((r, i) => [r.item.id, i] as const),
                );
                return orderedCategories.map((category) => {
                  const categoryResults = groupedResults[category];
                  if (categoryResults.length === 0) return null;

                  return (
                    <div key={category} className='mb-1'>
                      <div className='text-base-content/50 px-3 py-1.5 text-xs font-medium uppercase'>
                        {getCategoryLabel(_, category)}
                      </div>
                      {categoryResults.map((result) => {
                        const globalIndex = indexByCommandId.get(result.item.id);
                        return (
                          <CommandResultItem
                            key={result.item.id}
                            result={result}
                            isSelected={globalIndex != null && globalIndex === selectedIndex}
                            onClick={() => handleItemClick(result)}
                            onMouseEnter={() => {
                              if (globalIndex != null) setSelectedIndex(globalIndex);
                            }}
                            _={_}
                          />
                        );
                      })}
                    </div>
                  );
                });
              })()}
            </>
          )}
        </div>

        {/* footer with keyboard hints */}
        <div className='border-base-300 text-base-content/50 flex items-center justify-between border-t px-4 py-2 text-xs'>
          <div className='flex items-center gap-3'>
            <span>
              <kbd className='kbd kbd-xs'>↑↓</kbd> {_('navigate')}
            </span>
            <span>
              <kbd className='kbd kbd-xs'>↵</kbd> {_('select')}
            </span>
            <span>
              <kbd className='kbd kbd-xs'>esc</kbd> {_('close')}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

interface CommandResultItemProps {
  result: CommandSearchResult;
  isSelected: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  _: (key: string) => string;
}

const CommandResultItem: React.FC<CommandResultItemProps> = ({
  result,
  isSelected,
  onClick,
  onMouseEnter,
  _,
}) => {
  const { item, highlightIndices, matchContext } = result;
  const Icon = item.icon;

  return (
    <button
      className={clsx(
        'flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors',
        isSelected ? 'bg-primary/10 text-primary' : 'hover:bg-base-200',
      )}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      role='option'
      aria-selected={isSelected}
      data-selected={isSelected}
    >
      {Icon && (
        <div className='text-base-content/60 flex h-8 w-8 shrink-0 items-center justify-center'>
          <Icon className='h-5 w-5' />
        </div>
      )}
      {!Icon && <div className='w-8 shrink-0' />}
      <div className='min-w-0 flex-1'>
        <div className='truncate text-sm'>
          <HighlightChars str={_(item.labelKey)} indices={highlightIndices} />
        </div>
        {(item.section || matchContext) && (
          <div className='text-base-content/50 truncate text-xs'>
            {item.panel && <span>{_(item.panelLabel ?? item.panel)}</span>}
            {item.panel && item.section && <span> › </span>}
            {item.section && <span>{_(item.section)}</span>}
            {matchContext &&
              matchContext !== item.section &&
              matchContext !== item.panelLabel &&
              matchContext !== item.panel && <span className='ml-2 italic'>({matchContext})</span>}
          </div>
        )}
      </div>
      {item.shortcut && item.shortcut.length > 0 && (
        <div className='text-base-content/40 ml-auto shrink-0 text-xs'>
          {item.shortcut.map((key, i) => (
            <kbd key={i} className='kbd kbd-xs ml-1'>
              {key}
            </kbd>
          ))}
        </div>
      )}
    </button>
  );
};

export default CommandPalette;
