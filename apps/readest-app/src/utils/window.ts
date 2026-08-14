import { getAllWindows, getCurrentWindow } from '@tauri-apps/api/window';
import { emitTo, TauriEvent } from '@tauri-apps/api/event';
import { exit } from '@tauri-apps/plugin-process';
import { type as osType } from '@tauri-apps/plugin-os';
import { eventDispatcher } from './event';

const APP_NAME = 'Readest';

// NF2: reader 关闭时保存完成后销毁的超时兜底。保存慢于此值（挂起）时仍销毁
// 窗口，防止窗口残留；正常保存远快于此。
const SAVE_DESTROY_TIMEOUT_MS = 5000;

/**
 * The OS window title, e.g. `Readest - The Hobbit`. It is never drawn in the
 * UI — desktop windows are either decorationless (Windows/Linux) or hide their
 * title text (the macOS overlay title bar) — but window switchers and screen
 * readers announce it, so it has to name the open book to tell windows apart.
 */
export const formatAppWindowTitle = (bookTitle?: string) => {
  const title = bookTitle?.trim();
  return title ? `${APP_NAME} - ${title}` : APP_NAME;
};

export const tauriSetWindowTitle = async (bookTitle?: string) => {
  await getCurrentWindow().setTitle(formatAppWindowTitle(bookTitle));
};

export const tauriGetWindowLogicalPosition = async () => {
  const currentWindow = getCurrentWindow();
  const factor = await currentWindow.scaleFactor();
  const physicalPos = await currentWindow.outerPosition();
  return { x: physicalPos.x / factor, y: physicalPos.y / factor };
};

export const tauriHandleMinimize = async () => {
  getCurrentWindow().minimize();
};

// workaround to reset transparent background when toggling fullscreen/maximize
const linuxWindowRestoreTransparentBg = async () => {
  const currentSize = await getCurrentWindow().innerSize();
  currentSize.width -= 1;
  currentSize.height -= 1;
  await getCurrentWindow().setSize(currentSize);
  setTimeout(async () => {
    const currentSize = await getCurrentWindow().innerSize();
    currentSize.width += 1;
    currentSize.height += 1;
    await getCurrentWindow().setSize(currentSize);
  }, 100);
};

export const tauriHandleToggleMaximize = async () => {
  const currentWindow = getCurrentWindow();
  const isFullscreen = await currentWindow.isFullscreen();
  if (isFullscreen) {
    await currentWindow.setFullscreen(false);
    await currentWindow.unmaximize();
  } else {
    await currentWindow.toggleMaximize();
  }
  if ((await osType()) === 'linux') {
    linuxWindowRestoreTransparentBg();
  }
};

export const tauriHandleClose = async () => {
  getCurrentWindow().close();
};

export const tauriHandleOnCloseWindow = async (callback: () => void) => {
  const currentWindow = getCurrentWindow();
  return await currentWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    // On macOS, the main window's close is intercepted by the Rust backend
    // to hide the window (close-to-hide), keeping the app in the dock. Skip
    // the in-app cleanup — the user is just minimizing the window and
    // expects the active book to still be there when the window reopens.
    if (currentWindow.label === 'main' && (await osType()) === 'macos') {
      return;
    }
    const isReader = currentWindow.label.startsWith('reader');
    // NF2: 原固定 500ms destroy 宽限与异步保存赛跑——保存慢于 500ms 会被截断
    // 丢书签/进度。改为保存完成后销毁；保存挂起时 SAVE_DESTROY_TIMEOUT_MS 超时
    // 兜底，防止窗口残留。
    if (isReader) {
      const finish = Promise.resolve()
        .then(() => callback())
        .catch((error) => console.error('Error saving on window close:', error))
        .then(() =>
          emitTo('main', 'close-reader-window', { label: currentWindow.label }).catch(() => {}),
        );
      const bail = new Promise<void>((resolve) => setTimeout(resolve, SAVE_DESTROY_TIMEOUT_MS));
      void Promise.race([finish, bail]).then(() => currentWindow.destroy().catch(() => {}));
      return;
    }
    try {
      await callback();
    } catch (error) {
      console.error('Error saving on window close:', error);
    }
    if (currentWindow.label === 'main') {
      try {
        await currentWindow.destroy();
      } catch (error) {
        console.error('Error destroying main window:', error);
      }
    }
  });
};

