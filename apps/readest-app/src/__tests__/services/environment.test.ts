import { describe, test, expect, beforeEach, vi } from 'vitest';

// We need to reset modules between tests to pick up env var changes,
// so we import dynamically in each test or test group.

// Cast process.env to a mutable record for test manipulation
const env = process.env as Record<string, string | undefined>;
const originalEnv = { ...env };

beforeEach(() => {
  vi.resetModules();
  Object.keys(env).forEach((key) => delete env[key]);
  Object.assign(env, originalEnv);
  // Clean up any window globals we set
  delete (window as unknown as Record<string, unknown>)['__READEST_CLI_ACCESS'];
  delete (window as unknown as Record<string, unknown>)['__READEST_RUNTIME_CONFIG'];
});

describe('environment', () => {
  // ── isTauriAppPlatform ─────────────────────────────────────────
  describe('isTauriAppPlatform', () => {
    test('returns true when NEXT_PUBLIC_APP_PLATFORM is tauri', async () => {
      env['NEXT_PUBLIC_APP_PLATFORM'] = 'tauri';
      const { isTauriAppPlatform } = await import('@/services/environment');
      expect(isTauriAppPlatform()).toBe(true);
    });

    test('returns false when NEXT_PUBLIC_APP_PLATFORM is web', async () => {
      env['NEXT_PUBLIC_APP_PLATFORM'] = 'web';
      const { isTauriAppPlatform } = await import('@/services/environment');
      expect(isTauriAppPlatform()).toBe(false);
    });

    test('returns false when NEXT_PUBLIC_APP_PLATFORM is not set', async () => {
      delete env['NEXT_PUBLIC_APP_PLATFORM'];
      const { isTauriAppPlatform } = await import('@/services/environment');
      expect(isTauriAppPlatform()).toBe(false);
    });
  });

  // ── isWebAppPlatform ───────────────────────────────────────────
  describe('isWebAppPlatform', () => {
    test('returns true when NEXT_PUBLIC_APP_PLATFORM is web', async () => {
      env['NEXT_PUBLIC_APP_PLATFORM'] = 'web';
      const { isWebAppPlatform } = await import('@/services/environment');
      expect(isWebAppPlatform()).toBe(true);
    });

    test('returns false when NEXT_PUBLIC_APP_PLATFORM is tauri', async () => {
      env['NEXT_PUBLIC_APP_PLATFORM'] = 'tauri';
      const { isWebAppPlatform } = await import('@/services/environment');
      expect(isWebAppPlatform()).toBe(false);
    });

    test('returns false when NEXT_PUBLIC_APP_PLATFORM is not set', async () => {
      delete env['NEXT_PUBLIC_APP_PLATFORM'];
      const { isWebAppPlatform } = await import('@/services/environment');
      expect(isWebAppPlatform()).toBe(false);
    });
  });

  // ── hasCli ─────────────────────────────────────────────────────
  describe('hasCli', () => {
    test('returns true when __READEST_CLI_ACCESS is true', async () => {
      window.__READEST_CLI_ACCESS = true;
      const { hasCli } = await import('@/services/environment');
      expect(hasCli()).toBe(true);
    });

    test('returns false when __READEST_CLI_ACCESS is not set', async () => {
      const { hasCli } = await import('@/services/environment');
      expect(hasCli()).toBe(false);
    });

    test('returns false when __READEST_CLI_ACCESS is explicitly false', async () => {
      window.__READEST_CLI_ACCESS = false;
      const { hasCli } = await import('@/services/environment');
      expect(hasCli()).toBe(false);
    });
  });

  // ── isPWA ──────────────────────────────────────────────────────
  describe('isPWA', () => {
    test('returns false by default (jsdom matchMedia mock returns false)', async () => {
      const { isPWA } = await import('@/services/environment');
      expect(isPWA()).toBe(false);
    });

    test('returns true when display-mode is standalone', async () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi
        .fn()
        .mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;

      const { isPWA } = await import('@/services/environment');
      expect(isPWA()).toBe(true);

      window.matchMedia = originalMatchMedia;
    });
  });

  // ── environmentConfig default export ───────────────────────────
  describe('environmentConfig', () => {
    test('exports an object with getAppService function', async () => {
      const envConfig = await import('@/services/environment');
      expect(typeof envConfig.default.getAppService).toBe('function');
    });
  });
});
