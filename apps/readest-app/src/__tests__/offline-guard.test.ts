import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCAN_DIRS = ['src', 'src-tauri', 'public'].map((d) => join(APP_ROOT, d));

// `plugins/` holds vendored third-party Tauri plugins. Their sources are not
// part of this fork's runtime wiring, so the guard skips them and the audit
// report covers them separately.
const SKIP_DIRS = new Set([
  '__tests__',
  'node_modules',
  '.next',
  'out',
  'target',
  'gen',
  'plugins',
  'icons',
  'nsis',
]);

const FORBIDDEN_HOSTS = [
  'supabase.co',
  'supabase.com',
  'posthog.com',
  'sentry.io',
  'sentry.dev',
  'stripe.com',
  'deepl.com',
  'wikipedia.org',
  'wiktionary.org',
  'readest.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'storage.readest.com',
  'cloudflarestorage.com',
  'onlinewebfonts.com',
  'openai.com',
  'ollama.com',
];

const FORBIDDEN_TOKENS = [
  'wss://',
  'new WebSocket(',
  "from 'ws'",
  "require('ws')",
  'alipays',
  'alipay',
];

const CLOUD_PACKAGE_PATTERN =
  /^(ai|aws|@aws\S*|@sentry\S*|@supabase\S*|@posthog\S*|openai|ollama|stripe|sentry|supabase|posthog|@anthropic-ai\/\S*|@google\/generative-ai)$/;

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...listFiles(join(dir, entry.name)));
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs|rs|json|html|css|toml)$/.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

describe('offline guard', () => {
  test('runtime sources contain no cloud hosts or network tokens', () => {
    const hits: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of listFiles(dir)) {
        const text = readFileSync(file, 'utf8');
        for (const host of FORBIDDEN_HOSTS) {
          if (text.toLowerCase().includes(host)) hits.push(`${file}: host ${host}`);
        }
        for (const token of FORBIDDEN_TOKENS) {
          if (text.includes(token)) hits.push(`${file}: token ${token}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  test('cloud packages are not installed', () => {
    const pkg = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const offenders = Object.keys(deps).filter((name) => CLOUD_PACKAGE_PATTERN.test(name));
    expect(offenders).toEqual([]);
  });

  test('parallel read feature is removed', () => {
    expect(existsSync(join(APP_ROOT, 'src', 'store', 'parallelViewStore.ts'))).toBe(false);
    expect(
      existsSync(join(APP_ROOT, 'src', '__tests__', 'store', 'parallel-view-store.test.ts')),
    ).toBe(false);
  });
});
