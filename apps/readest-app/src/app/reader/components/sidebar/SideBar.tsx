import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useSettingsStore } from '@/store/settingsStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useSidebarStore } from '@/store/sidebarStore';
import { useTranslation } from '@/hooks/useTranslation';
import { blurActiveElement } from '@/utils/focus';
import { eventDispatcher } from '@/utils/event';
import { getBookDirFromLanguage } from '@/utils/book';
import { getPanelTopInset } from '@/utils/insets';
import { useEnv } from '@/context/EnvContext';
import { useSwipeToDismiss } from '@/hooks/useSwipeToDismiss';
import { usePanelResize } from '@/hooks/usePanelResize';
import { useThemeStore } from '@/store/themeStore';
import { Overlay } from '@/components/Overlay';
import useShortcuts from '@/hooks/useShortcuts';
import { useEscapeHandler } from '@/app/reader/utils/escapeStack';
import SidebarHeader from './Header';
import SidebarContent from './Content';
import BookCard from './BookCard';
import useSidebar from '../../hooks/useSidebar';
import SearchBar from './SearchBar';
import SearchResults from './SearchResults';

const MIN_SIDEBAR_WIDTH = 0.05;
const MAX_SIDEBAR_WIDTH = 0.45;

const SideBar = ({}) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const { updateAppTheme, safeAreaInsets, systemUIVisible, statusBarHeight } = useThemeStore();
  const { sideBarBookKey, setSideBarBookKey, getSearchNavState, setSearchTerm, clearSearch } =
    useSidebarStore();
  const {
    isSearchBarVisible,
    setSearchBarVisible,
    requestSearchBarFocus,
    resetSearchBarFocus,
    setSearchStatus,
    getSearchStatus,
  } = useSidebarStore();
  const searchNavState = sideBarBookKey ? getSearchNavState(sideBarBookKey) : null;
  const {
    searchTerm = '',
    searchResults = null,
    searchProgress = 1,
    searchError = null,
  } = searchNavState || {};
  const getBookData = useBookDataStore((s) => s.getBookData);
  const getConfig = useBookDataStore((s) => s.getConfig);
  const { getView, getViewSettings } = useReaderStore();
  const searchTermRef = useRef(searchTerm);
  const isMobile = window.innerWidth < 640;
  const [isFullHeightInMobile, setIsFullHeightInMobile] = useState(isMobile);
  const {
    sideBarWidth,
    isSideBarPinned,
    isSideBarVisible,
    getSideBarWidth,
    setSideBarVisible,
    handleSideBarResize,
    handleSideBarTogglePin,
  } = useSidebar(
    settings.globalReadSettings.sideBarWidth,
    isMobile ? false : settings.globalReadSettings.isSideBarPinned,
  );

  const onSearchEvent = async (event: CustomEvent) => {
    const { term, bookKey } = event.detail;
    setSideBarVisible(true);
    setSideBarBookKey(bookKey);
    setSearchBarVisible(true);
    // 搜索选中文本打开的搜索栏同样默认不聚焦；再次 ctrl+f 才聚焦。
    resetSearchBarFocus();
    if (term !== undefined && term !== null) {
      setSearchTerm(bookKey, term);
      // 乐观置为搜索中：结果面板立即接管内容区（"Searching..." 占位），
      // 否则选词 Ctrl+F 会先停在目录页直到 500ms debounce 后真正开搜。
      // 词长不足时 SearchBar 的 resetSearch 会把状态归回 terminated，
      // 面板随之让位回目录。
      setSearchStatus(bookKey, 'searching');
    }
  };

  const {
    panelRef: sidebarRef,
    overlayRef,
    panelHeight: sidebarHeight,
    handleVerticalDragStart,
  } = useSwipeToDismiss(
    () => {
      setSideBarVisible(false);
      setIsFullHeightInMobile(isMobile);
    },
    (data) => setIsFullHeightInMobile(data.clientY < 44),
  );

  useEffect(() => {
    if (isSideBarVisible) {
      updateAppTheme('base-200');
      overlayRef.current = document.querySelector('.overlay') as HTMLDivElement | null;
    } else {
      updateAppTheme('base-100');
      overlayRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSideBarVisible]);

  useEffect(() => {
    searchTermRef.current = searchTerm;
  }, [searchTerm]);

  useEffect(() => {
    eventDispatcher.on('search-term', onSearchEvent);
    return () => {
      eventDispatcher.off('search-term', onSearchEvent);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { handleResizeStart: handleHorizontalDragStart, handleResizeKeyDown: handleDragKeyDown } =
    usePanelResize({
      side: 'start',
      minWidth: MIN_SIDEBAR_WIDTH,
      maxWidth: MAX_SIDEBAR_WIDTH,
      getWidth: getSideBarWidth,
      onResize: handleSideBarResize,
    });

  const handleClickOverlay = () => {
    setSideBarVisible(false);
  };

  // Ctrl+F 管理搜索栏：未开 → 打开（不聚焦，焦点留在正文可继续翻页）；
  // 已开 → 请求聚焦输入框。关闭不再走这里，交 Esc / Ctrl+W
  // （handleHideSearchBar / close-search-bar 事件）。
  const handleShowSearchBar = useCallback(() => {
    if (isSearchBarVisible) {
      requestSearchBarFocus();
    } else {
      setTimeout(() => {
        setSideBarVisible(true);
        setSearchBarVisible(true);
        // 打开即清零聚焦请求，避免上次聚焦残留导致本次打开就聚焦。
        resetSearchBarFocus();
      }, 100);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSearchBarVisible, requestSearchBarFocus, resetSearchBarFocus]);

  const handleHideSearchBar = useCallback(() => {
    // visibility:hidden 不触发 blur，焦点留在隐藏 input 内会使 useShortcuts
    // 视为"正在输入"而跳过全部快捷键（F/翻页/全屏失效）。先归还焦点。
    blurActiveElement();
    setSearchBarVisible(false);
    setTimeout(() => {
      if (sideBarBookKey) clearSearch(sideBarBookKey);
    }, 100);
    getView(sideBarBookKey)?.clearSearch();
    // 关闭搜索栏即回到阅读正文：搜索栏是叠加在侧边栏上的临时层（Ctrl+F /
    // 选词打开），关闭时一律收起侧边栏，避免停在目录页。固定侧边栏语义
    // （保持目录/笔记本常驻）保留给无搜索态的 Esc（handleHideSideBar）。
    setSideBarVisible(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideBarBookKey, clearSearch]);

  const handleHideSideBar = useCallback(() => {
    if (searchTermRef.current) {
      handleHideSearchBar();
    } else if (!isSideBarPinned) {
      setSideBarVisible(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sideBarBookKey, isSideBarPinned]);

  // Ctrl+W / 聚焦时 Ctrl+F 关闭搜索栏由 useBookShortcuts 的捕获阶段拦截
  // dispatch close-search-bar（SearchBar 输入框 onKeyDown 与 closeWindow 仅为
  // 兜底），此处统一关闭搜索栏并归还焦点。
  useEffect(() => {
    const onCloseSearchBar = () => handleHideSearchBar();
    eventDispatcher.on('close-search-bar', onCloseSearchBar);
    return () => {
      eventDispatcher.off('close-search-bar', onCloseSearchBar);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleHideSearchBar]);

  // Escape goes through the reader's escape stack. While the search bar is up
  // it collapses search (and the sidebar with it); otherwise it hides the
  // sidebar unless pinned. Layers above (notebook, note editor) get first
  // crack because they register on top of the stack.
  useEscapeHandler(
    'sidebar',
    (): boolean => {
      if (!isSideBarVisible && !isSearchBarVisible) return false;
      handleHideSideBar();
      return true;
    },
    isSideBarVisible || isSearchBarVisible,
  );

  useShortcuts({ onShowSearchBar: handleShowSearchBar }, [handleShowSearchBar]);

  const handleSearchResultClick = (cfi: string) => {
    getView(sideBarBookKey)?.goTo(cfi);
  };

  if (!sideBarBookKey) return null;

  const viewSettings = getViewSettings(sideBarBookKey);
  const bookData = getBookData(sideBarBookKey);
  if (!bookData || !bookData.book || !bookData.bookDoc) {
    return null;
  }
  const { book, bookDoc } = bookData;
  const languageDir = getBookDirFromLanguage(bookDoc.metadata.language);
  // On the annotations tab the header search icon drives the annotation
  // search in the toolbar instead of the in-book text search.
  const isAnnotationsTab = getConfig(sideBarBookKey)?.viewSettings?.sideBarTab === 'annotations';
  // 结果面板只有在"真有内容可显示"时才接管内容区：非空结果，或一次已完成的
  // 搜索（No results 反馈）。SearchBar 挂载时空词 reset 会把状态写成
  // results=[] + progress 0 —— [] 是 truthy，若仅凭 searchResults 判断就会
  // 渲染出什么都不画的 SearchResults（内部 return null），把 Ctrl+F 刚打开
  // 的目录闪掉（首次 Ctrl+F 目录闪现后消失的根因）。搜索出错的反馈留在
  // 搜索栏内联显示，目录不被清空。
  // status 'searching' 也接管内容区：选词 Ctrl+F 乐观置位后用户要的就是
  // 搜索结果页；SearchBar 的 resetSearch（清词/词长不足）会把状态归回
  // terminated，面板随之让位回目录。
  const isSearching = !!sideBarBookKey && getSearchStatus(sideBarBookKey) === 'searching';
  const showResultsPanel =
    isSearchBarVisible &&
    !isAnnotationsTab &&
    (isSearching ||
      (!!searchResults && (searchResults.length > 0 || (searchProgress >= 1 && !searchError))));

  return isSideBarVisible ? (
    <>
      {isMobile && (
        <Overlay
          className={clsx('z-[45]', viewSettings?.isEink ? '' : 'bg-black/50 sm:bg-black/20')}
          onDismiss={handleClickOverlay}
        />
      )}
      <div
        ref={sidebarRef}
        className={clsx(
          'sidebar-container flex min-w-60 select-none flex-col',
          'full-height transition-[padding-top] duration-300',
          viewSettings?.isEink ? 'bg-base-100' : 'bg-base-200',
          appService?.hasRoundedWindow && 'rounded-window-top-left rounded-window-bottom-left',
          isMobile ? 'z-[45] shadow-2xl' : 'z-20',
          !isMobile && viewSettings?.isEink && 'border-base-content border-e',
        )}
        role='navigation'
        aria-label={_('Sidebar')}
        dir={viewSettings?.rtl && languageDir === 'rtl' ? 'rtl' : 'ltr'}
        style={{
          width: isMobile ? '100%' : `${sideBarWidth}`,
          maxWidth: isMobile ? '100%' : `${MAX_SIDEBAR_WIDTH * 100}%`,
          position: isMobile ? 'fixed' : 'relative',
          paddingTop: `${getPanelTopInset({
            isMobile,
            isFullHeightInMobile,
            systemUIVisible,
            statusBarHeight,
            safeAreaInsets,
          })}px`,
        }}
      >
        <style jsx>{`
          @media (max-width: 640px) {
            .sidebar-container {
              border-top-left-radius: 16px;
              border-top-right-radius: 16px;
            }
            .overlay {
              transition: opacity 0.3s ease-in-out;
            }
          }
        `}</style>
        <div
          className={clsx(
            'drag-bar absolute -right-2 top-0 h-full w-0.5 cursor-col-resize bg-transparent p-1',
            isMobile && 'hidden',
          )}
          role='slider'
          tabIndex={0}
          aria-label={_('Resize Sidebar')}
          aria-orientation='horizontal'
          aria-valuenow={parseFloat(sideBarWidth)}
          onMouseDown={handleHorizontalDragStart}
          onTouchStart={handleHorizontalDragStart}
          onKeyDown={handleDragKeyDown}
        ></div>
        <div className='flex-shrink-0'>
          {isMobile && (
            <div
              role='slider'
              tabIndex={0}
              aria-label={_('Resize Sidebar')}
              aria-orientation='vertical'
              aria-valuenow={sidebarHeight.current}
              className='drag-handle flex h-6 max-h-6 min-h-6 w-full cursor-row-resize items-center justify-center'
              onMouseDown={handleVerticalDragStart}
              onTouchStart={handleVerticalDragStart}
            >
              <div className='bg-base-content/50 h-1 w-10 rounded-full'></div>
            </div>
          )}
          <SidebarHeader
            bookKey={sideBarBookKey!}
            isPinned={isSideBarPinned}
            onClose={() => setSideBarVisible(false)}
            onTogglePin={handleSideBarTogglePin}
          />
          <div
            className={clsx('search-bar', {
              'search-bar-visible': isSearchBarVisible && !isAnnotationsTab,
            })}
          >
            <SearchBar
              isVisible={isSearchBarVisible && !isAnnotationsTab}
              bookKey={sideBarBookKey!}
              onHideSearchBar={handleHideSearchBar}
            />
          </div>
          <div className='border-base-300/50 border-b px-3'>
            <BookCard book={book} />
          </div>
        </div>
        {showResultsPanel ? (
          <SearchResults
            bookKey={sideBarBookKey!}
            results={searchResults ?? []}
            onSelectResult={handleSearchResultClick}
          />
        ) : (
          <SidebarContent bookDoc={bookDoc} sideBarBookKey={sideBarBookKey!} />
        )}
      </div>
    </>
  ) : null;
};

export default SideBar;
