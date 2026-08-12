import { listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

// Main-window watchdog for reader windows. Reader windows emit a heartbeat
// (`reader-window-alive`) every few seconds while their webview is healthy. A
// crashed renderer (the "blank window" symptom) stops emitting AND never emits
// `close-reader-window`, so the watchdog destroys it after a timeout instead
// of leaving a permanent blank window. A normal close removes the window from
// tracking via `close-reader-window`, so live windows are never touched.
const lastHeartbeat = new Map<string, number>();
const CHECK_INTERVAL_MS = 5000;
const ZOMBIE_TIMEOUT_MS = 20000;

const parseLabel = (payload: unknown): string | null => {
  if (payload && typeof payload === 'object' && 'label' in payload) {
    return String((payload as { label: string }).label);
  }
  return null;
};

export const startReaderWindowWatchdog = (): (() => void) => {
  const unlisteners: Array<() => void> = [];
  void listen('reader-window-alive', (event) => {
    const label = parseLabel(event.payload);
    if (label) lastHeartbeat.set(label, Date.now());
  }).then((fn) => unlisteners.push(fn));
  void listen('close-reader-window', (event) => {
    const label = parseLabel(event.payload);
    if (label) lastHeartbeat.delete(label);
  }).then((fn) => unlisteners.push(fn));

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [label, last] of lastHeartbeat) {
      if (now - last <= ZOMBIE_TIMEOUT_MS) continue;
      lastHeartbeat.delete(label);
      void WebviewWindow.getByLabel(label)
        .then((win) => win?.destroy())
        .catch(() => {
          // The window is already gone — nothing to clean up.
        });
    }
  }, CHECK_INTERVAL_MS);

  return () => {
    clearInterval(timer);
    unlisteners.forEach((fn) => fn());
  };
};
