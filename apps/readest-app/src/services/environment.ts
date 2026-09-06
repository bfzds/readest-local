import { AppService } from '@/types/system';

declare global {
  interface Window {
    __READEST_CLI_ACCESS?: boolean;
  }
}

// 平台判定 = 构建期 env 且（客户端）运行时确认：
// - SSR / Node（无 window）：只看构建期 env，保持 Tauri 水合行为与现状一致。
// - 客户端：env 允许 tauri 之外，还要求 Tauri runtime 真在（__TAURI_INTERNALS__）。
//   dev server 用 .env.tauri 启动，同一份页面也会喂给普通浏览器（浏览器 UI
//   调试模式）；浏览器里没有 Tauri runtime，只看 env 会误判，第一处
//   getCurrentWindow() 就会抛 "Cannot read properties of undefined
//   (reading 'metadata')"。运行时探测只收窄、不扩大 env 的判定。
// Tauri webview 保证在应用脚本执行前注入 __TAURI_INTERNALS__，探测可靠。
export const isTauriAppPlatform = () => {
  if (process.env['NEXT_PUBLIC_APP_PLATFORM'] !== 'tauri') return false;
  if (typeof window === 'undefined') return true;
  return '__TAURI_INTERNALS__' in window;
};
export const hasCli = () => window.__READEST_CLI_ACCESS === true;

export const isMacPlatform = () =>
  typeof window !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

export const getCommandPaletteShortcut = () => (isMacPlatform() ? '⌘⇧P' : 'Ctrl+Shift+P');

export interface EnvConfigType {
  getAppService: () => Promise<AppService>;
}

let nativeAppService: AppService | null = null;
const getNativeAppService = async () => {
  if (!nativeAppService) {
    const { NativeAppService } = await import('@/services/nativeAppService');
    nativeAppService = new NativeAppService();
    await nativeAppService.init();
  }
  return nativeAppService;
};

let webAppService: AppService | null = null;
const getWebAppService = async () => {
  if (!webAppService) {
    const { WebAppService } = await import('@/services/webAppService');
    webAppService = new WebAppService();
    await webAppService.init();
  }
  return webAppService;
};

const environmentConfig: EnvConfigType = {
  getAppService: async () => {
    // 浏览器 UI 调试模式：dev server 会把 tauri 构建喂给普通浏览器，
    // 此时 isTauriAppPlatform() 为 false（运行时探测），落 IndexedDB 数据层。
    if (!isTauriAppPlatform()) {
      return getWebAppService();
    }
    return getNativeAppService();
  },
};

/**
 * Synchronously returns the app service if it has already been created by
 * {@link environmentConfig.getAppService}; null before first init. The async
 * getter is preferred everywhere — use this only from synchronous code paths
 * that run well after startup (e.g. capability checks during reader render),
 * where the singleton is guaranteed to exist.
 */
export const getInitializedAppService = (): AppService | null => nativeAppService;

export default environmentConfig;
