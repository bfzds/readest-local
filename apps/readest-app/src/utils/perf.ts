// 性能埋点：统一 `[perf]` 前缀输出到 console，便于 grep / 脚本解析对比。
// `perfMark(context, label)` 记录绝对时间戳；`perfMark(context, label, from)`
// 记录相对 `from` 的毫秒耗时。埋点本身开销可忽略，仅用于采集基线/优化对比。
export const perfMark = (context: string, label: string, from?: number): number => {
  const now = performance.now();
  console.log(
    `[perf] ${context}.${label}: ${from === undefined ? now.toFixed(1) : (now - from).toFixed(1)}ms`,
  );
  return now;
};
