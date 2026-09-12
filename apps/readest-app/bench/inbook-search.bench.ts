/**
 * In-book search pipeline benchmarks (书内搜索链路性能基准).
 *
 * Fills the coverage gap documented in
 * docs/reports/handover-search-perf-2026-09-12.md §7: the only existing search
 * benchmark (library-search) measures library-wide scans, while the in-book
 * pipeline — contains matching, then per-result CFI resolution — had no bench
 * at all, which is why past optimizations kept targeting the wrong segment.
 *
 * Scenarios:
 *  - S1 `contains-match` (default): pure-string foldText + indexOf matching
 *    over an 80k-char synthetic zh text (~4% density of the common char 的,
 *    ~3200 hits). Zero DOM.
 *  - S2 `cfi-resolve-synthetic` (default): the production
 *    resolveSearchResultCfis (createDocument + textWalker + batchedCfi) over
 *    the same text packaged as an in-memory EPUB opened via DocumentLoader.
 *  - S3 `cfi-resolve-real-fixture` (optional): same as S2 against a private
 *    real-world sample (a Pixiv-export EPUB with a ~7083-text-node flat DOM,
 *    where the batchedCfi node-pair template cache degenerates). Runs only
 *    when the fixture exists locally; otherwise emits a skipped row.
 *
 * Environment caveats (also printed by `pnpm bench --list`):
 *  - Bare-node bench (no vitest): a module hook maps the `@/` / `@simplecc/`
 *    tsconfig paths and transpiles non-erasable TS (parameter properties /
 *    enums) that strip-only mode rejects; jsdom supplies the DOM globals the
 *    DocumentLoader / text-walker / batchedCfi chain needs. **jsdom numbers
 *    are ~3x slower than real Chromium — same-machine before/after only.**
 *  - The highlight-replay segment (view.search → addAnnotation, the dominant
 *    cost on real books) needs a real layout engine and cannot run in node:
 *    it is measured by
 *    src/__tests__/diagnostics/search-perf.browser.test.ts.
 *  - S3 reads a gitignored private EPUB outside bench/ — a deliberate,
 *    documented deviation from the "no fixtures outside bench/" rule: the
 *    sample is a user's private book and must never be committed.
 *
 * Privacy red line (隐私红线): all output — stdout, results.jsonl, logs — is
 * numeric only (bytes / sections / nodes / hits / ms). Book text, titles,
 * authors and excerpts must never appear in any output.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// jsdom ships no bundled type declarations and @types/jsdom is not installed;
// the bench only builds a DOM shell, so the untyped import is fine here.
// @ts-expect-error -- no type declarations for jsdom in this repo
import { JSDOM } from 'jsdom';

import { findContainsMatches, foldValue } from '../src/utils/containsSearch.ts';
import type { Bench, BenchResult } from './lib.ts';

// ---- tunables ---------------------------------------------------------------

const QUERY = '的';
const SYNTH_CHARS = 80_000;
const PARA_CHARS = 250;
const DENSITY_DIVISOR = 25; // every 25th char is the query char -> ~4%
const DENSITY_OFFSET = 7;

const FOLD_REPS = 20; // S1 fold-only rounds (~ms each)
const MATCH_REPS = 15; // S1 fold+match rounds (~ms each)
const SYNTH_CFI_REPS = 5; // S2 resolveSearchResultCfis passes
// S3 per-pass cost is seconds on real hardware in Chromium; keep the default
// run well under ~30s (measured ~0.4s/round in jsdom on the reference machine).
const FIXTURE_CFI_REPS = 3;

const CONTAINS_OPTIONS = { matchCase: false, matchDiacritics: false } as const;

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
// Deliberate deviation from "no fixtures outside bench/": the sample is a
// gitignored private user file (never committed), so it cannot live in bench/.
const SAMPLE_NAME = '371c57b3-ecad-4256-99ae-d4394e2ec0ff.epub';
const SAMPLE_PATH = resolve(BENCH_DIR, '../src/__tests__/fixtures/data', SAMPLE_NAME);
const SAMPLE_PRESENT = existsSync(SAMPLE_PATH);

// Same char pool as the diagnostics harness; must not contain the query char
// or the measured density would be off.
const POOL =
  '天地人在有这不中大为上个国我以要他时来用们生到作于出就分对成会可主发年动同方多事经法如后所定本学而论还进去说好过自很能下点心思想道里名些位置手理体知物给正外等合使明者问但文月相应度利工加无条件回并立军决比思民别被特据水强场提二已或其看平真任那从当与及着各部开启面展数目重至由百己化只儿两每';

if (POOL.includes(QUERY)) throw new Error('char pool must not contain the query char');

// ---- stats helpers ----------------------------------------------------------

const medianOf = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const meanOf = (values: number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const timeSyncRounds = (fn: () => number, reps: number, warmup = 3) => {
  for (let i = 0; i < warmup; i++) fn();
  const ms: number[] = [];
  let count = 0;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    count = fn();
    ms.push(performance.now() - t0);
  }
  return { ms, count };
};

const timeAsyncRounds = async (fn: () => Promise<number>, reps: number, warmup = 0) => {
  for (let i = 0; i < warmup; i++) await fn();
  const ms: number[] = [];
  let count = 0;
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    count = await fn();
    ms.push(performance.now() - t0);
  }
  return { ms, count };
};

// ---- synthetic zh text (pure string, S1) ------------------------------------

const buildSyntheticText = (): string => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  let text = '';
  while (text.length < SYNTH_CHARS) {
    const buf = new Array<string>(PARA_CHARS);
    for (let i = 0; i < PARA_CHARS; i++) {
      const absolute = text.length + i;
      buf[i] =
        absolute % DENSITY_DIVISOR === DENSITY_OFFSET
          ? QUERY
          : POOL[Math.floor(rand() * POOL.length)]!;
    }
    text += buf.join('');
  }
  return text.slice(0, SYNTH_CHARS);
};

// ---- bare-node compatibility bootstrap (S2/S3) ------------------------------
// bench/index.ts runs `node --experimental-strip-types` with no vitest env:
//  1. The search-service import graph uses tsconfig paths (`@/`, and
//     `@simplecc/` -> vendored wasm glue) that bare node cannot resolve.
//  2. Strip-only mode rejects parameter properties / enums (e.g.
//     statisticsDb.ts), so those files need transform mode instead.

interface Boot {
  createLibrarySearchSession: (appService: unknown) => SearchSession;
  resolveSearchResultCfis: (
    session: SearchSession,
    book: BookLike,
    locators: SearchLocator[],
  ) => Promise<Array<{ cfi: string } | null>>;
  createRejectFilter: (options: {
    tags?: string[];
    attributes?: string[];
  }) => (node: Node) => number;
  textWalker: (
    doc: Document,
    cb: (strings: string[], makeRange: (...args: number[]) => Range) => unknown[],
    acceptNode?: (node: Node) => number,
  ) => Iterable<unknown>;
}

interface SearchLocator {
  section: number;
  start: number;
  end: number;
}

interface SectionLike {
  linear?: string;
  createDocument: () => Promise<Document>;
}

interface BookDocLike {
  sections: SectionLike[];
}

interface SearchSession {
  open: (book: BookLike) => Promise<{ bookDoc: BookDocLike }>;
  close: () => Promise<void>;
}

interface BookLike {
  hash: string;
  format: string;
  title: string;
  author: string;
  createdAt: number;
  updatedAt: number;
  primaryLanguage: string;
}

let hooksInstalled = false;

// esbuild is a transitive dependency of vite (not hoisted to the pnpm store
// root), so resolve it through vite's own dependency context.
const loadEsbuild = (): {
  transformSync: (code: string, options: Record<string, unknown>) => { code: string };
} => {
  const require = createRequire(import.meta.url);
  const viteDir = dirname(require.resolve('vite/package.json'));
  const esbuildDir = dirname(require.resolve('esbuild/package.json', { paths: [viteDir] }));
  return require(esbuildDir);
};

const installHooksAndGlobals = (): void => {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const esbuild = loadEsbuild();

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const tryCandidates = (base: string) => {
        let lastError: unknown;
        for (const candidate of [
          base,
          `${base}.ts`,
          `${base}.tsx`,
          `${base}.js`,
          `${base}/index.ts`,
          `${base}/index.js`,
        ]) {
          try {
            return nextResolve(candidate, context);
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError;
      };
      // tsconfig paths -> bare-node resolvable URLs.
      if (specifier.startsWith('@/')) {
        return tryCandidates(new URL(`../src/${specifier.slice(2)}`, import.meta.url).href);
      }
      if (specifier.startsWith('@simplecc/')) {
        return tryCandidates(
          new URL(
            `../public/vendor/simplecc/${specifier.slice('@simplecc/'.length)}`,
            import.meta.url,
          ).href,
        );
      }
      if (specifier.startsWith('@pdfjs/')) {
        return tryCandidates(
          new URL(`../public/vendor/pdfjs/${specifier.slice('@pdfjs/'.length)}`, import.meta.url)
            .href,
        );
      }
      // Extensionless relative imports inside src/ (the app is bundled by
      // Next/vitest which resolve them; bare node needs the candidates).
      if (
        (specifier.startsWith('./') || specifier.startsWith('../')) &&
        context.parentURL?.includes('/src/') &&
        !/\.[a-z]+$/.test(specifier)
      ) {
        return tryCandidates(new URL(specifier, context.parentURL).href);
      }
      // Extensionless package subpaths (e.g. dayjs/plugin/duration) resolve
      // under vite but not under bare node; retry with .js on failure.
      if (
        !specifier.startsWith('.') &&
        !specifier.startsWith('#') &&
        !specifier.endsWith('/') &&
        !/\.[a-z]+$/.test(specifier)
      ) {
        try {
          return nextResolve(specifier, context);
        } catch (error) {
          try {
            return nextResolve(`${specifier}.js`, context);
          } catch {
            throw error;
          }
        }
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.endsWith('.ts') || url.endsWith('.tsx')) {
        // Transpile with esbuild (the same transformer vitest uses): the app
        // graph imports pure types value-style (`import { Type } from ...`),
        // which esbuild elides but node's amaro strip keeps — node then fails
        // to link those modules. esbuild also downlevels parameter properties
        // / enums that strip-only mode rejects outright.
        const fileName = fileURLToPath(url);
        const source = readFileSync(fileName, 'utf8');
        const result = esbuild.transformSync(source, {
          loader: url.endsWith('.tsx') ? 'tsx' : 'ts',
          format: 'esm',
          sourcefile: fileName,
          ...(url.endsWith('.tsx') ? { jsx: 'automatic' } : {}),
        });
        return { format: 'module', source: result.code, shortCircuit: true };
      }
      if (url.endsWith('.json')) {
        // Bare node requires `with { type: 'json' }` on JSON imports; the app
        // graph (bundled by Next/vitest) imports them bare. The importers all
        // use default imports, so a default-export ESM shim is enough.
        const source = readFileSync(fileURLToPath(url), 'utf8');
        return { format: 'module', source: `export default ${source};`, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });

  // Minimal DOM globals for DocumentLoader (DOMParser), foliate text-walker
  // (NodeFilter/document/Range at call sites) and batchedCfi (CFI.fromRange).
  // Blob/File/TextEncoder/performance stay node-native. Worker is deliberately
  // NOT injected: the fuzzy/nearby search worker then falls back to the main
  // thread, and contains mode never creates one.
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://bench.local/',
  });
  const g = globalThis as Record<string, unknown>;
  const win = dom.window as unknown as Record<string, unknown>;
  for (const key of [
    'Node',
    'NodeFilter',
    'DOMParser',
    'XMLSerializer',
    'Element',
    'DocumentFragment',
    'Range',
    'CSS',
    'document',
    'window',
  ]) {
    if (g[key] === undefined && win[key] !== undefined) g[key] = win[key];
  }
};

let bootPromise: Promise<Boot> | null = null;

const getBoot = (): Promise<Boot> => {
  bootPromise ??= (async () => {
    installHooksAndGlobals();
    const [service, nodeUtil, walker] = await Promise.all([
      import('../src/services/librarySearchService.ts'),
      import('../src/utils/node.ts'),
      import('foliate-js/text-walker.js'),
    ]);
    return {
      createLibrarySearchSession:
        service.createLibrarySearchSession as Boot['createLibrarySearchSession'],
      resolveSearchResultCfis: service.resolveSearchResultCfis as Boot['resolveSearchResultCfis'],
      createRejectFilter: nodeUtil.createRejectFilter as Boot['createRejectFilter'],
      textWalker: walker.textWalker as Boot['textWalker'],
    };
  })();
  return bootPromise;
};

// ---- in-memory STORE-zip EPUB builder (same as the diagnostics harness) -----

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const buildStoreZip = (entries: Array<{ name: string; data: Uint8Array<ArrayBuffer> }>): Blob => {
  const encoder = new TextEncoder();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
  const u32 = (v: number) =>
    new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;
    const local = new Uint8Array(30 + nameBytes.length);
    local.set(u32(0x04034b50), 0);
    local.set(u16(20), 4);
    local.set(u16(0x0800), 6);
    local.set(u16(0), 8);
    local.set(u16(0), 10);
    local.set(u16(0x21), 12);
    local.set(u32(crc), 14);
    local.set(u32(size), 18);
    local.set(u32(size), 22);
    local.set(u16(nameBytes.length), 26);
    local.set(u16(0), 28);
    local.set(nameBytes, 30);
    chunks.push(local, entry.data);
    const cd = new Uint8Array(46 + nameBytes.length);
    cd.set(u32(0x02014b50), 0);
    cd.set(u16(20), 4);
    cd.set(u16(20), 6);
    cd.set(u16(0x0800), 8);
    cd.set(u16(0), 10);
    cd.set(u16(0), 12);
    cd.set(u16(0x21), 14);
    cd.set(u32(crc), 16);
    cd.set(u32(size), 20);
    cd.set(u32(size), 24);
    cd.set(u16(nameBytes.length), 28);
    cd.set(u16(0), 30);
    cd.set(u16(0), 32);
    cd.set(u16(0), 34);
    cd.set(u16(0), 36);
    cd.set(u32(0), 38);
    cd.set(u32(offset), 42);
    cd.set(nameBytes, 46);
    central.push(cd);
    offset += local.length + size;
  }
  const centralSize = central.reduce((sum, cd) => sum + cd.length, 0);
  const eocd = new Uint8Array(22);
  eocd.set(u32(0x06054b50), 0);
  eocd.set(u16(0), 4);
  eocd.set(u16(0), 6);
  eocd.set(u16(entries.length), 8);
  eocd.set(u16(entries.length), 10);
  eocd.set(u32(centralSize), 12);
  eocd.set(u32(offset), 16);
  eocd.set(u16(0), 20);
  return new Blob([...chunks, ...central, eocd], { type: 'application/epub+zip' });
};

const buildSyntheticEpubFile = (): File => {
  const text = buildSyntheticText();
  const paragraphs: string[] = [];
  for (let start = 0; start < text.length; start += PARA_CHARS) {
    paragraphs.push(text.slice(start, start + PARA_CHARS));
  }
  const body = paragraphs.map((p) => `<p>${p}</p>`).join('');
  const chapter =
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>bench</title></head>` +
    `<body>${body}</body></html>`;
  const nav =
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">` +
    `<head><title>toc</title></head><body><nav epub:type="toc"><ol>` +
    `<li><a href="ch1.xhtml">bench</a></li></ol></nav></body></html>`;
  const opf =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">` +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    `<dc:identifier id="uid">urn:uuid:bench-zh</dc:identifier>` +
    `<dc:title>bench</dc:title><dc:language>zh</dc:language>` +
    `<dc:creator>bench</dc:creator>` +
    `<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata>` +
    `<manifest>` +
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` +
    `<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>` +
    `</manifest><spine><itemref idref="ch1"/></spine></package>`;
  const container =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
    `<rootfiles><rootfile full-path="OEBPS/content.opf" ` +
    `media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const encoder = new TextEncoder();
  const blob = buildStoreZip([
    { name: 'mimetype', data: encoder.encode('application/epub+zip') },
    { name: 'META-INF/container.xml', data: encoder.encode(container) },
    { name: 'OEBPS/content.opf', data: encoder.encode(opf) },
    { name: 'OEBPS/nav.xhtml', data: encoder.encode(nav) },
    { name: 'OEBPS/ch1.xhtml', data: encoder.encode(chapter) },
  ]);
  return new File([blob], 'bench-zh.epub', { type: 'application/epub+zip' });
};

// ---- appService mock (same shape as the diagnostics harness) -----------------
// openDatabase always rejects -> the live-scan path (no index db), identical to
// production when a book has no search.db yet. Index writes are all guarded by
// the null indexDb, so no database code ever runs.

const makeAppService = (file: File): unknown => ({
  getBookFileSize: async () => file.size,
  loadBookContent: async (book: BookLike) => ({ book, file }),
  resolveNativeBookFilePath: async () => null,
  loadBookNav: async () => null,
  databaseExists: async () => false,
  deleteDatabase: async () => undefined,
  openDatabase: async () => {
    throw new Error('bench: index db disabled (live path)');
  },
  createDir: async () => undefined,
  stats: async () => ({
    isFile: false,
    isDirectory: true,
    size: 0,
    mtime: new Date(),
    atime: null,
    birthtime: null,
  }),
  deleteDir: async () => undefined,
});

// Neutral placeholder metadata for the private fixture: the book's real
// title/creator are never read, so no content can leak via the Book object.
const makePrivateFixtureBook = (): BookLike => ({
  hash: 'private-inbook-search-bench',
  format: 'EPUB',
  title: 'private-sample',
  author: '',
  createdAt: 1,
  updatedAt: 1,
  primaryLanguage: 'zh',
});

// ---- shared S2/S3 helpers ----------------------------------------------------

interface SectionStats {
  totalSections: number;
  linearSections: number;
  textNodes: number;
  chars: number;
  locators: SearchLocator[];
}

// Walk every section exactly like the live scan does (createDocument +
// textWalker + the same accept filter), count nodes/chars (numeric-only meta)
// and build contains-match locators with the production matcher. Locators are
// identical to what searchLibraryBooks yields for contains mode — same
// extracted text, same findContainsMatches.
const collectLocators = async (boot: Boot, bookDoc: BookDocLike): Promise<SectionStats> => {
  const acceptNode = boot.createRejectFilter({ tags: [], attributes: ['cfi-inert'] });
  const stats: SectionStats = {
    totalSections: bookDoc.sections.length,
    linearSections: 0,
    textNodes: 0,
    chars: 0,
    locators: [],
  };
  for (const [sectionIndex, section] of bookDoc.sections.entries()) {
    if (typeof section.createDocument !== 'function') continue;
    if (section.linear !== 'no') stats.linearSections++;
    const doc = await section.createDocument();
    let text = '';
    Array.from(
      boot.textWalker(
        doc,
        (strings: string[]) => {
          text = strings.join('');
          stats.textNodes += strings.length;
          return [];
        },
        acceptNode,
      ),
    );
    stats.chars += text.length;
    for (const match of findContainsMatches(text, QUERY, CONTAINS_OPTIONS, 'zh')) {
      stats.locators.push({ section: sectionIndex, start: match.start, end: match.end });
    }
  }
  return stats;
};

// ---- scenarios ---------------------------------------------------------------

// S1: foldText + findContainsMatches over the synthetic zh text. Pure string
// ops — no DOM, no EPUB, safe to run anywhere. findContainsMatches runs the
// production foldText (module-private) over the whole text each round.
const runContainsMatch = (): BenchResult[] => {
  const text = buildSyntheticText();
  const expectedHits = Math.floor(SYNTH_CHARS / DENSITY_DIVISOR);

  const fold = timeSyncRounds(
    () => {
      foldValue(text, CONTAINS_OPTIONS, 'zh');
      return text.length;
    },
    FOLD_REPS,
    3,
  );
  const match = timeSyncRounds(
    () => {
      let hits = 0;
      for (const _match of findContainsMatches(text, QUERY, CONTAINS_OPTIONS, 'zh')) hits++;
      return hits;
    },
    MATCH_REPS,
    3,
  );

  if (match.count !== expectedHits) {
    throw new Error(
      `contains-match: expected ${expectedHits} hits at ~4% density, received ${match.count}`,
    );
  }

  return [
    {
      scenario: 'contains-match: foldText+indexOf, 80k-char zh common char (median)',
      unit: 'ms',
      value: medianOf(match.ms),
      meta: {
        chars: text.length,
        rounds: MATCH_REPS,
        hits: match.count,
        meanMs: Math.round(meanOf(match.ms) * 1000) / 1000,
      },
    },
    {
      scenario: 'contains-match: foldValue only (foldText body) (median)',
      unit: 'ms',
      value: medianOf(fold.ms),
      meta: { chars: text.length, rounds: FOLD_REPS },
    },
  ];
};

// Shared body for S2 (synthetic EPUB) and S3 (private fixture): open via
// DocumentLoader, collect contains locators untimed, then time the production
// resolveSearchResultCfis (createDocument + textWalker + batchedCfi) in full
// passes. session.open cost is excluded (session-cached in production too).
const runCfiResolve = async (
  boot: Boot,
  file: File,
  book: BookLike,
  reps: number,
  scenarioPrefix: string,
  extraMeta: Record<string, string | number>,
): Promise<BenchResult[]> => {
  const session = boot.createLibrarySearchSession(makeAppService(file));
  try {
    const { bookDoc } = await session.open(book); // untimed setup
    const stats = await collectLocators(boot, bookDoc); // untimed setup
    if (stats.locators.length === 0) {
      throw new Error(`${scenarioPrefix}: query "${QUERY}" produced no locators`);
    }

    const rounds = await timeAsyncRounds(async () => {
      const resolved = await boot.resolveSearchResultCfis(session, book, stats.locators);
      return resolved.filter((entry) => entry != null).length;
    }, reps);
    const ok = rounds.count;
    if (ok !== stats.locators.length) {
      throw new Error(
        `${scenarioPrefix}: expected ${stats.locators.length} resolved CFIs, received ${ok}`,
      );
    }
    const medianTotal = medianOf(rounds.ms);

    return [
      {
        scenario: `${scenarioPrefix}: resolveSearchResultCfis total (median)`,
        unit: 'ms',
        value: medianTotal,
        meta: {
          items: stats.locators.length,
          reps,
          resolvedOk: ok,
          sections: stats.totalSections,
          linearSections: stats.linearSections,
          textNodes: stats.textNodes,
          chars: stats.chars,
          ...extraMeta,
        },
      },
      {
        scenario: `${scenarioPrefix}: per-locator (median/items)`,
        unit: 'ms',
        value: medianTotal / stats.locators.length,
        meta: {
          items: stats.locators.length,
          totalMs: Math.round(medianTotal * 1000) / 1000,
          ...extraMeta,
        },
      },
    ];
  } finally {
    await session.close();
  }
};

const runCfiResolveSynthetic = async (): Promise<BenchResult[]> => {
  const boot = await getBoot();
  const file = buildSyntheticEpubFile();
  const book: BookLike = {
    hash: 'bench-inbook-zh',
    format: 'EPUB',
    title: 'bench',
    author: '',
    createdAt: 1,
    updatedAt: 1,
    primaryLanguage: 'zh',
  };
  return runCfiResolve(boot, file, book, SYNTH_CFI_REPS, 'cfi-resolve-synthetic', {
    bytes: file.size,
  });
};

const runCfiResolveFixture = async (): Promise<BenchResult[]> => {
  if (!SAMPLE_PRESENT) {
    return [
      {
        scenario: 'cfi-resolve-real-fixture: skipped (private fixture, local only)',
        unit: 'ms',
        value: 0,
        meta: { skipped: 'fixture not present', fixtureBytes: 0 },
      },
    ];
  }
  const boot = await getBoot();
  const buffer = readFileSync(SAMPLE_PATH);
  const file = new File([buffer], SAMPLE_NAME, { type: 'application/epub+zip' });
  return runCfiResolve(
    boot,
    file,
    makePrivateFixtureBook(),
    FIXTURE_CFI_REPS,
    'cfi-resolve-real-fixture',
    {
      bytes: file.size,
      fixture: 'private (local only)',
    },
  );
};

// ---- bench entry -------------------------------------------------------------

export default {
  name: 'inbook-search',
  description:
    'In-book search pipeline: contains matching (foldText+indexOf, synthetic zh) and ' +
    'resolveSearchResultCfis/batchedCfi over jsdom-opened EPUBs (S2 synthetic, S3 private ' +
    'real fixture, local only). jsdom is ~3x slower than real Chromium — same-machine ' +
    'before/after only. The highlight-replay segment needs a real layout engine and is ' +
    'measured in src/__tests__/diagnostics/search-perf.browser.test.ts.',

  async run(): Promise<BenchResult[]> {
    const results: BenchResult[] = [];

    results.push(...runContainsMatch());
    results.push(...(await runCfiResolveSynthetic()));
    results.push(...(await runCfiResolveFixture()));

    return results;
  },
} satisfies Bench;
