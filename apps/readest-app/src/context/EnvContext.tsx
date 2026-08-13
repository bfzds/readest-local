'use client';

import React, { createContext, useContext, useState, useMemo, ReactNode } from 'react';
import { EnvConfigType } from '../services/environment';
import { AppService } from '@/types/system';
import env from '../services/environment';

interface EnvContextType {
  envConfig: EnvConfigType;
  appService: AppService | null;
}

const EnvContext = createContext<EnvContextType | undefined>(undefined);

export const EnvProvider = ({ children }: { children: ReactNode }) => {
  const [envConfig] = useState<EnvConfigType>(env);
  const [appService, setAppService] = useState<AppService | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  React.useEffect(() => {
    envConfig
      .getAppService()
      .then((service) => {
        setAppService(service);
      })
      .catch((error) => {
        // e.g. the app is loaded in a plain browser without the Tauri runtime.
        // Show guidance instead of leaving a blank page behind.
        console.error('Failed to initialize app service:', error);
        setInitError(error instanceof Error ? error.message : String(error));
      });
    window.addEventListener('error', (e) => {
      if (e.message === 'ResizeObserver loop limit exceeded') {
        e.stopImmediatePropagation();
        e.preventDefault();
        return true;
      }
      return false;
    });
  }, [envConfig]);

  const value = useMemo(() => ({ envConfig, appService }), [envConfig, appService]);

  if (initError) {
    return (
      <div className='flex h-dvh w-full flex-col items-center justify-center gap-3 bg-base-100 px-8 text-center text-base-content'>
        <h1 className='text-xl font-semibold'>Readest 需要桌面环境</h1>
        <p className='text-sm opacity-80'>
          Readest 是桌面应用，请在桌面端运行，不要直接在浏览器中打开。
        </p>
        <p className='max-w-md text-xs opacity-60'>{initError}</p>
      </div>
    );
  }

  return <EnvContext.Provider value={value}>{children}</EnvContext.Provider>;
};

export const useEnv = (): EnvContextType => {
  const context = useContext(EnvContext);
  if (!context) throw new Error('useEnv must be used within EnvProvider');
  return context;
};
