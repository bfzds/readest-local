interface ThrottleOptions {
  emitLast?: boolean;
}

export type ThrottledFunction<T extends (...args: any[]) => unknown> = ((
  ...args: Parameters<T>
) => void) & {
  /** 立即提交 pending 的尾次调用（若有），并清除待执行 timer。 */
  flush: () => void;
  /** 清除待执行 timer 与挂起的参数，之后 flush 不再写旧值。 */
  cancel: () => void;
};

export const throttle = <T extends (...args: any[]) => void | Promise<void>>(
  func: T,
  delay: number,
  options: ThrottleOptions = { emitLast: true },
): ThrottledFunction<T> => {
  let lastCall = 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;

  const clear = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  };

  const emit = () => {
    if (lastArgs && options.emitLast) {
      const args = lastArgs;
      lastArgs = null;
      func(...args);
    }
  };

  const throttled = ((...args: Parameters<T>): void => {
    const now = Date.now();
    const remaining = delay - (now - lastCall);

    if (remaining <= 0) {
      clear();
      lastCall = now;
      func(...args);
    } else {
      lastArgs = args;
      if (!timeout) {
        timeout = setTimeout(() => {
          timeout = null;
          emit();
        }, remaining);
      }
    }
  }) as ThrottledFunction<T>;

  throttled.flush = () => {
    clear();
    emit();
  };

  throttled.cancel = () => {
    clear();
    lastArgs = null;
  };

  return throttled;
};
