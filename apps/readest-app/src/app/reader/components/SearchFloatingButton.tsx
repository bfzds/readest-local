import React, { useCallback } from 'react';
import { RiSearchLine } from 'react-icons/ri';
import { useSidebarStore } from '@/store/sidebarStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useTranslation } from '@/hooks/useTranslation';

const SearchFloatingButton: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const { setSideBarBookKey, setSideBarVisible, setSearchBarVisible } = useSidebarStore();
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

  // 用户决策：按钮常驻（不再在侧栏展开时卸载）。侧栏已展开时点击 = 在
  // 展开的侧栏里打开搜索栏；收起时点击 = 打开侧栏并显示搜索栏。两条路径
  // 都走 handleOpenSearch，无需分支。

  return (
    <button
      type='button'
      aria-label={_('Search')}
      title={_('Search')}
      onClick={handleOpenSearch}
      className='absolute bottom-40 right-4 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-base-100/90 text-base-content shadow-lg backdrop-blur-sm transition-transform active:scale-95 sm:bottom-32'
    >
      <RiSearchLine size={20} />
    </button>
  );
};

export default SearchFloatingButton;
