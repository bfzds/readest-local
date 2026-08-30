// 故障注入护栏（仅测试辅助）。
//
// 让"数据丢失/竞态"回归测试能注入单点失败，不依赖手工断电或随机复现：
//  1. failOnNthCall —— 包装 fs/AppService 方法，在第 N 次调用（1-based）抛错，
//     用于把多步骤事务（writeFile / removeDir / saveLibraryBooks 等）精确打断。
//  2. makeControllableSpeak —— fake TTS client 可编排的 speak 生成器：支持
//     emit/end/fail 手动驱动、abort 不响应（卡住模拟慢网络）、晚到 finally
//     （旧会话在新会话开始后才收尾，复现 C-5 的 abort 竞态）。
//  3. useFakeTimersForStore —— store 测试 fake timer 的统一初始化与清理，
//     避免节流 setTimeout（如 LIBRARY_SAVE_THROTTLE_MS）泄漏到其他测试。

import { beforeEach, afterEach, vi } from 'vitest';
import type { TTSMessageEvent } from '@/services/tts/TTSClient';

export interface NthFailure {
  /** 1-based 调用序号，第几次调用抛错 */
  at: number;
  /** 要抛的错误，默认 RuntimeError */
  error?: Error;
}

/**
 * 包装一个 async 方法，使其在第 `at` 次调用抛错，其余调用透传。
 * 因所有 FileSystem/AppService 落盘方法均为 async，包装器统一返回 Promise。
 */
export function failOnNthCall<Args extends unknown[], R>(
  impl: (...args: Args) => Promise<R>,
  { at, error }: NthFailure,
): (...args: Args) => Promise<R> {
  let call = 0;
  return async (...args) => {
    call += 1;
    if (call === at) {
      throw error ?? new Error(`Injected failure at call #${at}`);
    }
    return impl(...args);
  };
}

/** 生成器是否可继续消费；用于断言旧会话在 stop() 后是否被真正关闭。 */
export type ControlledSpeakCloseReason = 'end' | 'error';

export interface ControllableSpeakHandle<T = TTSMessageEvent> {
  /** 让生成器 yield 该事件；返回的 promise 在事件被消费端拉取后 resolve。 */
  emit(event: T): Promise<void>;
  /** 正常结束生成器（触发 for-await 返回，进入 speak 的 finally）。 */
  end(): Promise<void>;
  /** 让生成器抛错（触发 speak 的 catch 分支）。 */
  fail(error: Error): Promise<void>;
  /** 生成器已关闭（end/fail 已完成消费端返回）的 promise。 */
  readonly closed: Promise<ControlledSpeakCloseReason>;
  /** 是否要求生成器忽略外部 abort signal（模拟卡住会话）。 */
  ignoreAbort: boolean;
}

interface QueueItem<T> {
  type: 'value' | 'end' | 'error';
  value?: T;
  error?: Error;
}

interface ControllableSpeakHandleInternal<T> extends ControllableSpeakHandle<T> {
  waitForItem(): Promise<QueueItem<T>>;
}

const createHandle = <T>(
  emitDelayMs: number,
  delay: (ms: number) => Promise<void>,
): ControllableSpeakHandleInternal<T> => {
  const queue: QueueItem<T>[] = [];
  const waiters: Array<() => void> = [];
  let closeResolve: (r: ControlledSpeakCloseReason) => void = () => {};
  let ended = false;
  const closed = new Promise<ControlledSpeakCloseReason>((r) => (closeResolve = r));

  const push = (item: QueueItem<T>) => {
    queue.push(item);
    const pending = waiters.splice(0);
    for (const wake of pending) wake();
  };

  return {
    ignoreAbort: false,
    emit: async (event: T) => {
      if (ended) return;
      if (emitDelayMs > 0) await delay(emitDelayMs);
      push({ type: 'value', value: event });
    },
    end: async () => {
      if (ended) return;
      push({ type: 'end' });
      ended = true;
      closeResolve('end');
    },
    fail: async (error: Error) => {
      if (ended) return;
      push({ type: 'error', error });
      ended = true;
      closeResolve('error');
    },
    closed,
    async waitForItem() {
      while (queue.length === 0) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      return queue.shift()!;
    },
  };
};

/**
 * 构造一个可编排的 TTS `speak` mock。每次调用 speak 都生成一个独立 handle：
 * 测试用 emit/end/fail 按时序驱动它，从而精确复现 delay、abort 不响应、
 * 晚到 finally 等竞态。
 *
 * handle 在 speak() 调用时同步创建，因此测试可立即访问 handles[i]，
 * 无需先 await 首次 next()。
 */
export function makeControllableSpeak<T = TTSMessageEvent>(
  opts: {
    /** 每次 emit 前插入的固定延迟（模拟慢引擎）。 */
    emitDelayMs?: number;
  } = {},
) {
  const handles: ControllableSpeakHandle<T>[] = [];
  const { emitDelayMs = 0 } = opts;
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const speak = (): AsyncGenerator<T, void, unknown> => {
    const handle = createHandle<T>(emitDelayMs, delay);
    handles.push(handle);
    return (async function* () {
      for (;;) {
        const item = await handle.waitForItem();
        if (item.type === 'value') {
          yield item.value!;
        } else if (item.type === 'end') {
          return;
        } else {
          throw item.error;
        }
      }
    })();
  };

  return { speak, handles };
}

/**
 * 简单延迟版 speak：拿到 ssml 后 sleep `delayMs` 再 yield 一个 end。
 * 用于"可控延迟/无 abort 响应"的最小场景（不需手动编排）。
 */
export function makeDelayedSpeak<T = TTSMessageEvent>(
  delayMs: number,
  events: T[] = [],
  endEvent?: T,
) {
  return async function* speak(): AsyncGenerator<T, void, unknown> {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    for (const event of events) yield event;
    if (endEvent) yield endEvent;
  };
}

/**
 * store 测试的 fake timer 生命周期。放进 describe 顶层：
 *   useFakeTimersForStore();
 * 每个测试前启用 fake timers，测试后清空残留计时器并复位真实时钟，
 * 防止节流保存等 setTimeout 把副作用泄漏进其它测试。
 */
export function useFakeTimersForStore(): void {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
}
