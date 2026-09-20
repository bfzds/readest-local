import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createThrottledCheckpoint } from '@/utils/checkpoint';

// The checkpoint is the only thing standing between a killed import and a
// library index that never reached disk (#5601), and the import finalization
// relies on `flush` surfacing a failed save rather than swallowing it.
describe('createThrottledCheckpoint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-20T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('the first touch saves immediately', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const checkpoint = createThrottledCheckpoint(save, 15_000);

    checkpoint.touch();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  });

  test('touches within the interval do not save again, and a later one does', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const checkpoint = createThrottledCheckpoint(save, 15_000);

    checkpoint.touch();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    // Inside the interval: state is still marked dirty, but saving it again
    // would bring back the "library.json save dominates large imports" cost.
    vi.advanceTimersByTime(5_000);
    checkpoint.touch();
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(15_000);
    checkpoint.touch();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  });

  test('a failed touch-save stays dirty and a later flush retries it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('library lock timeout'))
      .mockResolvedValue(undefined);
    const checkpoint = createThrottledCheckpoint(save, 15_000);

    checkpoint.touch();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // touch()'s own save is fire-and-forget and must not reject unhandled.
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    // The failure kept the checkpoint dirty, so flush persists the state
    // instead of assuming the earlier save covered it.
    await checkpoint.flush();
    expect(save).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  test('flush propagates a failed save that was still in flight', async () => {
    // The import finalization calls flush right after its last touch, so the
    // final save can still be in flight when flush enters. It has to observe
    // that save's outcome itself: touch()'s own catch handler is attached to a
    // promise derived from `.finally()`, so it runs a microtask later, and a
    // flush that just waited it out could re-check, exit, and report success
    // for a save that failed (review finding F1).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const save = vi.fn().mockRejectedValue(new Error('disk full'));
    const checkpoint = createThrottledCheckpoint(save, 15_000);

    checkpoint.touch(); // the save is in flight, not drained

    await expect(checkpoint.flush()).rejects.toThrow('disk full');
    // The retry flush performed is the one that reported the failure.
    expect(save).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  test('flush propagates a failed save after the touch-save already settled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const save = vi.fn().mockRejectedValue(new Error('disk full'));
    const checkpoint = createThrottledCheckpoint(save, 15_000);

    checkpoint.touch(); // its own fire-and-forget save fails, leaving it dirty
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    await expect(checkpoint.flush()).rejects.toThrow('disk full');
    warn.mockRestore();
  });

  test('flush waits for an in-flight save, then persists what it missed', async () => {
    let releaseSave: (() => void) | undefined;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseSave = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const checkpoint = createThrottledCheckpoint(save, 15_000);

    checkpoint.touch(); // starts a save that stays in flight
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    // A touch while that save is in flight marks the state dirty.
    checkpoint.touch();
    const flushed = checkpoint.flush();
    let settled = false;
    void flushed.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseSave?.();
    await flushed;
    // The in-flight save and the flush-initiated one never overlapped, and the
    // flush covered the touch that landed during the first.
    expect(save).toHaveBeenCalledTimes(2);
  });

  test('flush on a clean checkpoint saves nothing', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const checkpoint = createThrottledCheckpoint(save, 15_000);

    await checkpoint.flush();
    expect(save).not.toHaveBeenCalled();
  });

  test('flush after a successful touch does not save a second time', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const checkpoint = createThrottledCheckpoint(save, 15_000);

    checkpoint.touch();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    await checkpoint.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });
});
