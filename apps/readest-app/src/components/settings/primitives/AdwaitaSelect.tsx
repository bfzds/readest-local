import clsx from 'clsx';
import React, { useEffect, useRef, useState } from 'react';
import { MdArrowDropDown, MdCheck } from 'react-icons/md';
import Dropdown from '@/components/Dropdown';
import Menu from '@/components/Menu';

export interface AdwaitaSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface AdwaitaSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: AdwaitaSelectOption[];
  disabled?: boolean;
  ariaLabel?: string;
  /** Appended to the open menu (menuClassName). */
  className?: string;
  /** Overrides the trigger button styles (bordered / dark variants). */
  buttonClassName?: string;
  containerClassName?: string;
  testId?: string;
}

interface SelectMenuProps {
  value: string;
  options: AdwaitaSelectOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
  /** Injected by Dropdown's children clone. */
  menuClassName?: string;
  setIsDropdownOpen?: (open: boolean) => void;
}

const SelectMenu: React.FC<SelectMenuProps> = ({
  value,
  options,
  disabled,
  onChange,
  menuClassName,
  setIsDropdownOpen,
}) => {
  const listRef = useRef<HTMLUListElement | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const idx = options.findIndex((o) => o.value === value);
    return idx >= 0 ? idx : 0;
  });
  // Native keydown listener is bound once on mount; keep the live index in a
  // ref so the handler reads the current selection, not the mount-time one.
  const selectedIndexRef = useRef(selectedIndex);
  useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  const selectableIndices = options
    .map((o, i) => (o.disabled || disabled ? -1 : i))
    .filter((i) => i >= 0);

  const handleSelect = (opt: AdwaitaSelectOption) => {
    if (opt.disabled || disabled) return;
    onChange(opt.value);
    setIsDropdownOpen?.(false);
  };

  // Focus the listbox on open and drive keyboard nav via a native listener.
  // Menu's own keydown hook (useKeyDownActions) stopPropagations on the Menu
  // container before React synthetic handlers on the listbox would fire, so a
  // React onKeyDown here would never run.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.focus();
    const handleKeyDown = (e: KeyboardEvent) => {
      const selectable = selectableIndices;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          if (selectable.length) {
            setSelectedIndex((prev) => {
              const pos = selectable.indexOf(prev);
              return selectable[Math.min(Math.max(pos + 1, 0), selectable.length - 1)] ?? prev;
            });
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (selectable.length) {
            setSelectedIndex((prev) => {
              const pos = selectable.indexOf(prev);
              return selectable[Math.min(Math.max(pos - 1, 0), selectable.length - 1)] ?? prev;
            });
          }
          break;
        case 'Home':
          e.preventDefault();
          if (selectable.length) setSelectedIndex(selectable[0]!);
          break;
        case 'End':
          e.preventDefault();
          if (selectable.length) setSelectedIndex(selectable[selectable.length - 1]!);
          break;
        case 'Enter':
          e.preventDefault();
          e.stopPropagation();
          const opt = options[selectedIndexRef.current];
          if (opt) handleSelect(opt);
          break;
        case 'Escape':
          setIsDropdownOpen?.(false);
          break;
        case 'Tab':
          setIsDropdownOpen?.(false);
          break;
      }
    };
    list.addEventListener('keydown', handleKeyDown);
    return () => list.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bound once on mount; refs carry live state
  }, []);

  // Keep the highlighted option in view while navigating.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selectedItem = list.querySelector('[data-selected="true"]');
    selectedItem?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedIndex]);

  return (
    <Menu
      className={clsx('dropdown-content no-triangle z-20 mt-2', menuClassName)}
      onCancel={() => setIsDropdownOpen?.(false)}
    >
      <ul ref={listRef} role='listbox' tabIndex={0} className='menu rounded-box p-0'>
        {options.map((opt) => {
          const isSelected = opt.value === value;
          const isDisabled = disabled || opt.disabled;
          return (
            <li key={opt.value}>
              <div
                role='option'
                aria-selected={isSelected}
                data-selected={isSelected}
                tabIndex={-1}
                onClick={() => handleSelect(opt)}
                className={clsx(
                  'text-base-content flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm',
                  isSelected ? 'bg-base-300/85' : 'hover:bg-base-300',
                  isDisabled && 'cursor-not-allowed opacity-50',
                )}
              >
                <span className='truncate'>{opt.label}</span>
                {isSelected && <MdCheck aria-hidden='true' className='h-4 w-4 flex-shrink-0' />}
              </div>
            </li>
          );
        })}
      </ul>
    </Menu>
  );
};

const AdwaitaSelect: React.FC<AdwaitaSelectProps> = ({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
  className,
  buttonClassName,
  containerClassName,
  testId,
}) => {
  const selected = options.find((o) => o.value === value);
  const currentLabel = selected?.label ?? value;

  return (
    <Dropdown
      label={ariaLabel || currentLabel}
      className='dropdown-end'
      menuClassName={className}
      containerClassName={clsx('max-w-[60%]', containerClassName)}
      buttonClassName={clsx(
        'settings-content h-9 min-h-9 min-w-0 cursor-pointer p-0 pe-1 ps-2 text-end',
        'flex items-center justify-end gap-0.5',
        buttonClassName,
      )}
      toggleButton={
        <>
          <span className='min-w-0 truncate'>{currentLabel}</span>
          <MdArrowDropDown
            aria-hidden='true'
            className='text-base-content/55 pointer-events-none h-5 w-5 flex-shrink-0'
          />
        </>
      }
      disabled={disabled}
      showTooltip={false}
      testId={testId}
    >
      <SelectMenu value={value} options={options} onChange={onChange} disabled={disabled} />
    </Dropdown>
  );
};

export default AdwaitaSelect;
