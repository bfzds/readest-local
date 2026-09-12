/**
 * 一次性性能诊断 harness（node/jsdom 道）：书内搜索 contains 匹配全链路对照。
 *
 * 与 search-perf.browser.test.ts（回放段）互补：这里跑 SearchBar.tsx
 * handleSearch 的「匹配 + CFI 解析」段 —— searchLibraryBooks（contains，
 * 主线程逐节 foldText + indexOf）与 resolveSearchResultCfis（batchedCfi），
 * 用内存生成的中文 EPUB（单节 8 万字，「的」密度 4% ≈ 3200 命中）。
 *
 * appService 依赖 mock 模式与 src/__tests__/services/library-search-service.test.ts
 * 一致；openDatabase 置为 reject → 走 live 扫描路径（无索引库时生产同路径），
 * fuzzy/nearby 的 search worker 在 contains 模式下从不创建（惰性 getWorker）。
 *
 * 运行（不跑全量套件时）：
 *   pnpm -C apps/readest-app exec dotenv -e .env -- vitest run \
 *     --silent=false src/__tests__/diagnostics/search-perf-node.test.ts
 * 注意：node 测试道全量跑（pnpm test）时会把本文件带上——诊断产物。
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

import {
  createLibrarySearchSession,
  resolveSearchResultCfis,
  searchLibraryBooks,
} from '@/services/librarySearchService';
import { findContainsMatches, foldValue } from '@/utils/containsSearch';
import { createRejectFilter } from '@/utils/node';
import type { Book, BookContent, LibrarySearchConfig } from '@/types/book';
import type { AppService } from '@/types/system';

const QUERY = '的';
const TOTAL_CHARS = 80_000;
const PARA_CHARS = 250;
const DENSITY_DIVISOR = 25;
const DENSITY_OFFSET = 7;

// ---- 真实私人样本夹具（本地存在才跑；仅输出数值，永不输出书内文本） -------
// 该 EPUB 是用户私人书籍，按 .gitignore 排除；他人 clone 时 describe 整体 skip。
const SAMPLE_NAME = '371c57b3-ecad-4256-99ae-d4394e2ec0ff.epub';
const SAMPLE_PATH = resolve(__dirname, '../fixtures/data', SAMPLE_NAME);
const SAMPLE_AVAILABLE = existsSync(SAMPLE_PATH);

// 合成书各段数值备忘，供真实样本用例并排对照打印。
const syntheticMemo = {
  sections: 0,
  textLen: 0,
  nodes: 0,
  hits: 0,
  openMs: 0,
  foldMs: 0,
  matchMs: 0,
  searchMs: 0,
  cfiMs: 0,
};

const POOL =
  '天地人在有这不中大为上个国我以要他时来用们生到作于出就分对成会可主发年动同方多事经法如后所定本学而论还进去说好过自很能下点心思想道里名些位置手理体知物给正外等合使明者问但文月相应度利工加无条件回并立军决比思民别被特据水强场提二已或其看平真任那从当与及着各部开启面展数目重至由百己化只儿两每';

if (POOL.includes(QUERY)) throw new Error('汉字池不能包含查询字，否则密度失真');

const fmt = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2));
const report = (label: string, totalMs: number, count: number, extra = '') => {
  const avg = count > 0 ? totalMs / count : 0;
  console.warn(
    `[search-perf] ${label}: ${fmt(totalMs)}ms / ${count} 条 / 均 ${fmt(avg)}ms${extra}`,
  );
};

// ---- 最小 STORE-ZIP 构建器（与 browser harness 相同，零依赖） -------------
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

interface ZipEntry {
  name: string;
  data: Uint8Array<ArrayBuffer>;
}

const buildStoreZip = (entries: ZipEntry[]): Blob => {
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

const buildChineseEpubFile = (): File => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  let text = '';
  while (text.length < TOTAL_CHARS) {
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
  text = text.slice(0, TOTAL_CHARS);
  const paragraphs: string[] = [];
  for (let start = 0; start < text.length; start += PARA_CHARS) {
    paragraphs.push(text.slice(start, start + PARA_CHARS));
  }
  const body = paragraphs.map((p) => `<p>${p}</p>`).join('');
  const chapter =
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>长文</title></head>` +
    `<body><h1>性能样章</h1>${body}</body></html>`;
  const nav =
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">` +
    `<head><title>目录</title></head><body><nav epub:type="toc"><ol>` +
    `<li><a href="ch1.xhtml">性能样章</a></li></ol></nav></body></html>`;
  const opf =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">` +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    `<dc:identifier id="uid">urn:uuid:readest-search-perf-zh</dc:identifier>` +
    `<dc:title>搜索性能诊断中文样书</dc:title><dc:language>zh</dc:language>` +
    `<dc:creator>diagnostics</dc:creator>` +
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
  return new File([blob], 'search-perf-zh.epub', { type: 'application/epub+zip' });
};

const makeBook = (): Book => ({
  hash: 'search-perf-zh',
  format: 'EPUB',
  title: '搜索性能诊断中文样书',
  author: 'diagnostics',
  createdAt: 1,
  updatedAt: 1,
  primaryLanguage: 'zh',
});

// 与 library-search-service.test.ts 的 makeService 同型；openDatabase 恒 reject
// → session.getIndexDb 得 null → searchLibraryBooks 走 live 扫描路径。
const makeAppService = (file: File) =>
  ({
    getBookFileSize: async () => file.size,
    loadBookContent: async (book: Book): Promise<BookContent> => ({ book, file }),
    resolveNativeBookFilePath: async () => null,
    loadBookNav: async () => null,
    databaseExists: async () => false,
    deleteDatabase: async () => undefined,
    openDatabase: async () => {
      throw new Error('diagnostics: index db disabled (live path)');
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
  }) as Pick<
    AppService,
    | 'databaseExists'
    | 'deleteDatabase'
    | 'getBookFileSize'
    | 'loadBookContent'
    | 'resolveNativeBookFilePath'
    | 'loadBookNav'
    | 'openDatabase'
    | 'createDir'
    | 'stats'
    | 'deleteDir'
  >;

const config: LibrarySearchConfig = {
  scope: 'book',
  mode: 'contains',
  matchCase: false,
  matchDiacritics: false,
};

describe('书内搜索性能诊断（node/jsdom，contains 全链路对照）', () => {
  it('searchLibraryBooks contains 全链路 + resolveSearchResultCfis + 匹配热函数', async () => {
    console.warn('[search-perf] ====== node 道：searchLibraryBooks contains 全链路 ======');
    const file = buildChineseEpubFile();
    const book = makeBook();
    const appService = makeAppService(file);
    const session = createLibrarySearchSession(appService);

    // 预开书（session.open 的 DocumentLoader 解析成本独立计入）。
    const tOpen = performance.now();
    const bookDoc = (await session.open(book)).bookDoc;
    const openMs = performance.now() - tOpen;
    report('node session.open（DocumentLoader 解析整本）', openMs, 1);
    syntheticMemo.openMs = openMs;
    syntheticMemo.sections = bookDoc.sections.filter((s) => s.linear !== 'no').length;

    // 与生产 prepareSearchSection 相同的提取方式，供热函数微基准用。
    const { textWalker } = await import('foliate-js/text-walker.js');
    const sectionIndex = bookDoc.sections.findIndex((s) => s.linear !== 'no');
    const doc = await bookDoc.sections[sectionIndex]!.createDocument();
    const acceptNode = createRejectFilter({ tags: [], attributes: ['cfi-inert'] });
    let sectionText = '';
    let nodeCount = 0;
    Array.from(
      textWalker(
        doc,
        (strings: string[]) => {
          sectionText = strings.join('');
          nodeCount = strings.length;
          return [];
        },
        acceptNode,
      ),
    );
    console.warn(
      `[search-perf] fixture: 单节 ${sectionText.length} 字 / ${nodeCount} 个文本节点，「${QUERY}」预期 ${Math.floor(TOTAL_CHARS / DENSITY_DIVISOR)} 处`,
    );
    syntheticMemo.textLen = sectionText.length;
    syntheticMemo.nodes = nodeCount;

    // 匹配热函数微基准（生产 contains 匹配的内层实现）。
    const tFold = performance.now();
    foldValue(sectionText, { matchCase: false, matchDiacritics: false }, 'zh');
    const foldMs = performance.now() - tFold;
    report('node foldValue 整节折叠拷贝（foldText 主体）', foldMs, 1);
    syntheticMemo.foldMs = foldMs;
    const tMatch = performance.now();
    const spans = Array.from(
      findContainsMatches(sectionText, QUERY, { matchCase: false, matchDiacritics: false }, 'zh'),
    );
    const matchMs = performance.now() - tMatch;
    report('node findContainsMatches 全量迭代（生产 contains 热路径）', matchMs, spans.length);
    syntheticMemo.matchMs = matchMs;
    syntheticMemo.hits = spans.length;

    // 全链路：与 SearchBar handleSearch 相同的调用与参数。
    const matches: Array<{ section: number; start: number; end: number }> = [];
    const tSearch = performance.now();
    let resultEvents = 0;
    let progressEvents = 0;
    for await (const event of searchLibraryBooks(appService, [book], QUERY, {
      config,
      session,
      maxResultsPerBook: Infinity,
      maxTotalResults: Infinity,
    })) {
      if (event.type === 'progress') {
        progressEvents++;
      } else if (event.type === 'result') {
        resultEvents++;
        for (const match of event.result.subitems) {
          matches.push(match.locator);
        }
      }
    }
    const searchMs = performance.now() - tSearch;
    report(
      `node searchLibraryBooks 全链路（live 提取+foldText+匹配+8ms 让步，result 事件 ${resultEvents} 个）`,
      searchMs,
      matches.length,
      ` | progress 事件 ${progressEvents} 个`,
    );
    syntheticMemo.searchMs = searchMs;
    expect(matches.length).toBe(spans.length);

    // CFI 解析段：生产 batchedCfi 批量路径（resolveSearchResultCfis）。
    const tCfi = performance.now();
    const resolved = await resolveSearchResultCfis(session, book, matches);
    const cfiMs = performance.now() - tCfi;
    const resolvedOk = resolved.filter((r) => r != null).length;
    report(
      `node resolveSearchResultCfis（batchedCfi 批量路径，成功 ${resolvedOk}/${matches.length}）`,
      cfiMs,
      matches.length,
    );
    syntheticMemo.cfiMs = cfiMs;

    // CFI 解析段的未优化对照：逐条 CFI.fromRange（node/jsdom 基线）。
    const sectionCfi = bookDoc.sections[sectionIndex]!.cfi ?? '';
    const { fromRange, joinIndir } = await import('foliate-js/epubcfi.js');
    let cumulative: number[] = [];
    let makeRange: (a: number, b: number, c: number, d: number) => Range = () => {
      throw new Error('unreachable');
    };
    Array.from(
      textWalker(
        doc,
        (
          strings: string[],
          makeRangeLocal: (a: number, b: number, c: number, d: number) => Range,
        ) => {
          cumulative = [0];
          for (const value of strings) cumulative.push(cumulative.at(-1)! + value.length);
          makeRange = makeRangeLocal;
          return [];
        },
        acceptNode,
      ),
    );
    const nodeIndexFor = (offset: number) => {
      let index = 0;
      while (index + 1 < cumulative.length - 1 && cumulative[index + 1]! <= offset) index++;
      return { index, offset: offset - cumulative[index]! };
    };
    const tRaw = performance.now();
    let rawCount = 0;
    for (const locator of matches) {
      const from = nodeIndexFor(locator.start);
      const to = nodeIndexFor(locator.end);
      const range = makeRange(from.index, from.offset, to.index, to.offset);
      if (joinIndir(sectionCfi, fromRange(range))) rawCount++;
    }
    const rawMs = performance.now() - tRaw;
    report(
      `node CFI.fromRange 逐条（未优化对照，成功 ${rawCount}）`,
      rawMs,
      rawCount,
      ` | batchedCfi 相对加速 ${(rawMs / Math.max(cfiMs, 0.001)).toFixed(1)}x`,
    );

    await session.close();
  }, 300_000);
});

// ---- 真实私人样本（本地夹具，缺失即整体跳过） -----------------------------
// 隐私约束：本 describe 的一切输出只允许数值（字节数/节数/文本长度/命中数/耗时），
// 绝不打印书内文本、元数据或摘录。样本路径已被 .gitignore 排除，永不入库。
describe.skipIf(!SAMPLE_AVAILABLE)('书内搜索性能诊断（真实私人样本，node 道）', () => {
  it('真实样本 searchLibraryBooks contains 全链路 + resolveSearchResultCfis（与合成书并排对照）', async () => {
    if (!SAMPLE_AVAILABLE) return; // describe.skipIf 已拦截，此处仅为类型收窄
    console.warn('[search-perf] ====== node 道：真实私人样本（仅数值输出）======');
    const buffer = readFileSync(SAMPLE_PATH);
    const file = new File([buffer], SAMPLE_NAME, { type: 'application/epub+zip' });
    console.warn(`[search-perf] fixture: ${SAMPLE_NAME} / ${file.size} 字节`);

    // 中性占位元数据：不读取书内 title/creator，避免任何内容经由 Book 对象外泄。
    const book: Book = {
      hash: 'private-search-perf-sample',
      format: 'EPUB',
      title: 'private-sample',
      author: '',
      createdAt: 1,
      updatedAt: 1,
      primaryLanguage: 'zh',
    };
    const appService = makeAppService(file);
    const session = createLibrarySearchSession(appService);

    // 预开书（与合成书同段：DocumentLoader 解析成本独立计入）。
    const tOpen = performance.now();
    const bookDoc = (await session.open(book)).bookDoc;
    const openMs = performance.now() - tOpen;
    report('样本 session.open（DocumentLoader 解析整本）', openMs, 1);

    // 文本量统计（独立计时段之外，仅长度/节点数）。
    const { textWalker } = await import('foliate-js/text-walker.js');
    const acceptNode = createRejectFilter({ tags: [], attributes: ['cfi-inert'] });
    let totalTextLen = 0;
    let totalNodes = 0;
    const linearSections = bookDoc.sections.filter((s) => s.linear !== 'no');
    for (const section of linearSections) {
      const doc = await section.createDocument();
      Array.from(
        textWalker(
          doc,
          (strings: string[]) => {
            totalTextLen += strings.join('').length;
            totalNodes += strings.length;
            return [];
          },
          acceptNode,
        ),
      );
    }
    console.warn(
      `[search-perf] 样本: linear 节数 ${linearSections.length}（总 ${bookDoc.sections.length}）, 文本 ${totalTextLen} 字 / ${totalNodes} 文本节点`,
    );

    // 全链路：与 SearchBar handleSearch 相同的调用与参数（contains + live 扫描）。
    const matches: Array<{ section: number; start: number; end: number }> = [];
    const hitsBySection = new Map<number, number>();
    let resultEvents = 0;
    let progressEvents = 0;
    const tSearch = performance.now();
    for await (const event of searchLibraryBooks(appService, [book], QUERY, {
      config,
      session,
      maxResultsPerBook: Infinity,
      maxTotalResults: Infinity,
    })) {
      if (event.type === 'progress') {
        progressEvents++;
      } else if (event.type === 'result') {
        resultEvents++;
        for (const match of event.result.subitems) {
          matches.push(match.locator);
          hitsBySection.set(
            match.locator.section,
            (hitsBySection.get(match.locator.section) ?? 0) + 1,
          );
        }
      }
    }
    const searchMs = performance.now() - tSearch;
    const perSection = [...hitsBySection.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([section, hits]) => `#${section}:${hits}`)
      .join(' ');
    report(
      `样本 searchLibraryBooks 全链路（result 事件 ${resultEvents} 个）`,
      searchMs,
      matches.length,
      ` | progress 事件 ${progressEvents} 个 | 节命中 ${perSection}`,
    );
    expect(matches.length).toBeGreaterThan(0);

    // CFI 解析段：生产 batchedCfi 批量路径。
    const tCfi = performance.now();
    const resolved = await resolveSearchResultCfis(session, book, matches);
    const cfiMs = performance.now() - tCfi;
    const resolvedOk = resolved.filter((r) => r != null).length;
    report(
      `样本 resolveSearchResultCfis（batchedCfi 批量路径，成功 ${resolvedOk}/${matches.length}）`,
      cfiMs,
      matches.length,
    );
    expect(resolvedOk).toBe(matches.length);

    // 并排对照（同 node 道、同 QUERY、同 contains 配置的合成书）。
    console.warn('[search-perf] ---- node 道对照：合成书 vs 真实样本 ----');
    console.warn(
      `[search-perf]   节数(linear): ${syntheticMemo.sections} vs ${linearSections.length}`,
    );
    console.warn(`[search-perf]   文本长度: ${syntheticMemo.textLen} vs ${totalTextLen} 字`);
    console.warn(`[search-perf]   命中总数: ${syntheticMemo.hits} vs ${matches.length}`);
    console.warn(`[search-perf]   session.open: ${fmt(syntheticMemo.openMs)} vs ${fmt(openMs)} ms`);
    console.warn(
      `[search-perf]   searchLibraryBooks: ${fmt(syntheticMemo.searchMs)} vs ${fmt(searchMs)} ms`,
    );
    console.warn(
      `[search-perf]   resolveSearchResultCfis: ${fmt(syntheticMemo.cfiMs)} vs ${fmt(cfiMs)} ms`,
    );

    await session.close();
  }, 300_000);
});
