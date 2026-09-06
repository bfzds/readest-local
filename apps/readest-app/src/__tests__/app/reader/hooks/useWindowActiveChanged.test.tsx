import { describe, test, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useWindowActiveChanged } from '@/app/reader/hooks/useWindowActiveChanged';

/**
 * 浏览器 UI 调试模式回归：无 Tauri runtime 时，窗口 active 监听必须退回
 * web 语义（visibilitychange，见本 hook 头注释），而不是调用
 * @tauri-apps/api/window 的 getCurrentWindow()——后者在浏览器里抛
 * "Cannot read properties of undefined (reading 'metadata')"，被 .catch
 * 吃成 console.error，在 dev 面板里反复报 issue。
 *
 * vitest.setup.ts 默认给 jsdom 注入 __TAURI_INTERNALS__（桌面壳），这里
 * 删掉以模拟纯浏览器。
 */
describe('useWindowActiveChanged in a plain browser', () => {
  afterEach(() => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    vi.restoreAllMocks();
  });

  test('falls back to visibilitychange without console errors', async () => {
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onActive = vi.fn();

    renderHook(() => useWindowActiveChanged(onActive));
    // 等待订阅 effect 内的异步链路走完
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    // 模拟标签页隐藏 → active=false
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(onActive).toHaveBeenCalledWith(false);

    // 模拟标签页恢复 → active=true
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(onActive).toHaveBeenLastCalledWith(true);
  });
});
