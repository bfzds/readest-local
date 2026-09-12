import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  emitToMock: vi.fn(() => Promise.resolve()),
  label: 'main',
}));

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: h.emitToMock,
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: h.label }),
}));

import { startMainWindowHeartbeat } from '@/utils/mainWindowHeartbeat';

// 主窗口死信开关的前端半边：JS 每 5 秒发一次 main-window-alive，Rust 看门狗
// 20 秒收不到就 show() + set_decorations(true)，让白屏/加载失败窗口出现原生
// 标题栏（自绘标题栏随 webview 一起死了，原生装饰是 OS 级兜底出口）。
describe('startMainWindowHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.emitToMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits main-window-alive immediately and every 5 seconds from the main window', () => {
    h.label = 'main';
    const stop = startMainWindowHeartbeat();
    expect(h.emitToMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(h.emitToMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(10000);
    expect(h.emitToMock).toHaveBeenCalledTimes(4);
    stop();
    vi.advanceTimersByTime(5000);
    expect(h.emitToMock).toHaveBeenCalledTimes(4);
    expect(h.emitToMock).toHaveBeenCalledWith('main', 'main-window-alive', { label: 'main' });
  });

  it('does not emit from non-main windows (readers have their own heartbeat)', () => {
    h.label = 'reader-1';
    const stop = startMainWindowHeartbeat();
    vi.advanceTimersByTime(20000);
    stop();
    expect(h.emitToMock).not.toHaveBeenCalled();
  });

  it('keeps running when a single emit rejects', () => {
    h.label = 'main';
    h.emitToMock.mockRejectedValueOnce(new Error('gone'));
    const stop = startMainWindowHeartbeat();
    vi.advanceTimersByTime(10000);
    stop();
    // 首发被拒后，后续 interval 仍继续发（3 = 首发 + 2 个周期）
    expect(h.emitToMock).toHaveBeenCalledTimes(3);
  });
});
