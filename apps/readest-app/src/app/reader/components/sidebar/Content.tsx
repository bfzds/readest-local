import clsx from 'clsx';
import React, { useEffect, useState } from 'react';

import { BookDoc } from '@/libs/document';
import { useReaderStore } from '@/store/readerStore';
import { useSidebarStore } from '@/store/sidebarStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useTranslation } from '@/hooks/useTranslation';
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import 'overlayscrollbars/overlayscrollbars.css';

import TOCView from './TOCView';
import BooknoteView from './BooknoteView';
import TabNavigation from './TabNavigation';
import TOCChapterNav from './TOCChapterNav';
import VirtualTocDialog from '../VirtualTocDialog';

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
            {activeTab === 'toc' &&
              (bookDoc.toc && bookDoc.toc.length > 0 ? (
                <TOCView toc={bookDoc.toc} bookKey={sideBarBookKey} />
              ) : (
                <VirtualTocEmptyState bookKey={sideBarBookKey} bookDoc={bookDoc} />
              ))}
            {activeTab === 'annotations' && (
              <BooknoteView type='annotation' toc={bookDoc.toc ?? []} bookKey={sideBarBookKey} />
            )}
            {activeTab === 'bookmarks' && (
              <BooknoteView type='bookmark' toc={bookDoc.toc ?? []} bookKey={sideBarBookKey} />
            )}
          </div>
        </OverlayScrollbarsComponent>
        {activeTab === 'toc' && bookDoc.toc && bookDoc.toc.length > 0 && (
          <TOCChapterNav bookKey={sideBarBookKey} />
        )}
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

// 目录为空/缺失时的面板内容：只要这本书有正文可扫（可重排、至少 1 个 section）就给出
// 「从正文生成目录」入口，否则退化为「无目录」文案。这里**不能**用 shouldOfferSynthesis：
// 它的语义是「按文件分章这条捷径是否适用」（要求可读 section > 1），而正则扫描单
// section 的书正是本功能的主战场（如单 HTML 的长篇网络小说）。shouldOfferSynthesis
// 仍在 Task 7 弹窗里把守 synthesizeSectionToc 的调用点（R6）。
const VirtualTocEmptyState = ({ bookKey, bookDoc }: { bookKey: string; bookDoc: BookDoc }) => {
  const _ = useTranslation();
  const [open, setOpen] = useState(false);
  const eligible =
    bookDoc.rendition?.layout !== 'pre-paginated' && (bookDoc.sections?.length ?? 0) > 0;
  if (!eligible) {
    return <div className='text-base-content/60 p-4 text-sm'>{_('No TOC')}</div>;
  }
  return (
    <div className='flex flex-col items-center gap-3 p-4'>
      <p className='text-base-content/60 text-sm'>{_('No table of contents in this book.')}</p>
      <button type='button' className='btn btn-contrast btn-sm' onClick={() => setOpen(true)}>
        {_('Generate TOC from content')}
      </button>
      {open && (
        <VirtualTocDialog bookKey={bookKey} bookDoc={bookDoc} onClose={() => setOpen(false)} />
      )}
    </div>
  );
};
