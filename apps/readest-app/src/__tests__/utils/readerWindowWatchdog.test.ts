import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// B3：看门狗销毁僵尸 reader 后必须唤醒可能被 Plan A 隐藏的书库窗口，否则
// 无可见窗口但进程残留。watchdog 只在 main 窗口注册，getCurrentWindow 即 main。
const h = vi.hoisted(() => ({
  listeners: {} as Record<string, Array<(e: { payload: unknown }) => void>>,
  showMock: vi.fn(() => Promise.resolve()),
  unminimizeMock: vi.fn(() => Promise.resolve()),
  setFocusMock: vi.fn(() => Promise.resolve()),
  destroyMock: vi.fn(() => Promise.resolve()),
  getByLabelMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    (h.listeners[name] ??= []).push(cb);
    return Promise.resolve(() => {});
  },
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    show: h.showMock,
    unminimize: h.unminimizeMock,
    setFocus: h.setFocusMock,
  }),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: { getByLabel: h.getByLabelMock },
}));

import { startReaderWindowWatchdog } from '@/utils/readerWindowWatchdog';

describe('readerWindowWatchdog（B3）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.listeners = {};
    h.getByLabelMock.mockReset();
    h.getByLabelMock.mockResolvedValue({ destroy: h.destroyMock });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const emit = async (name: string, payload: unknown) => {
    for (const cb of h.listeners[name] ?? []) {
      cb({ payload });
    }
    await vi.advanceTimersByTimeAsync(0);
  };

  it('心跳正常时看门狗不销毁窗口', async () => {
    const stop = startReaderWindowWatchdog();
    await emit('reader-window-alive', { label: 'reader' });
    await vi.advanceTimersByTimeAsync(15000);
    expect(h.getByLabelMock).not.toHaveBeenCalled();
    stop();
  });

  it('心跳停止超过 20s 后销毁僵尸 reader 并唤醒书库窗口', async () => {
    const stop = startReaderWindowWatchdog();
    await emit('reader-window-alive', { label: 'reader' });
    await vi.advanceTimersByTimeAsync(25000);

    expect(h.getByLabelMock).toHaveBeenCalledWith('reader');
    expect(h.destroyMock).toHaveBeenCalled();
    expect(h.showMock).toHaveBeenCalled();
    expect(h.unminimizeMock).toHaveBeenCalled();
    expect(h.setFocusMock).toHaveBeenCalled();
    stop();
  });

  it('normal close（close-reader-window）移出跟踪后不再被销毁', async () => {
    const stop = startReaderWindowWatchdog();
    await emit('reader-window-alive', { label: 'reader' });
    await emit('close-reader-window', { label: 'reader' });
    await vi.advanceTimersByTimeAsync(25000);
    expect(h.getByLabelMock).not.toHaveBeenCalled();
    stop();
  });
});
