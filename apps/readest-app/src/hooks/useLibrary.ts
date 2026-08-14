import { useEffect, useRef, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';

export const useLibrary = () => {
  const { envConfig } = useEnv();
  // per-field selector（B4）：只订阅 setLibrary 与 libraryLoaded。此前解构
  // `useLibraryStore()` 订阅整个 store，Reader.tsx 通过 useLibrary 挂在树顶，
  // 每页翻页的 updateBookProgress（O(n) 全库拷贝）都会触发整棵 reader 树重渲。
  const setLibrary = useLibraryStore((s) => s.setLibrary);
  const storeLibraryLoaded = useLibraryStore((s) => s.libraryLoaded);
  const { setSettings } = useSettingsStore();
  // Skip the disk reload when another mount has already populated the store —
  // re-reading would clobber transient in-memory entries (e.g. OPDS-PSE
  // streamed books) that aren't persisted to disk.
  const [libraryLoaded, setLibraryLoaded] = useState(storeLibraryLoaded);
  const isInitiating = useRef(false);

  useEffect(() => {
    if (isInitiating.current || storeLibraryLoaded) {
      if (storeLibraryLoaded && !libraryLoaded) {
        setLibraryLoaded(true);
      }
      return;
    }
    isInitiating.current = true;
    const initLibrary = async () => {
      const appService = await envConfig.getAppService();
      const settings = await appService.loadSettings();
      setSettings(settings);
      setLibrary(await appService.loadLibraryBooks());
      setLibraryLoaded(true);
    };

    initLibrary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeLibraryLoaded]);

  return { libraryLoaded };
};
