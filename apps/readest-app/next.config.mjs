import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = process.env['NODE_ENV'] === 'development';
const appPlatform = process.env['NEXT_PUBLIC_APP_PLATFORM'];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: appPlatform !== 'web' && !isDev ? 'export' : undefined,
  // Pin the monorepo root explicitly; Next otherwise picks a lockfile in the
  // user home directory and resolves `@/*` aliases against the wrong tree.
  outputFileTracingRoot: path.join(__dirname, '../..'),
  pageExtensions: appPlatform !== 'web' && !isDev ? ['jsx', 'tsx'] : ['js', 'jsx', 'ts', 'tsx'],
  // Note: This feature is required to use the Next.js Image component in SSG mode.
  // See https://nextjs.org/docs/messages/export-image-api for different workarounds.
  images: {
    unoptimized: true,
  },
  devIndicators: false,
  experimental: {
    // Dev caching is on by default since Next 16.1. We deliberately do NOT
    // enable Turbopack's build cache (turbopackFileSystemCacheForBuild, beta):
    // a build interrupted mid-compile leaves a partial cache that the next
    // build mishandles, fanning out workers until it exhausts RAM.
    turbopackFileSystemCacheForDev: true,
  },
  assetPrefix: '',
  reactStrictMode: true,
  webpack: (config, { isServer }) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      // Next's tsconfig-paths integration is unreliable here (monorepo root
      // detection), so pin the source aliases used across the app.
      '@/components/ui': path.resolve(__dirname, 'src/components/primitives'),
      '@': path.resolve(__dirname, 'src'),
      nunjucks: 'nunjucks/browser/nunjucks.js',
      'tauri-plugin-turso': path.resolve(
        __dirname,
        'src-tauri/plugins/tauri-plugin-turso/guest-js/index.ts',
      ),
      'js-mdict': path.resolve(__dirname, '../../packages/js-mdict/src/index.ts'),
      '@simplecc': path.resolve(__dirname, 'public/vendor/simplecc'),
      '@pdfjs': path.resolve(__dirname, 'public/vendor/pdfjs'),
      // `js-mdict` is consumed as TS source via tsconfig paths from
      // `packages/js-mdict/src/`; its sources `import 'fflate'` directly.
      // Without an alias, webpack walks up from that source location and
      // can't find fflate (only installed in this app's node_modules).
      fflate: path.resolve(__dirname, 'node_modules/fflate'),
      ...(appPlatform !== 'web' ? { '@tursodatabase/database-wasm': false } : {}),
      ...(isServer && appPlatform === 'web'
        ? { '@readest/turso-database-wasm/webpack': false, 'jieba-wasm': false }
        : {}),
    };
    return config;
  },
  turbopack: {
    resolveAlias: {
      nunjucks: 'nunjucks/browser/nunjucks.js',
      // Turbopack rejects absolute paths in resolveAlias ("server relative
      // imports not implemented"); use a project-relative path.
      fflate: './node_modules/fflate',
      ...(appPlatform !== 'web' ? { '@tursodatabase/database-wasm': './src/utils/stub.ts' } : {}),
    },
  },
  transpilePackages: [
    'streamdown',
    ...(isDev
      ? []
      : [
          'i18next-browser-languagedetector',
          'react-i18next',
          'i18next',
          '@tauri-apps',
          'highlight.js',
          'foliate-js',
          'marked',
        ]),
  ],
  async rewrites() {
    return [
      {
        source: '/reader/:ids',
        destination: '/reader?ids=:ids',
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/_next/static/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: isDev
              ? 'public, max-age=0, must-revalidate'
              : 'public, max-age=31536000, immutable',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
