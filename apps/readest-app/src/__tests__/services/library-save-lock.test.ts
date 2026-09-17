import { describe, it, expect, vi, afterEach } from 'vitest';
import { LOCK_RENEW_INTERVAL_MS, runWithLibraryLock } from '@/services/librarySaveLock';
import type { LibraryLock } from '@/types/system';

const makeOps = () => {
  const lock: LibraryLock = { path: '/tmp/library.lock', token: 'tok-1' };
  return {
    lock,
    acquire: vi.fn(async (): Promise<LibraryLock | null> => lock),
    renew: vi.fn(async (_lock: LibraryLock): Promise<void> => {}),
    release: vi.fn(async (_lock: LibraryLock): Promise<void> => {}),
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('runWithLibraryLock', () => {
  it('takes the lock, runs the task, and releases afterwards', async () => {
    const ops = makeOps();
    const result = await runWithLibraryLock(ops, async () => 'saved');

    expect(result).toBe('saved');
    expect(ops.acquire).toHaveBeenCalledTimes(1);
    expect(ops.release).toHaveBeenCalledWith(ops.lock);
  });

  // 关键回归：租约续期必须只发生在保存进行期间。真机上那次毒锁就是"保存已经
  // 结束、锁却一直被保鲜"，所以这里锁死"任务结束后不再续期"。
  it('renews while the task runs and stops renewing once it settles', async () => {
    vi.useFakeTimers();
    const ops = makeOps();
    let finish: (() => void) | null = null;
    const task = new Promise<string>((resolve) => {
      finish = () => resolve('saved');
    });

    const running = runWithLibraryLock(ops, () => task);
    await vi.advanceTimersByTimeAsync(LOCK_RENEW_INTERVAL_MS * 3);
    expect(ops.renew).toHaveBeenCalledTimes(3);

    finish!();
    await running;
    const callsWhenSettled = ops.renew.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LOCK_RENEW_INTERVAL_MS * 5);
    expect(ops.renew.mock.calls.length).toBe(callsWhenSettled);
  });

  it('releases the lock even when the task throws, and rethrows', async () => {
    const ops = makeOps();
    await expect(
      runWithLibraryLock(ops, async () => {
        throw new Error('disk full');
      }),
    ).rejects.toThrow('disk full');

    expect(ops.release).toHaveBeenCalledWith(ops.lock);
  });

  // 释放失败不能改判保存结果（数据已落盘），但必须停止续期——锁交给 Rust 侧的
  // 退避重试与租约老化兜底。
  it('keeps the save result when releasing fails, and stops renewing', async () => {
    vi.useFakeTimers();
    const ops = makeOps();
    ops.release.mockRejectedValue(new Error('sharing violation'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runWithLibraryLock(ops, async () => 'saved')).resolves.toBe('saved');

    const callsWhenSettled = ops.renew.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LOCK_RENEW_INTERVAL_MS * 5);
    expect(ops.renew.mock.calls.length).toBe(callsWhenSettled);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  // 续期失败（锁已被回收/他人接管）说明本窗口已不再持有锁，必须立即停止续期，
  // 否则会对着空气续期、并掩盖"这次保存的写已经被别人插队"的事实。
  it('stops renewing when a renewal fails', async () => {
    vi.useFakeTimers();
    const ops = makeOps();
    ops.renew.mockRejectedValue(new Error('owned by another token'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let finish: (() => void) | null = null;
    const task = new Promise<string>((resolve) => {
      finish = () => resolve('saved');
    });

    const running = runWithLibraryLock(ops, () => task);
    await vi.advanceTimersByTimeAsync(LOCK_RENEW_INTERVAL_MS * 4);
    expect(ops.renew).toHaveBeenCalledTimes(1);

    finish!();
    await running;
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('runs the task without a lock when the platform has none', async () => {
    const ops = makeOps();
    ops.acquire.mockResolvedValue(null);

    await expect(runWithLibraryLock(ops, async () => 'saved')).resolves.toBe('saved');
    expect(ops.release).not.toHaveBeenCalled();
  });
});
