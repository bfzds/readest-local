import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// `getUnavailableLibraryRoot` exists so the library page can name a bad data
// directory even when that directory made `init` itself throw (review finding
// F3): the service is deliberately not published then, so the value has to
// survive outside the singleton.
const h = vi.hoisted(() => ({
  initError: null as Error | null,
  unavailableRootDir: null as string | null,
  initCount: 0,
}));

vi.mock('@/services/nativeAppService', () => ({
  NativeAppService: class {
    unavailableRootDir: string | null = null;

    async init(): Promise<void> {
      h.initCount += 1;
      this.unavailableRootDir = h.unavailableRootDir;
      if (h.initError) throw h.initError;
    }
  },
}));

const loadEnvironment = async () => {
  vi.resetModules();
  return await import('@/services/environment');
};

describe('getUnavailableLibraryRoot', () => {
  const previousPlatform = process.env['NEXT_PUBLIC_APP_PLATFORM'];

  beforeEach(() => {
    h.initError = null;
    h.unavailableRootDir = null;
    h.initCount = 0;
    // Take the native branch of `getAppService`: `isTauriAppPlatform` reads
    // both the build-time env and the runtime marker.
    process.env['NEXT_PUBLIC_APP_PLATFORM'] = 'tauri';
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    process.env['NEXT_PUBLIC_APP_PLATFORM'] = previousPlatform;
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  test('reports the folder when a successful init found the root unusable', async () => {
    h.unavailableRootDir = '/mnt/books';
    const environment = await loadEnvironment();

    await expect(environment.default.getAppService()).resolves.toBeTruthy();

    expect(environment.getUnavailableLibraryRoot()).toBe('/mnt/books');
  });

  test('reports the folder even when the init itself throws', async () => {
    h.unavailableRootDir = '/mnt/unplugged';
    h.initError = new Error('sandbox denied');
    const environment = await loadEnvironment();

    await expect(environment.default.getAppService()).rejects.toThrow('sandbox denied');

    // The singleton stayed unpublished (that is the point of the ordering
    // fix) — the root still has to be nameable.
    expect(environment.getInitializedAppService()).toBeNull();
    expect(environment.getUnavailableLibraryRoot()).toBe('/mnt/unplugged');
  });

  test('stays null when the root is fine, and a successful init is cached', async () => {
    const environment = await loadEnvironment();

    await environment.default.getAppService();
    expect(environment.getUnavailableLibraryRoot()).toBeNull();

    // The ordering fix publishes the singleton only on success — so a second
    // call reuses it instead of initializing again.
    await environment.default.getAppService();
    expect(h.initCount).toBe(1);
    expect(environment.getInitializedAppService()).not.toBeNull();
  });
});
