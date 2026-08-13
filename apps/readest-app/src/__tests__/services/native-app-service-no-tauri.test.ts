import { describe, test, expect, vi } from 'vitest';

// Simulate a browser without the Tauri runtime: the plugin-os `type()` reads
// `window.__TAURI_OS_PLUGIN_INTERNALS__` and throws a TypeError, exactly what a
// plain browser produces (see the cross-browser blank-screen report).
const osTypeMock = vi.fn().mockImplementation(() => {
  throw new Error('window.__TAURI_OS_PLUGIN_INTERNALS__ is undefined');
});

vi.mock('@tauri-apps/plugin-os', () => ({
  type: () => osTypeMock(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn().mockResolvedValue(false),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readTextFile: vi.fn().mockResolvedValue(''),
  readFile: vi.fn().mockResolvedValue(new Uint8Array()),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readDir: vi.fn().mockResolvedValue([]),
  remove: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: 0 }),
  BaseDirectory: {},
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockRejectedValue(new Error('window.__TAURI_INTERNALS__ is undefined')),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn().mockResolvedValue(null),
  save: vi.fn().mockResolvedValue(null),
  ask: vi.fn().mockResolvedValue(true),
}));

vi.mock('@tauri-apps/api/path', () => ({
  join: (...parts: string[]) => Promise.resolve(parts.join('/')),
  basename: (p: string) => Promise.resolve(p.split('/').pop() ?? p),
  appDataDir: () => Promise.resolve('/tmp/app-data'),
  appConfigDir: () => Promise.resolve('/tmp/app-config'),
  appCacheDir: () => Promise.resolve('/tmp/app-cache'),
  appLogDir: () => Promise.resolve('/tmp/app-log'),
  tempDir: () => Promise.resolve('/tmp'),
}));

vi.mock('@/utils/bridge', () => ({
  copyURIToPath: vi.fn().mockResolvedValue({ path: '' }),
  getStorefrontRegionCode: vi.fn().mockResolvedValue({ regionCode: null }),
  hasAmbientLightSensor: vi.fn().mockResolvedValue({ available: false }),
}));

vi.mock('@/utils/file', () => ({
  NativeFile: class {},
  RemoteFile: class {},
}));

vi.mock('@/utils/files', () => ({
  copyFiles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/settingsService', () => ({
  getDefaultViewSettings: vi.fn().mockReturnValue({}),
  loadSettings: vi.fn().mockResolvedValue({ migrationVersion: 99999999 }),
  saveSettings: vi.fn().mockResolvedValue(undefined),
}));

describe('NativeAppService without the Tauri runtime (browser/web)', () => {
  test('module imports without crashing on a missing Tauri osType', async () => {
    // Regression: the module-level `const OS_TYPE = osType()` used to throw at
    // import time in a plain browser, which blanked the whole page. It must
    // degrade gracefully so callers can surface a descriptive error instead.
    await expect(import('@/services/nativeAppService')).resolves.toBeDefined();
  });

  test('init() rejects with a descriptive error when the Tauri bridge is missing', async () => {
    // Simulate a real browser window without the injected __TAURI_INTERNALS__.
    vi.stubGlobal('window', {});
    vi.resetModules();
    const { NativeAppService } = await import('@/services/nativeAppService');
    const service = new NativeAppService();
    await expect(service.init()).rejects.toThrow(/Tauri|desktop|桌面/i);
    vi.unstubAllGlobals();
  });
});
