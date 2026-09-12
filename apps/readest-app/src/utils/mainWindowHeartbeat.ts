import { emitTo } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

// Main-window dead-man switch, frontend half. The main window's custom title
// bar lives in the webview, so a white screen / load failure (dev server dead,
// missing frontend assets) leaves the window with no visible way to close it.
// Rust runs a watchdog on `main-window-alive` heartbeats: after a timeout it
// shows the window and re-enables native decorations so an OS-level title bar
// with a real close button appears (see lib.rs). Heartbeats stop the moment
// the webview dies because this interval simply stops running.
//
// Reader windows are watched by the inverse mechanism (readerWindowWatchdog,
// main window watches readers); only the main window needs this self-report —
// it is the one window nobody else observes.
const HEARTBEAT_INTERVAL_MS = 5000;

export const startMainWindowHeartbeat = (): (() => void) => {
  if (getCurrentWindow().label !== 'main') return () => {};
  const emit = () => emitTo('main', 'main-window-alive', { label: 'main' }).catch(() => {});
  // Fire once immediately so the Rust watchdog's startup window stays short.
  void emit();
  const timer = setInterval(emit, HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(timer);
};
