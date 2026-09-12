import clsx from 'clsx';
import React, { useEffect, useState } from 'react';

import { BookDoc } from '@/libs/document';
import { containsVirtualTocItem, isTocDegraded } from '@/services/virtualToc/apply';
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
  const getBookData = useBookDataStore((s) => s.getBookData);
  const _ = useTranslation();
  const config = getConfig(sideBarBookKey);
  const [activeTab, setActiveTab] = useState(config?.viewSettings?.sideBarTab || 'toc');
  const [fade, setFade] = useState(false);
  const [tocDialogOpen, setTocDialogOpen] = useState(false);
  const isMobile = window.innerWidth < 640 || window.innerHeight < 640;

  const tocEmpty = !bookDoc.toc || bookDoc.toc.length === 0;
  // 虚拟目录是 EPUB 专属（正文按 section 扫描），与 readerStore 的 nav 门禁同口径。
  const canGenerateToc =
    getBookData(sideBarBookKey)?.book?.format === 'EPUB' &&
    bookDoc.rendition?.layout !== 'pre-paginated' &&
    (bookDoc.sections?.length ?? 0) > 0;
  // 目录非空也可能是退化的（几条无锚点结构条目指向一个巨型 section）——此时不能只
  // 看条目数，判据与 applyVirtualToc 门禁、弹窗合成入口共用同一份 isTocDegraded。
  // 已含虚拟条目的书（无 slab、首次生成后 toc 健康非空）同样必须保住入口，否则
  // 用户无法重新生成或改 pattern（R41）。
  const showTocEntry =
    canGenerateToc &&
    (tocEmpty || isTocDegraded(bookDoc) || containsVirtualTocItem(bookDoc.toc ?? []));

  useEffect(() => {
    if (!sideBarBookKey) return;
    const config = getConfig(sideBarBookKey!)!;
    setActiveTab(config.viewSettings!.sideBarTab!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideBarBookKey]);

  // R18：弹窗的 open 状态挂在本组件根节点，而 SideBar 渲染它时未传 key——切换书籍
  // 会跨书保留未完成的弹窗（内容按新 props 渲染，用户易误以为在操作原书）。切换即复位。
  useEffect(() => {
    setTocDialogOpen(false);
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
                <VirtualTocEmptyState
                  canGenerate={canGenerateToc}
                  onGenerate={() => setTocDialogOpen(true)}
                />
              ))}
            {activeTab === 'annotations' && (
              <BooknoteView type='annotation' toc={bookDoc.toc ?? []} bookKey={sideBarBookKey} />
            )}
            {activeTab === 'bookmarks' && (
              <BooknoteView type='bookmark' toc={bookDoc.toc ?? []} bookKey={sideBarBookKey} />
            )}
          </div>
        </OverlayScrollbarsComponent>
        {/* 退化但目录非空的入口：TOCView 的高度按父容器 .scroll-container 算并以 400px
            为下限（TOCView 的 updateHeight），入口挂在它之后会被推到滚动区之外，所以
            与 TOCChapterNav 一样做成滚动区外的固定底栏——放在章节导航之上，让章节
            导航相对底部 TabNavigation 的位置保持原样。 */}
        {activeTab === 'toc' && !tocEmpty && showTocEntry && (
          <div className='border-base-300/50 flex-shrink-0 border-t px-2 py-2'>
            <button
              type='button'
              className='btn btn-contrast btn-sm w-full'
              onClick={() => setTocDialogOpen(true)}
            >
              {_('Generate TOC from content')}
            </button>
          </div>
        )}
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
      {/* 空态入口与退化入口共用同一份弹窗挂载与 open 状态。 */}
      {tocDialogOpen && canGenerateToc && (
        <VirtualTocDialog
          bookKey={sideBarBookKey}
          bookDoc={bookDoc}
          onClose={() => setTocDialogOpen(false)}
        />
      )}
    </>
  );
};

export default SidebarContent;

// 目录为空/缺失时的面板内容：只要这本书有正文可扫（EPUB、可重排、至少 1 个 section）
// 就给出「从正文生成目录」入口，否则退化为「无目录」文案。这里**不能**用
// shouldOfferSynthesis：它的语义是「按文件分章这条捷径是否适用」（要求可读 section
// > 1），而正则扫描单 section 的书正是本功能的主战场（如单 HTML 的长篇网络小说）。
// shouldOfferSynthesis 仍在 Task 7 弹窗里把守 synthesizeSectionToc 的调用点（R6）。
const VirtualTocEmptyState = ({
  canGenerate,
  onGenerate,
}: {
  canGenerate: boolean;
  onGenerate: () => void;
}) => {
  const _ = useTranslation();
  if (!canGenerate) {
    return <div className='text-base-content/60 p-4 text-sm'>{_('No TOC')}</div>;
  }
  return (
    <div className='flex flex-col items-center gap-3 p-4'>
      <p className='text-base-content/60 text-sm'>{_('No table of contents in this book.')}</p>
      <button type='button' className='btn btn-contrast btn-sm' onClick={onGenerate}>
        {_('Generate TOC from content')}
      </button>
    </div>
  );
};
