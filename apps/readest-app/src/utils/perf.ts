// 性能埋点：统一 `[perf]` 前缀。在 Tauri 下额外转发到日志插件（写入
// `%LOCALAPPDATA%\com.local.readest\logs\Readest Local.log`），release 构建
// 无需 DevTools 即可 grep；非 Tauri（web / 单测）仅 console.log。
// `perfMark(context, label)` 记录绝对时间戳；`perfMark(context, label, from)`
// 记录相对 `from` 的毫秒耗时。耗时在调用时同步算好，异步转发不影响准确性。
import { isTauriAppPlatform } from '@/services/environment';

export const perfMark = (context: string, label: string, from?: number): number => {
  const now = performance.now();
  const line = `[perf] ${context}.${label}: ${from === undefined ? now.toFixed(1) : (now - from).toFixed(1)}ms`;
  console.log(line);
  if (isTauriAppPlatform()) {
    // Best-effort: forward to the log file so perf timing is greppable in
    // release builds. Lazy import keeps the module out of web/unit bundles.
    import('@tauri-apps/plugin-log').then((m) => m.info(line)).catch(() => {});
  }
  return now;
};
