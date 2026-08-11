import React, { useCallback } from 'react';
import { IoIosList } from 'react-icons/io';
import { useReaderStore } from '@/store/readerStore';
import { useSidebarStore } from '@/store/sidebarStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useTranslation } from '@/hooks/useTranslation';

const TOCFloatingButton: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const { sideBarBookKey, isSideBarVisible, setSideBarBookKey, setSideBarVisible } =
    useSidebarStore();
  const { getConfig, setConfig } = useBookDataStore();
  const { setHoveredBookKey } = useReaderStore();

  const handleOpenTOC = useCallback(() => {
    setHoveredBookKey(bookKey);
    const config = getConfig(bookKey);
    if (config?.viewSettings) {
      setConfig(bookKey, { viewSettings: { ...config.viewSettings, sideBarTab: 'toc' } });
    }
    setSideBarBookKey(bookKey);
    setSideBarVisible(true);
  }, [bookKey, getConfig, setConfig, setSideBarBookKey, setSideBarVisible, setHoveredBookKey]);

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
