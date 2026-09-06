import React, { useCallback } from 'react';
import { RiListUnordered } from 'react-icons/ri';
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

  const isSidebarOpenForBook = sideBarBookKey === bookKey && isSideBarVisible;

  const handleOpenTOC = useCallback(() => {
    // 切换语义（用户决策：两颗悬浮按钮常驻）：侧栏已为本书展开时，点击 =
    // 收起侧栏。直接返回，不进入下方打开流程把刚收起的侧栏又打开。
    if (sideBarBookKey === bookKey && isSideBarVisible) {
      setSideBarVisible(false);
      return;
    }
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
    sideBarBookKey,
    isSideBarVisible,
    getConfig,
    setConfig,
    setSideBarBookKey,
    setSideBarVisible,
    setSearchBarVisible,
    clearSearch,
    getView,
    setHoveredBookKey,
  ]);

  // label 必须说明即将发生的动作（与 FloatingSpeakButton 的约定一致）：
  // 侧栏展开时这颗按钮的动作是收起。
  const label = isSidebarOpenForBook ? _('Close') : _('Table of Contents');

  return (
    <button
      type='button'
      aria-label={label}
      title={label}
      onClick={handleOpenTOC}
      className='absolute bottom-24 right-4 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-base-100/90 text-base-content shadow-lg backdrop-blur-sm transition-transform active:scale-95 sm:bottom-16'
    >
      <RiListUnordered size={24} />
    </button>
  );
};

export default TOCFloatingButton;