// 方案A：书库窗口（main）的关闭拦截，仅 Windows/Linux 生效。阅读页打开
// （存在可见的 reader 窗口）时，点书库的 X 只 hide() 不销毁——原 webview 连同
// 滚动位置、选中项、搜索输入、筛选条件、已加载列表全部保留，阅读页关闭时再
// show() 回来，切换对用户无感，且无需序列化/重建任何状态。没有阅读页打开时
// X 才是真销毁（应用退出），并顺带销毁残留的隐藏 reader 窗口，避免"已无可见
// 窗口但进程仍存活"。macOS 由 Rust 侧 close-to-hide 接管（lib.rs），跳过防重复。
export const tauriHandleOnCloseMainWindow = async () => {
  const currentWindow = getCurrentWindow();
  return await currentWindow.onCloseRequested(async (event) => {
    if ((await osType()) === 'macos') return;
    const readers = (await getAllWindows()).filter((w) => w.label.startsWith('reader'));
    const readerVisible = (
      await Promise.all(readers.map((w) => w.isVisible().catch(() => false)))
    ).some(Boolean);
    if (readerVisible) {
      event.preventDefault();
      await currentWindow.hide();
      return;
    }
    await Promise.all(readers.map((w) => w.destroy().catch(() => {})));
  });
};

// Whether the window was maximized when it last entered fullscreen, so the
// maximized state survives a fullscreen round-trip on Windows.
let wasMaximizedBeforeFullscreen = false;

export const tauriHandleToggleFullScreen = async () => {
  const currentWindow = getCurrentWindow();
  const isFullscreen = await currentWindow.isFullscreen();
  // Toggle fullscreen regardless of the maximized state. Previously a maximized
  // window was only unmaximized here, so the fullscreen button did nothing when
  // the window was maximized, which is always the case on mobile shells like
  // Phosh and common on Windows (issue #4034).
  if (isFullscreen) {
    await currentWindow.setFullscreen(false);
    if (wasMaximizedBeforeFullscreen) {
      wasMaximizedBeforeFullscreen = false;
      await currentWindow.maximize();
    }
  } else {
    // On Windows, tao keeps the WS_MAXIMIZE style when a maximized window
    // enters borderless fullscreen, so Windows clamps the window to the work
    // area and the taskbar stays visible but unclickable (issue #5295).
    // Unmaximize first and restore the maximized state on exit. Other
    // platforms must keep entering fullscreen straight from the maximized
    // state (Phosh windows are always maximized).
    wasMaximizedBeforeFullscreen =
      (await osType()) === 'windows' && (await currentWindow.isMaximized());
    if (wasMaximizedBeforeFullscreen) {
      await currentWindow.unmaximize();
    }
    await currentWindow.setFullscreen(true);
  }
  if ((await osType()) === 'linux') {
    linuxWindowRestoreTransparentBg();
  }
};

export const tauriHandleSetAlwaysOnTop = async (isAlwaysOnTop: boolean) => {
  const windows = await getAllWindows();
  await Promise.all(windows.map((w) => w.setAlwaysOnTop(isAlwaysOnTop)));
};

export const tauriGetAlwaysOnTop = async () => {
  const currentWindow = getCurrentWindow();
  return await currentWindow.isAlwaysOnTop();
};

export const tauriHandleOnWindowFocus = async (callback: () => void) => {
  const currentWindow = getCurrentWindow();
  return currentWindow.listen(TauriEvent.WINDOW_FOCUS, async () => {
    await callback();
  });
};

export const tauriQuitApp = async () => {
  await eventDispatcher.dispatch('quit-app');
  await exit(0);
};
