'use client';

import clsx from 'clsx';
import * as React from 'react';
import { useEffect, Suspense } from 'react';

import { useEnv } from '@/context/EnvContext';
import { useTheme } from '@/hooks/useTheme';
import { useLibrary } from '@/hooks/useLibrary';
import { useThemeStore } from '@/store/themeStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useScreenWakeLock } from '@/hooks/useScreenWakeLock';
import { useScreenBrightness } from '@/app/reader/hooks/useScreenBrightness';
import { interceptWindowOpen } from '@/utils/open';
import { mountAdditionalFonts } from '@/styles/fonts';
import { isTauriAppPlatform } from '@/services/environment';
import { getSysFontsList } from '@/utils/bridge';
import { AboutWindow } from '@/components/AboutWindow';
import { KeyboardShortcutsHelp } from '@/components/KeyboardShortcutsHelp';
import { ProofreadRulesManager } from './ProofreadRules';
import { Toast } from '@/components/Toast';
import { getLocale } from '@/utils/misc';
import { initDayjs } from '@/utils/time';
import ReaderContent from './ReaderContent';
import FontSizeOverlay from './FontSizeOverlay';

/*
Z-Index Layering Guide:
---------------------------------
99 – Window Border (Linux only)
     • Ensures the border stays on top of all UI elements.
50 – Loading Progress / Toast Notifications / Dialogs / Popups
     • Includes Settings, About, Updater, KOSync dialogs and Annotation popups.
45 – Sidebar / Notebook (Unpinned)
     • Floats above the content but below global dialogs.
40 – TTS Bar
     • Mini controls for TTS playback on top of the TTS Control.
30 – TTS Control
     • Persistent TTS icon/panel.
20 – Menu / Sidebar / Notebook (Pinned)
     • Docked navigation or note views.
10 – Headerbar / Footbar / Ribbon
     • Top toolbar, bottom footbar and ribbon elements.
 0 – Base Content
     • Main reading area or background content.
*/

const Reader: React.FC<{ ids?: string }> = ({ ids }) => {
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const { libraryLoaded } = useLibrary();
  const { isRoundedWindow } = useThemeStore();

  useTheme({ systemUIVisible: settings.alwaysShowStatusBar, appThemeColor: 'base-100' });
  useScreenWakeLock(settings.screenWakeLock, appService?.hasWindow);
  useScreenBrightness();

  useEffect(() => {
    mountAdditionalFonts(document);
    interceptWindowOpen();
    if (isTauriAppPlatform()) {
      setTimeout(getSysFontsList, 3000);
    }
    initDayjs(getLocale());
  }, []);

  return libraryLoaded && settings.globalReadSettings ? (
    <div
      className={clsx(
        'reader-page bg-base-100 text-base-content full-height select-none overflow-hidden',
        appService?.hasRoundedWindow && isRoundedWindow && 'window-border rounded-window',
      )}
    >
      <Suspense fallback={<div className='full-height'></div>}>
        <ReaderContent ids={ids} settings={settings} />
        <AboutWindow />
        <KeyboardShortcutsHelp />
        <ProofreadRulesManager />
        <FontSizeOverlay />
        <Toast />
      </Suspense>
    </div>
  ) : (
    <div className='full-height bg-base-100'></div>
  );
};

export default Reader;
