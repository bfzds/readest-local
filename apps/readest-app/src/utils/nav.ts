import { redirect, useRouter } from 'next/navigation';
import { getCurrentWindow, ScrollBarStyle } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emitTo } from '@tauri-apps/api/event';
import { isTauriAppPlatform } from '@/services/environment';
import { BOOK_IDS_SEPARATOR } from '@/services/constants';
import { AppService } from '@/types/system';

// Single reused reader window (Plan A): created on the first open, hidden (not
// destroyed) on close, then reused by routing new books in-place via a
// cross-window event. A fixed label lets callers find it, and the Rust
// window-state map_label keeps one remembered size/position for it.
const READER_WINDOW_LABEL = 'reader';

const createReaderWindow = async (
  appService: AppService,
  url: string,
  label = READER_WINDOW_LABEL,
) => {
  const currentWindow = getCurrentWindow();
  const scaleFactor = await currentWindow.scaleFactor();
  const { width, height } = await currentWindow.innerSize();
  const win = new WebviewWindow(label, {
    url,
    // Match the window the reader was opened from so switching from the
    // library to a book does not snap the window back to a default size.
    width: Math.round(width / scaleFactor),
    height: Math.round(height / scaleFactor),
    center: true,
    resizable: true,
    title: 'Readest',
    decorations: !!appService.isMacOSApp,
    // Linux stays opaque: a transparent WebKitGTK window turns invisible when
    // its web process is busy (#3682). macOS uses native decorations instead.
    transparent: !appService.isMacOSApp && !appService.isLinuxApp,
    shadow: appService.isMacOSApp ? undefined : true,
    titleBarStyle: appService.isMacOSApp ? 'overlay' : undefined,
    // Enum ScrollBarStyle is exported as type by tauri, so it cannot be used directly.
    scrollBarStyle: (appService.osPlatform === 'windows'
      ? 'fluentOverlay'
      : 'default') as unknown as ScrollBarStyle,
  });
  win.once('tauri://error', (e) => {
    console.error('error creating window', e);
  });
};

export const showReaderWindow = async (
  appService: AppService,
  bookIds: string[],
  queryParams?: string,
) => {
  const params = new URLSearchParams(queryParams || '');
  params.set('ids', bookIds.join(BOOK_IDS_SEPARATOR));
  const url = `/reader?${params.toString()}`;

  // Reuse the existing reader window: route the new book to it in-place (SPA,
  // no reload of the app bundle), then show + focus. Create it on first open.
  const existing = await WebviewWindow.getByLabel(READER_WINDOW_LABEL);
  if (existing) {
    const cfi = params.get('cfi') ?? undefined;
    const highlight = params.get('highlight') === 'search' ? 'search' : undefined;
    await emitTo(READER_WINDOW_LABEL, 'open-book', { bookHash: bookIds[0], cfi, highlight });
    await existing.show();
    await existing.setFocus();
    return;
  }
  await createReaderWindow(appService, url);
};

export const showLibraryWindow = async (appService: AppService, filenames: string[]) => {
  const params = new URLSearchParams();
  filenames.forEach((filename) => params.append('file', filename));
  const url = `/library?${params.toString()}`;
  // A separate window from the reused reader window: it hosts /library with
  // open-with files, not a book.
  await createReaderWindow(appService, url, 'library');
};

// Bring the main library window back when a reader window asks to "go to library".
// If main was hidden (macOS close-to-hide) we re-show it. If it was destroyed
// (Windows/Linux default close), we recreate a window with the same 'main'
// label so the existing emitTo('main', 'close-reader-window', ...) wiring
// continues to work.
export const ensureMainLibraryWindow = async (appService: AppService) => {
  const existing = await WebviewWindow.getByLabel('main');
  if (existing) {
    await existing.show();
    await existing.unminimize();
    await existing.setFocus();
    return;
  }
  const win = new WebviewWindow('main', {
    url: '/library',
    width: 800,
    height: 600,
    center: true,
    resizable: true,
    title: 'Readest',
    decorations: !!appService.isMacOSApp,
    // Linux stays opaque: a transparent WebKitGTK window turns invisible when
    // its web process is busy (#3682). macOS uses native decorations instead.
    transparent: !appService.isMacOSApp && !appService.isLinuxApp,
    shadow: appService.isMacOSApp ? undefined : true,
    titleBarStyle: appService.isMacOSApp ? 'overlay' : undefined,
    scrollBarStyle: (appService.osPlatform === 'windows'
      ? 'fluentOverlay'
      : 'default') as unknown as ScrollBarStyle,
  });
  win.once('tauri://error', (e) => {
    console.error('error recreating main window', e);
  });
};

export const navigateToReader = (
  router: ReturnType<typeof useRouter>,
  bookIds: string[],
  queryParams?: string,
  navOptions?: { scroll?: boolean },
) => {
  const ids = bookIds.join(BOOK_IDS_SEPARATOR);
  const params = new URLSearchParams(queryParams || '');
  params.set('ids', ids);
  router.push(`/reader?${params.toString()}`, navOptions);
};

export const navigateToLogin = (router: ReturnType<typeof useRouter>) => {
  const pathname = window.location.pathname;
  const search = window.location.search;
  const currentPath = pathname !== '/auth' ? pathname + search : '/';
  router.push(`/auth?redirect=${encodeURIComponent(currentPath)}`);
};

export const navigateToProfile = (router: ReturnType<typeof useRouter>) => {
  router.push('/user');
};

export const navigateToLibrary = (
  router: ReturnType<typeof useRouter>,
  queryParams?: string,
  navOptions?: { scroll?: boolean },
  navBack?: boolean,
) => {
  const lastLibraryParams =
    typeof window !== 'undefined' ? sessionStorage.getItem('lastLibraryParams') : null;
  if (navBack && lastLibraryParams) {
    queryParams = lastLibraryParams;
  }

  router.replace(`/library${queryParams ? `?${queryParams}` : ''}`, navOptions);
};

// Recovery action when a reader has nothing to display — e.g. all books were
// closed, or a book failed to load in a freshly-opened reader window.
// In a dedicated reader window we close the window itself, ensuring the main
// library window is visible first; routing the reader window to /library
// instead would leave a leftover window the user has to close manually.
// In the main window or on web, fall back to /library navigation.
export const closeReaderWindowOrGoToLibrary = async (
  appService: AppService | null,
  router: ReturnType<typeof useRouter>,
) => {
  if (isTauriAppPlatform() && appService?.hasWindow) {
    const currentWindow = getCurrentWindow();
    if (currentWindow.label !== 'main') {
      await ensureMainLibraryWindow(appService);
      await currentWindow.close();
      return;
    }
  }
  navigateToLibrary(router, '', undefined, true);
};

export const redirectToLibrary = () => {
  redirect('/library');
};

export const navigateToResetPassword = (router: ReturnType<typeof useRouter>) => {
  const pathname = window.location.pathname;
  const search = window.location.search;
  const currentPath = pathname !== '/auth' ? pathname + search : '/';
  router.push(`/auth/recovery?redirect=${encodeURIComponent(currentPath)}`);
};

export const navigateToUpdatePassword = (router: ReturnType<typeof useRouter>) => {
  const pathname = window.location.pathname;
  const search = window.location.search;
  const currentPath = pathname !== '/auth' ? pathname + search : '/';
  router.push(`/auth/update?redirect=${encodeURIComponent(currentPath)}`);
};
