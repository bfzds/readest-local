import clsx from 'clsx';
import React, { useEffect, useState } from 'react';

import { BookDoc } from '@/libs/document';
import { useReaderStore } from '@/store/readerStore';
import { useSidebarStore } from '@/store/sidebarStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import 'overlayscrollbars/overlayscrollbars.css';

import TOCView from './TOCView';
import BooknoteView from './BooknoteView';
import TabNavigation from './TabNavigation';

const SidebarContent: React.FC<{
  bookDoc: BookDoc;
  sideBarBookKey: string;
}> = ({ bookDoc, sideBarBookKey }) => {
  const { setHoveredBookKey } = useReaderStore();
  const { setSideBarVisible, setSearchBarVisible } = useSidebarStore();
  const { getConfig, setConfig } = useBookDataStore();
  const config = getConfig(sideBarBookKey);
  const [activeTab, setActiveTab] = useState(config?.viewSettings?.sideBarTab || 'toc');
  const [fade, setFade] = useState(false);
  const isMobile = window.innerWidth < 640 || window.innerHeight < 640;

  useEffect(() => {
    if (!sideBarBookKey) return;
    const config = getConfig(sideBarBookKey!)!;
    setActiveTab(config.viewSettings!.sideBarTab!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideBarBookKey]);

  const handleTabChange = (tab: string) => {
    if (activeTab === tab) {
      if (isMobile) {
        setHoveredBookKey(sideBarBookKey);
        setSideBarVisible(false);
      }
      return;
    }

    // The header search icon is contextual (annotation search vs in-book
    // search), so an open search bar never survives a tab switch.
    setSearchBarVisible(false);
    setFade(true);
    const timeout = setTimeout(() => {
      setActiveTab(tab);
      setFade(false);
      setConfig(sideBarBookKey!, config);
      clearTimeout(timeout);
    }, 300);

    const config = getConfig(sideBarBookKey!)!;
    config.viewSettings!.sideBarTab = tab;
  };

  return (
    <>
      <div
        className={clsx(
          'sidebar-content flex h-full min-h-0 flex-grow flex-col shadow-inner',
          'font-sans text-base font-normal sm:text-sm',
        )}
      >
        <OverlayScrollbarsComponent
          className='min-h-0 flex-1'
          options={{
            // The tab content is width-bound; x stays hidden so oversized
            // touch-target halos (e.g. the toolbar's dropdown toggle) can't
            // turn into a horizontal scrollbar.
            overflow: { x: 'hidden' },
            scrollbars: { autoHide: 'scroll', clickScroll: true },
            showNativeOverlaidScrollbars: false,
          }}
          defer
        >
          <div
            className={clsx('scroll-container h-full transition-opacity duration-300 ease-in-out', {
              'opacity-0': fade,
              'opacity-100': !fade,
            })}
          >
            {activeTab === 'toc' && bookDoc.toc && (
              <TOCView toc={bookDoc.toc} bookKey={sideBarBookKey} />
            )}
            {activeTab === 'annotations' && (
              <BooknoteView type='annotation' toc={bookDoc.toc ?? []} bookKey={sideBarBookKey} />
            )}
            {activeTab === 'bookmarks' && (
              <BooknoteView type='bookmark' toc={bookDoc.toc ?? []} bookKey={sideBarBookKey} />
            )}
          </div>
        </OverlayScrollbarsComponent>
      </div>
      <div
        className='flex-shrink-0'
        style={
          {
            // paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) / 2)',
          }
        }
      >
        <TabNavigation activeTab={activeTab} onTabChange={handleTabChange} />
      </div>
    </>
  );
};

export default SidebarContent;
