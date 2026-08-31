import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { throttle } from '@/utils/throttle';

describe('throttle flush/cancel (C-12)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('在节流窗口内只立即调用一次，窗口结束 emit 尾值', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t(1);
    t(2);
    t(3);
    expect(fn).toHaveBeenCalledTimes(1); // 首次立即
    expect(fn).toHaveBeenLastCalledWith(1);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2); // 尾值 3
    expect(fn).toHaveBeenLastCalledWith(3);
  });

  it('flush 立即提交挂起的尾值', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t(1);
    t(2);
    expect(fn).toHaveBeenCalledTimes(1);
    t.flush();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(2);
  });

  it('cancel 清除挂起 timer，之后不再触发', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t(1);
    t(2);
    t.cancel();
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1); // 仅首次立即调用，尾值被取消
  });

  it('flush 后 cancel 不重复写入', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t(1);
    t(2);
    t.flush(); // 提交 2
    t.cancel();
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
