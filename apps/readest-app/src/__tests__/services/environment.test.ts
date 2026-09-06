import { describe, test, expect, beforeEach, vi } from 'vitest';
// 浏览器服务用例（getAppService 平台选择）会真正初始化 WebAppService，
// 其数据层是 IndexedDB——jsdom 没有 indexedDB，用 fake-indexeddb 补齐。
import 'fake-indexeddb/auto';

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

    // 浏览器 UI 调试模式：dev server 用 .env.tauri 启动，同一份页面也会喂给
    // 普通浏览器。浏览器里没有 Tauri runtime（window.__TAURI_INTERNALS__），
    // 只看 env 会误判为 tauri，第一处 getCurrentWindow() 就抛
    // "Cannot read properties of undefined (reading 'metadata')"。
    // 客户端必须以运行时探测为准。
    test('returns false in a plain browser even when the build targets tauri', async () => {
      env['NEXT_PUBLIC_APP_PLATFORM'] = 'tauri';
      delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
      const { isTauriAppPlatform } = await import('@/services/environment');
      expect(isTauriAppPlatform()).toBe(false);
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

  // ── environmentConfig default export ───────────────────────────
  describe('environmentConfig', () => {
    test('exports an object with getAppService function', async () => {
      const envConfig = await import('@/services/environment');
      expect(typeof envConfig.default.getAppService).toBe('function');
    });

    // 浏览器 UI 调试模式：无 Tauri runtime 时走 IndexedDB 数据层，
    // 而不是落到 NativeAppService（在浏览器里必然崩）或兜底报错页。
    test('resolves the browser web service in a plain browser', async () => {
      env['NEXT_PUBLIC_APP_PLATFORM'] = 'tauri';
      delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
      const envConfig = await import('@/services/environment');
      const service = await envConfig.default.getAppService();
      expect(service.appPlatform).toBe('web');
      expect(service.hasWindow).toBe(false);
      expect(await service.acquireLibraryLock?.()).toBeNull();
    });
  });
});
