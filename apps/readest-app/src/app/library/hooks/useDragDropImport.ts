import { useEffect, useRef, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { eventDispatcher } from '@/utils/event';
import { SelectedFile } from '@/hooks/useFileSelector';
import { isTauriAppPlatform } from '@/services/environment';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useTranslation } from '@/hooks/useTranslation';
import { useLibraryStore } from '@/store/libraryStore';
import { BOOK_ACCEPT_FORMATS, SUPPORTED_BOOK_EXTS } from '@/services/constants';
import { useSearchParams } from 'next/navigation';

const hasSupportedBookExt = (name: string) => {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext ? SUPPORTED_BOOK_EXTS.includes(ext) : false;
};

export const useDragDropImport = () => {
  const _ = useTranslation();
  const searchParams = useSearchParams();
  // Import target folder: the current folder group (when the view is inside
  // one), else the top level — independent of the display dimension chosen for
  // that group.
  const groupId = searchParams?.get('group') || '';
  const folderGroupPath = groupId ? useLibraryStore.getState().getGroupName(groupId) : '';
  const group = folderGroupPath ? groupId : '';

  const { appService } = useEnv();
  const [isDragging, setIsDragging] = useState(false);
  // dragenter/dragleave both bubble, so moving the pointer across child
  // elements fires leave+enter pairs. Counting them keeps the drop indicator
  // steady while over the page (a bare dragleave used to flicker it off).
  const dragEnterCountRef = useRef(0);

  const handleDroppedFiles = async (droppedItems: File[] | string[]) => {
    if (droppedItems.length === 0 || !appService) return;

    const fileItems: (File | string)[] = [];
    const directoryPaths: string[] = [];
    for (const item of droppedItems) {
      if (typeof item === 'string' && (await appService.isDirectory(item, 'None'))) {
        directoryPaths.push(item);
      } else {
        fileItems.push(item);
      }
    }

    const fileSelections: SelectedFile[] = fileItems
      .filter((item) => hasSupportedBookExt(typeof item === 'string' ? item : item.name))
      .map((item) => ({
        file: typeof item === 'string' ? undefined : item,
        path: typeof item === 'string' ? item : undefined,
      }));

    if (fileSelections.length === 0 && directoryPaths.length === 0) {
      eventDispatcher.dispatch('toast', {
        message: _('No supported files found. Supported formats: {{formats}}', {
          formats: BOOK_ACCEPT_FORMATS,
        }),
        type: 'error',
      });
      return;
    }

    if (fileSelections.length > 0) {
      eventDispatcher.dispatch('import-book-files', {
        files: fileSelections,
        groupId: group,
      });
    }
    for (const dir of directoryPaths) {
      eventDispatcher.dispatch('import-book-directory', { path: dir });
    }

    // Mixed drops: with at least one usable item, unsupported files used to be
    // dropped silently — tell the user what didn't make it into the library.
    const skippedCount = fileItems.length - fileSelections.length;
    if (skippedCount > 0) {
      eventDispatcher.dispatch('toast', {
        message: _('Skipped {{count}} unsupported file(s). Supported formats: {{formats}}', {
          count: skippedCount,
          formats: BOOK_ACCEPT_FORMATS,
        }),
        type: 'info',
      });
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement> | DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(true);
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement> | DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragEnterCountRef.current += 1;
    setIsDragging(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement> | DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragEnterCountRef.current = Math.max(0, dragEnterCountRef.current - 1);
    if (dragEnterCountRef.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement> | DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragEnterCountRef.current = 0;
    setIsDragging(false);

    if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
      const files = Array.from(event.dataTransfer.files);
      try {
        await handleDroppedFiles(files);
      } catch (error) {
        console.error('Drag-drop import failed:', error);
      }
    }
  };

  useEffect(() => {
    const libraryPage = document.querySelector('.library-page');
    libraryPage?.addEventListener('dragover', handleDragOver as unknown as EventListener);
    libraryPage?.addEventListener('dragenter', handleDragEnter as unknown as EventListener);
    libraryPage?.addEventListener('dragleave', handleDragLeave as unknown as EventListener);
    libraryPage?.addEventListener('drop', handleDrop as unknown as EventListener);

    const removeDomListeners = () => {
      libraryPage?.removeEventListener('dragover', handleDragOver as unknown as EventListener);
      libraryPage?.removeEventListener('dragenter', handleDragEnter as unknown as EventListener);
      libraryPage?.removeEventListener('dragleave', handleDragLeave as unknown as EventListener);
      libraryPage?.removeEventListener('drop', handleDrop as unknown as EventListener);
    };

    if (isTauriAppPlatform()) {
      const unlisten = getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === 'over') {
          setIsDragging(true);
        } else if (event.payload.type === 'drop') {
          setIsDragging(false);
          handleDroppedFiles(event.payload.paths);
        } else {
          setIsDragging(false);
        }
      });
      // The native listener AND the DOM listeners must both go, or each
      // group navigation would stack another set of DOM listeners.
      return () => {
        unlisten.then((fn) => fn());
        removeDomListeners();
      };
    }

    return removeDomListeners;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group]);

  return { isDragging };
};
