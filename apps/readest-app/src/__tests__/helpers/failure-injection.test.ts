import { describe, expect, test, vi, afterEach } from 'vitest';
import {
  failOnNthCall,
  makeControllableSpeak,
  makeDelayedSpeak,
  useFakeTimersForStore,
} from './failure-injection';
import type { TTSMessageEvent } from '@/services/tts/TTSClient';

describe('failOnNthCall', () => {
  test('透传所有调用（无失败点）', async () => {
    const calls: string[] = [];
    const fn = failOnNthCall(
      async (x: string) => {
        calls.push(x);
      },
      { at: 999 },
    );
    await fn('a');
    await fn('b');
    expect(calls).toEqual(['a', 'b']);
  });

  test('在第 N 次调用抛错，其余正常', async () => {
    const fn = failOnNthCall(async () => {}, { at: 2 });
    const seen: Array<'ok' | 'reject'> = [];
    await fn().then(
      () => seen.push('ok'),
      () => seen.push('reject'),
    );
    await fn().then(
      () => seen.push('ok'),
      () => seen.push('reject'),
    );
    await fn().then(
      () => seen.push('ok'),
      () => seen.push('reject'),
    );
    expect(seen).toEqual(['ok', 'reject', 'ok']);
  });

  test('可自定义错误类型', async () => {
    const boom = new RangeError('fs unwritable');
    const fn = failOnNthCall(async () => {}, { at: 1, error: boom });
    await expect(fn()).rejects.toBe(boom);
  });

  test('错误以拒绝 promise 形式呈现（async 调用方 await 语义）', async () => {
    const fn = failOnNthCall(async () => 1 as const, { at: 1 });
    await expect(fn()).rejects.toThrow('Injected failure');
  });
});

describe('makeControllableSpeak', () => {
  test('emit 的事件按序 yield', async () => {
    const { speak, handles } = makeControllableSpeak<TTSMessageEvent>();
    const iter = speak();
    const first = iter.next(); // 消费端挂起等待

    await handles[0]!.emit({ code: 'boundary', message: 'chunk', mark: '0' });
    expect(await first).toEqual({
      done: false,
      value: { code: 'boundary', message: 'chunk', mark: '0' },
    });

    await handles[0]!.end();
    expect(await iter.next()).toEqual({ done: true, value: undefined });
  });

  test('end 后生成器进入 done，closed 报告 end', async () => {
    const { speak, handles } = makeControllableSpeak<TTSMessageEvent>();
    const iter = speak();
    const closed = handles[0]!.closed;
    await handles[0]!.end();
    await iter.next();
    expect(await closed).toBe('end');
  });

  test('fail 让生成器抛错，closed 报告 error', async () => {
    const { speak, handles } = makeControllableSpeak<TTSMessageEvent>();
    const iter = speak();
    const closed = handles[0]!.closed;
    await handles[0]!.fail(new Error('engine down'));
    await expect(iter.next()).rejects.toThrow('engine down');
    expect(await closed).toBe('error');
  });

  test('晚到 finally 编排：旧会话卡住时新会话已开始并完成，旧会话随后才收尾', async () => {
    const { speak, handles } = makeControllableSpeak<TTSMessageEvent>();
    // 旧会话：生成器已挂起，不手动驱动（模拟卡住的慢引擎）
    const oldIter = speak();
    const oldClosed = handles[0]!.closed;

    // 新会话：正常跑完
    const newIter = speak();
    await handles[1]!.emit({ code: 'boundary', message: 'chunk', mark: '0' });
    expect((await newIter.next()).value).toMatchObject({ code: 'boundary' });
    await handles[1]!.end();
    expect((await newIter.next()).done).toBe(true);

    // 旧会话此刻仍未收尾 —— 代表"旧 finally 迟到"的竞态窗口仍然敞开着
    const oldSettled = oldClosed.then(
      () => 'closed',
      () => 'closed',
    );
    expect(await Promise.race([oldSettled, Promise.resolve('pending')])).toBe('pending');

    // 旧会话在此才收尾 —— 晚到 finally 恰在新会话进行/结束后发生
    await handles[0]!.end();
    expect(await oldClosed).toBe('end');
    await oldIter.next();
  });

  test('同一 speak 流多次 emit 保持顺序', async () => {
    const { speak, handles } = makeControllableSpeak<TTSMessageEvent>();
    const iter = speak();
    const p1 = iter.next();
    await handles[0]!.emit({ code: 'boundary', message: 'one', mark: '0' });
    expect((await p1).value).toMatchObject({ message: 'one' });
    const p2 = iter.next();
    await handles[0]!.emit({ code: 'boundary', message: 'two', mark: '1' });
    expect((await p2).value).toMatchObject({ message: 'two' });
  });
});

describe('makeDelayedSpeak', () => {
  test('延迟后产出事件', async () => {
    vi.useFakeTimers();
    try {
      const speak = makeDelayedSpeak<TTSMessageEvent>(50, [], { code: 'end' });
      const iter = speak();
      const resolved = vi.fn();
      iter.next().then(resolved, resolved);
      await vi.advanceTimersByTimeAsync(39);
      expect(resolved).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20);
      expect(resolved).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useFakeTimersForStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  useFakeTimersForStore();

  test('启用 fake timers 且测试后清空残留计时器', () => {
    expect(vi.isFakeTimers()).toBe(true);
    vi.setSystemTime(1_000_000);
    expect(Date.now()).toBe(1_000_000);
  });
});
