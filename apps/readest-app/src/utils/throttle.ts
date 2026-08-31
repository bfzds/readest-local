interface ThrottleOptions {
  emitLast?: boolean;
}

export type ThrottledFunction<TArgs extends unknown[]> = ((...args: TArgs) => void) & {
  /** 立即提交 pending 的尾次调用（若有），并清除待执行 timer。 */
  flush: () => void;
  /** 清除待执行 timer 与挂起的参数，之后 flush 不再写旧值。 */
  cancel: () => void;
};

export const throttle = <TArgs extends unknown[]>(
  func: (...args: TArgs) => void | Promise<void>,
  delay: number,
  options: ThrottleOptions = { emitLast: true },
): ThrottledFunction<TArgs> => {
  let lastCall = 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: TArgs | null = null;

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

  const throttled = ((...args: TArgs): void => {
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
  }) as ThrottledFunction<TArgs>;

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
