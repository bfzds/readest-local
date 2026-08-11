import * as React from 'react';
import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import { ViewTransitions } from 'next-view-transitions';
import { EnvProvider } from '@/context/EnvContext';
import Providers from '@/components/Providers';

import '../styles/globals.css';

const title = 'Readest';
const description =
  'A local-first offline ebook reader supporting EPUB, PDF, MOBI, AZW3, FB2, CBZ, TXT and Markdown.';

export const metadata: Metadata = {
  title: {
    default: title,
    template: '%s | Readest',
  },
  description,
  generator: 'Next.js',
  keywords: ['epub', 'pdf', 'ebook', 'reader', 'readest'],
  icons: {
    icon: [{ url: '/icon.png' }, { url: '/favicon.ico' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  minimumScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

// In Tauri mobile dev the page origin doesn't match the dev server, so
// Next.js's `getSocketUrl` builds an unreachable HMR URL (see
// `next/dist/client/dev/hot-reloader/get-socket-url.js`):
//   - iOS sim:        page at `tauri://localhost` -> HMR WebSocket to `localhost/_next/...`
//     (no port, non-http scheme falls through to secure WebSocket)
//   - Android emul.:  page at `http://tauri.localhost` -> `ws://tauri.localhost/_next/...`
//     (`tauri.localhost` is intercepted by Tauri's asset handler, but
//     WebSocket frames bypass the interceptor and the dev server is on the
//     host machine, reachable from the emulator as `10.0.2.2`)
// Rewrite the WebSocket constructor before the HMR client runs.
// When `--host <ip>` is passed, tauri-cli exports `TAURI_DEV_HOST=<ip>`
// before invoking `beforeDevCommand`, so we forward that as `devHost` and
// use it for the rewrite (the dev server must also bind to the same address
// typically `next dev -H 0.0.0.0`).
function patchTauriHmrWebSocket(devHost?: string) {
  const isIosTauriProxy = location.protocol === 'tauri:' && location.hostname === 'localhost';
  const isAndroidTauriProxy =
    location.protocol === 'http:' && location.hostname === 'tauri.localhost';
  if (!isIosTauriProxy && !isAndroidTauriProxy) return;

  // Priority: explicit --host > platform default loopback alias.
  // iOS Simulator can reach the host's localhost directly.
  // Android emulator reaches the host machine via 10.0.2.2.
  const hmrHost = devHost
    ? `${devHost}:3000`
    : isIosTauriProxy
      ? 'localhost:3000'
      : '10.0.2.2:3000';
  const brokenHostPattern = /^wss?:\/\/(localhost|tauri\.localhost)(?=\/_next\/)/;

  const OriginalWebSocket = window.WebSocket;
  class PatchedWebSocket extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const urlStr = url instanceof URL ? url.href : url;
      const rewritten =
        typeof urlStr === 'string' && brokenHostPattern.test(urlStr)
          ? urlStr.replace(brokenHostPattern, `ws://${hmrHost}`)
          : url;
      super(rewritten, protocols);
    }
  }
  window.WebSocket = PatchedWebSocket;
}

const shouldInjectDevHmrPatch =
  process.env['NODE_ENV'] === 'development' && process.env['NEXT_PUBLIC_APP_PLATFORM'] === 'tauri';
const devHmrPatchScript = `(${patchTauriHmrWebSocket.toString()})(${JSON.stringify(
  process.env['TAURI_DEV_HOST'],
)});`;

// `/runtime-config.js` is a dynamic route handler that only exists in the
// web build. The Tauri build is statically exported (`output: 'export'`), so
// the file isn't emitted and the request would return the SPA fallback HTML.
const shouldInjectRuntimeConfig = process.env['NEXT_PUBLIC_APP_PLATFORM'] === 'web';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang='en'
      suppressHydrationWarning
      className={process.env['NEXT_PUBLIC_APP_PLATFORM'] === 'tauri' ? 'edge-to-edge' : ''}
    >
      <head>
        {shouldInjectRuntimeConfig ? (
          <Script src='/runtime-config.js' strategy='beforeInteractive' />
        ) : null}
        {shouldInjectDevHmrPatch ? (
          <script dangerouslySetInnerHTML={{ __html: devHmrPatchScript }} />
        ) : null}
      </head>
      <body>
        <ViewTransitions>
          <EnvProvider>
            <Providers>{children}</Providers>
          </EnvProvider>
        </ViewTransitions>
      </body>
    </html>
  );
}
