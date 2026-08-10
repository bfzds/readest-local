'use client';

import { useEffect } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useReadingWidget } from '@/hooks/useReadingWidget';
import { useSettingsStore } from '@/store/settingsStore';
import { tauriHandleSetAlwaysOnTop } from '@/utils/window';
import Reader from './components/Reader';

// This is only used for the Tauri app in the app router
export default function Page() {
  const { appService } = useEnv();
  const { settings } = useSettingsStore();

  useReadingWidget();

  useEffect(() => {
    if (appService?.hasWindow && settings.alwaysOnTop) {
      tauriHandleSetAlwaysOnTop(settings.alwaysOnTop);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appService?.hasWindow, settings.alwaysOnTop]);

  return (
    <>
      <Reader />
    </>
  );
}
