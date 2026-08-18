import React, { useCallback } from 'react';
import { IoIosList } from 'react-icons/io';
import { useReaderStore } from '@/store/readerStore';
import { useSidebarStore } from '@/store/sidebarStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useTranslation } from '@/hooks/useTranslation';

const TOCFloatingButton: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const {
    sideBarBookKey,
    isSideBarVisible,
    setSideBarBookKey,
    setSideBarVisible,
    setSearchBarVisible,
    clearSearch,
  } = useSidebarStore();
  const { getConfig, setConfig } = useBookDataStore();
  const { setHoveredBookKey, getView } = useReaderStore();

  const handleOpenTOC = useCallback(() => {
    setHoveredBookKey(bookKey);
    const config = getConfig(bookKey);
    if (config?.viewSettings) {
      setConfig(bookKey, { viewSettings: { ...config.viewSettings, sideBarTab: 'toc' } });
    }
    // Opening the TOC must take the sidebar out of any lingering in-book
    // search state. Otherwise the stale search panel (which renders in place
    // of the sidebar content whenever isSearchBarVisible && results) stays up
    // and the TOC appears not to open. Mirror the tab-switch behaviour in
    // Content.handleTabChange and the clear done by handleHideSearchBar.
    setSearchBarVisible(false);
    clearSearch(bookKey);
    getView(bookKey)?.clearSearch();
    setSideBarBookKey(bookKey);
    setSideBarVisible(true);
  }, [
    bookKey,
    getConfig,
    setConfig,
    setSideBarBookKey,
    setSideBarVisible,
    setSearchBarVisible,
    clearSearch,
    getView,
    setHoveredBookKey,
  ]);

  if (sideBarBookKey === bookKey && isSideBarVisible) return null;

  return (
    <button
      type='button'
      aria-label={_('Table of Contents')}
      title={_('Table of Contents')}
      onClick={handleOpenTOC}
      className='absolute bottom-24 right-4 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-base-100/90 text-base-content shadow-lg backdrop-blur-sm transition-transform active:scale-95 sm:bottom-16'
    >
      <IoIosList size={24} />
    </button>
  );
};

export default TOCFloatingButton;
