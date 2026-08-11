import React, { useCallback } from 'react';
import { FiSearch } from 'react-icons/fi';
import { useSidebarStore } from '@/store/sidebarStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useTranslation } from '@/hooks/useTranslation';

const SearchFloatingButton: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const {
    sideBarBookKey,
    isSideBarVisible,
    setSideBarBookKey,
    setSideBarVisible,
    setSearchBarVisible,
  } = useSidebarStore();
  const { getConfig, setConfig } = useBookDataStore();

  const handleOpenSearch = useCallback(() => {
    const config = getConfig(bookKey);
    if (config?.viewSettings) {
      setConfig(bookKey, { viewSettings: { ...config.viewSettings, sideBarTab: 'toc' } });
    }
    setSideBarBookKey(bookKey);
    setSideBarVisible(true);
    setSearchBarVisible(true);
  }, [bookKey, getConfig, setConfig, setSideBarBookKey, setSideBarVisible, setSearchBarVisible]);

  if (sideBarBookKey === bookKey && isSideBarVisible) return null;

  return (
    <button
      type='button'
      aria-label={_('Search')}
      title={_('Search')}
      onClick={handleOpenSearch}
      className='absolute bottom-40 right-4 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-base-100/90 text-base-content shadow-lg backdrop-blur-sm transition-transform active:scale-95 sm:bottom-32'
    >
      <FiSearch size={20} />
    </button>
  );
};

export default SearchFloatingButton;
