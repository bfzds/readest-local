/**
 * System-dictionary native dispatch.
 *
 * The handoff must route by the *real* native OS, taken from the app service's
 * `is*App` capability flags — not the user agent. iPadOS sends a desktop
 * "Macintosh" UA, so a UA-based check reports iPad as 'macos' and the old
 * dispatch hit the macOS-only bare `show_lookup_popover` command, which iOS
 * doesn't register ("Command show_lookup_popover not found"). `appService`
 * derives its flags from the Tauri OS plugin, so `isIOSApp` is true on iPad
 * and routes it to the iOS plugin command path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type OsFlags = { isMacOSApp: boolean; isIOSApp: boolean; isAndroidApp: boolean };

const env = vi.hoisted(() => ({ tauri: true }));
const appService = vi.hoisted(
  () => ({ value: null as OsFlags | null }) as { value: OsFlags | null },
);
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => env.tauri,
  getInitializedAppService: () => appService.value,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'main' }),
}));

import {
  clearRememberedLookupApp,
  getRememberedLookupApp,
  invokeSystemDictionary,
  isSystemDictionarySupported,
} from '@/services/dictionaries/systemDictionary';

const MACOS_CMD = 'show_lookup_popover';
const PLUGIN_CMD = 'plugin:native-bridge|show_lookup_popover';

const flags = (os: 'macos' | 'ios' | 'android'): OsFlags => ({
  isMacOSApp: os === 'macos',
  isIOSApp: os === 'ios',
  isAndroidApp: os === 'android',
});

beforeEach(() => {
  env.tauri = true;
  // Default to iPad: native ios despite the desktop "Macintosh" UA.
  appService.value = flags('ios');
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === PLUGIN_CMD) return { success: true };
    return undefined; // macOS bare command resolves (no throw) when it exists
  });
});

describe('invokeSystemDictionary — native dispatch', () => {
  it('routes a real macOS desktop to the bare Rust command', async () => {
    appService.value = flags('macos');

    const ok = await invokeSystemDictionary('hello');

    expect(ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith(
      MACOS_CMD,
      expect.objectContaining({ word: 'hello', windowLabel: 'main' }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith(PLUGIN_CMD, expect.anything());
  });

  it('is a no-op on other platforms (only macOS dispatches)', async () => {
    appService.value = flags('ios');

    const ok = await invokeSystemDictionary('hello');

    expect(ok).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('is a no-op when the app service is not yet initialized', async () => {
    appService.value = null;

    const ok = await invokeSystemDictionary('hello');

    expect(ok).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

const GET_LOOKUP_CMD = 'plugin:native-bridge|get_lookup_dictionary';
const CLEAR_LOOKUP_CMD = 'plugin:native-bridge|clear_lookup_dictionary';

describe('getRememberedLookupApp', () => {
  it('is a no-op on desktop (Android-only feature)', async () => {
    appService.value = flags('macos');
    invokeMock.mockResolvedValueOnce({ packageName: 'com.eusoft.eudic', label: 'Eudic' });

    expect(await getRememberedLookupApp()).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith(GET_LOOKUP_CMD);
  });
});

describe('clearRememberedLookupApp', () => {
  it('is a no-op on desktop (Android-only feature)', async () => {
    appService.value = flags('macos');

    await clearRememberedLookupApp();

    expect(invokeMock).not.toHaveBeenCalledWith(CLEAR_LOOKUP_CMD);
  });
});

describe('isSystemDictionarySupported', () => {
  it('is supported on macOS', () => {
    appService.value = flags('macos');
    expect(isSystemDictionarySupported()).toBe(true);
  });

  it('is not supported on other platforms', () => {
    appService.value = flags('ios');
    expect(isSystemDictionarySupported()).toBe(false);
    appService.value = { isMacOSApp: false, isIOSApp: false, isAndroidApp: false };
    expect(isSystemDictionarySupported()).toBe(false);
  });

  it('is not supported before the app service is initialized', () => {
    appService.value = null;
    expect(isSystemDictionarySupported()).toBe(false);
  });
});
