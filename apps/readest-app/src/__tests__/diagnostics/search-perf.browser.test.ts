/**
 * 一次性性能诊断 harness（书内搜索「常用字如『的』性能不及预期」根因定位）。
 *
 * 测量对象（对应 SearchBar.tsx handleSearch 的回放段）：
 *   1. 段A  章节文本提取 + contains 匹配热函数（foldText / findContainsMatches）对照段；
 *   2. 段B  CFI.fromRange 逐条生成（搜索结果 → 高亮之间的主线程成本），
 *          并与生产在用的 batchedCfi 批量解析器对照；
 *   3. 段C  view.search({ results }) 回放段（H1：foliate view.js addHighlights
 *          对每条 CFI 调 addAnnotation 且从不让步 → 微任务风暴 / UI 冻结），
 *          用 monkey-patch 分解 resolveNavigation / CFI.toRange / overlayer.add
 *          / getClientRects / SVG 构建，并用 longtask + setTimeout(0) 饥饿
 *          度量主线程冻结时长；
 *   4. clearSearch 清注解段；
 *   5. 回放#2（clear 旧注解 + 重放，近似翻页/resize 的重放成本）。
 *
 * 书籍 fixture：运行时在内存里构建一本中文 EPUB（单节 80,000 字，
 * 「的」密度 4% ≈ 3200 命中，等价于“高频字搜整本书”的真实量级）。
 *
 * monkey-patch 仅存在于本诊断文件内，不触碰任何生产代码。
 *
 * 运行（不跑全量套件时）：
 *   pnpm -C apps/readest-app test:browser src/__tests__/diagnostics/search-perf.browser.test.ts
 * 注意：browser 测试道（test:browser）全量跑时会把本文件带上——这是诊断产物，
 * 如需剔除请在运行命令里指定别的文件集。
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { DocumentLoader } from '@/libs/document';
import type { BookDoc } from '@/libs/document';
import * as CFI from 'foliate-js/epubcfi.js';
import { findContainsMatches, foldValue } from '@/utils/containsSearch';
import { createRejectFilter } from '@/utils/node';
import { createBatchedSectionCfiResolver } from '@/utils/batchedCfi';

const QUERY = '的';
const TOTAL_CHARS = 80_000; // 单节中文字数
const PARA_CHARS = 250; // 每段字数 → 320 个 <p> 文本节点
const DENSITY_DIVISOR = 25; // 每 25 字一个「的」= 4% ≈ 3200 命中
const DENSITY_OFFSET = 7;

// ---- 真实私人样本夹具（本地存在才跑；仅输出数值，永不输出书内文本） ----
// 该 EPUB 是用户私人书籍，按 .gitignore 排除；他人 clone 时用例整体 skip。
const SAMPLE_NAME = '371c57b3-ecad-4256-99ae-d4394e2ec0ff.epub';
const SAMPLE_URL = new URL(`../fixtures/data/${SAMPLE_NAME}`, import.meta.url).href;

// 合成书回放数值备忘（段C/段E 写入），供真实样本用例并排对照。
const syntheticMemo = {
  hits: 0,
  replay1Ms: 0,
  replay2Ms: 0,
  starvation1Ms: 0,
  starvation2Ms: 0,
  longtasks1: 0,
  longtasks1MaxMs: 0,
  longtasks2: 0,
  longtasks2MaxMs: 0,
};

// 常用汉字池（不含「的」，否则密度失真）。
const POOL =
  '天地人在有这不中大为上个国我以要他时来用们生到作于出就分对成会可主发年动同方多事经法如后所定本学而论还进去说好过自很能下点心思想道里名些位置手理体知物给正外等合使明者问但文月相应度利工加无条件回并立军决比思民别被特据水强场提二已或其看平真任那从当与及着各部开启面展数目重至由百己化只儿两每';

if (POOL.includes(QUERY)) throw new Error('汉字池不能包含查询字，否则密度失真');

// ---- 输出工具 ------------------------------------------------------------
// vitest.browser.config.mts 静默 stdout（console.log），stderr（console.warn）会原样
// 打印 —— 与 paginator-overlay-top-inset.browser.test.ts 的做法一致。
const fmt = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2));
const report = (label: string, totalMs: number, count: number, extra = '') => {
  const avg = count > 0 ? totalMs / count : 0;
  console.warn(
    `[search-perf] ${label}: ${fmt(totalMs)}ms / ${count} 条 / 均 ${fmt(avg)}ms${extra}`,
  );
};
const percentiles = (xs: number[]) => {
  if (!xs.length) return { p50: 0, p95: 0, max: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length / 2)]!,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!,
    max: sorted[sorted.length - 1]!,
  };
};

// ---- 松散类型（foliate 原生 view/overlayer 的最小使用面） -----------------
type OverlayerLike = {
  add: (key: string, range: Range, draw: unknown, options?: unknown) => void;
  remove: (key: string) => void;
};
type RawFoliateView = HTMLElement & {
  open: (book: BookDoc) => Promise<void>;
  renderer: HTMLElement & {
    goTo: (target: { index: number; anchor?: number }) => Promise<void>;
    getContents: () => Array<{ doc: Document; index?: number; overlayer?: OverlayerLike }>;
    destroy: () => void;
  };
  search: (opts: Record<string, unknown>) => AsyncGenerator<unknown, void, void>;
  clearSearch: () => void;
  addAnnotation: (annotation: { value: string }, remove?: boolean) => Promise<unknown>;
  resolveNavigation: (
    target: string,
  ) => { index?: number; anchor?: (doc: Document) => Range | null } | undefined | null;
  close: () => void;
};
type TextWalkerFn = (
  x: Document,
  func: (
    strings: string[],
    makeRange: (a: number, b: number, c: number, d: number) => Range,
  ) => Iterable<unknown>,
  filterFunc?: (node: Node) => number,
) => Generator<unknown>;

interface Prepared {
  text: string;
  cumulative: number[];
  makeRange: (a: number, b: number, c: number, d: number) => Range;
}

// ---- 共享状态 ------------------------------------------------------------
let bookDoc: BookDoc;
let sectionIndex = 0;
let prepared: Prepared;
let matchPositions: Array<[number, number]> = [];
let cfis: string[] = [];
const segmentTimings = {
  createDocumentMs: 0,
  textWalkerMs: 0,
};

const buildChineseParagraphs = (): string[] => {
  // 确定性伪随机（LCG），可复现。
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
  return paragraphs;
};

// 最小 STORE-ZIP 构建器：手工拼 ZIP（无压缩）。
// 不用 @zip.js/zip.js 写入 —— 其 codec worker 脚本在 vitest 静态服务环境下
// 无法解析（pipeThrough of undefined）；STORE 逐字节拼接零依赖、行为确定。
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
    // local file header: sig, ver 20, flags(0x0800 utf-8), method 0 store,
    // time 0, date 0x21, crc, compSize, uncompSize, nameLen, extraLen 0
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

    // central directory header
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

const buildChineseEpubFile = async (): Promise<File> => {
  const encoder = new TextEncoder();
  const body = buildChineseParagraphs()
    .map((p) => `<p>${p}</p>`)
    .join('');
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

  const blob = buildStoreZip([
    { name: 'mimetype', data: encoder.encode('application/epub+zip') },
    { name: 'META-INF/container.xml', data: encoder.encode(container) },
    { name: 'OEBPS/content.opf', data: encoder.encode(opf) },
    { name: 'OEBPS/nav.xhtml', data: encoder.encode(nav) },
    { name: 'OEBPS/ch1.xhtml', data: encoder.encode(chapter) },
  ]);
  return new File([blob], 'search-perf-zh.epub', { type: 'application/epub+zip' });
};

const extractSection = async () => {
  const section = bookDoc.sections?.[sectionIndex];
  if (!section || typeof section.createDocument !== 'function') {
    throw new Error(`section ${sectionIndex} 不可提取`);
  }
  const tDoc = performance.now();
  const doc = await section.createDocument();
  segmentTimings.createDocumentMs = performance.now() - tDoc;

  const walker = (await import('foliate-js/text-walker.js')).textWalker as unknown as TextWalkerFn;
  const acceptNode = createRejectFilter({ tags: [], attributes: ['cfi-inert'] });
  let extracted: Prepared | null = null;
  const tWalk = performance.now();
  Array.from(
    walker(
      doc,
      (strings, makeRange) => {
        const text = strings.join('');
        const cumulative = [0];
        for (const value of strings) cumulative.push(cumulative.at(-1)! + value.length);
        extracted = { text, cumulative, makeRange };
        return [];
      },
      acceptNode,
    ),
  );
  segmentTimings.textWalkerMs = performance.now() - tWalk;
  if (!extracted) throw new Error('textWalker 未产出 section 文本');
  prepared = extracted;

  // 与 containsSearch 相同的 indexOf 循环找命中位置（joined 文本偏移）。
  const positions: Array<[number, number]> = [];
  let index = prepared.text.indexOf(QUERY);
  while (index >= 0) {
    positions.push([index, index + QUERY.length]);
    index = prepared.text.indexOf(QUERY, index + 1);
  }
  matchPositions = positions;
};

// joined 文本偏移 → (文本节点序号, 节点内偏移)，与 batchedCfi.findNodeOffset 同一语义。
const nodeIndexFor = (offset: number): { index: number; offset: number } => {
  const cumulative = prepared.cumulative;
  let index = 0;
  while (index + 1 < cumulative.length - 1 && cumulative[index + 1]! <= offset) index++;
  return { index, offset: offset - cumulative[index]! };
};

const baseCfi = () => bookDoc.sections?.[sectionIndex]?.cfi ?? CFI.fake.fromIndex(sectionIndex);

const waitForEvent = (target: EventTarget, type: string, timeout = 30000) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${type} timeout`)), timeout);
    target.addEventListener(
      type,
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

describe('书内搜索性能诊断（真实 Chromium，一次性 harness）', () => {
  beforeAll(async () => {
    const file = await buildChineseEpubFile();
    bookDoc = (await new DocumentLoader(file).open()).book;
    const linear = bookDoc.sections?.findIndex((s) => s.linear !== 'no') ?? -1;
    if (linear < 0) throw new Error('EPUB 无可读 section');
    sectionIndex = linear;
    await extractSection();
  }, 180_000);

  it('段A：章节提取 + contains 匹配热函数对照（主线程）', () => {
    const text = prepared.text;
    const density = (matchPositions.length / text.length) * 100;

    console.warn('[search-perf] ====== 段A：文本提取 + contains 匹配对照 ======');
    console.warn(
      `[search-perf] fixture: 单节 ${text.length} 字，「${QUERY}」${matchPositions.length} 处（密度 ${density.toFixed(2)}%），` +
        `${prepared.cumulative.length - 1} 个文本节点`,
    );
    report('段A createDocument（DOM 解析）', segmentTimings.createDocumentMs, 1);
    report('段A textWalker 整节提取（strings.join）', segmentTimings.textWalkerMs, 1);

    // foldText 的主拷贝成本（foldValue = toLocaleLowerCase + NFD 归一；纯中文长度不变，
    // 无需 offsets 映射，foldText ≈ foldValue）。
    const tFold = performance.now();
    const folded = foldValue(text, { matchCase: false, matchDiacritics: false }, 'zh');
    const foldMs = performance.now() - tFold;
    report(
      `段A foldValue 整节折叠拷贝（foldText 主体，输出 ${folded.length} 字）`,
      foldMs,
      1,
      ` ← ${fmt((text.length / 1000 / foldMs) * 1000)}k字/ms`,
    );

    // findContainsMatches 全量迭代（含内部 foldText + indexOf 循环）= 生产 contains 热路径。
    const tMatch = performance.now();
    const spans = Array.from(
      findContainsMatches(text, QUERY, { matchCase: false, matchDiacritics: false }, 'zh'),
    );
    const matchMs = performance.now() - tMatch;
    report('段A findContainsMatches 全量迭代（生产 contains 匹配热路径）', matchMs, spans.length);
    expect(spans.length).toBe(matchPositions.length);
  }, 60_000);

  it('段B：CFI.fromRange 逐条生成 vs 生产 batchedCfi 批量解析', () => {
    const sectionCfi = baseCfi();
    const durations: number[] = [];
    const generated: string[] = [];

    const t0 = performance.now();
    for (const [start, end] of matchPositions) {
      const from = nodeIndexFor(start);
      const to = nodeIndexFor(end);
      const range = prepared.makeRange(from.index, from.offset, to.index, to.offset);
      const tCfi = performance.now();
      const cfi = CFI.joinIndir(sectionCfi, CFI.fromRange(range));
      durations.push(performance.now() - tCfi);
      generated.push(cfi);
    }
    const genTotal = performance.now() - t0;
    const { p50, p95, max } = percentiles(durations);

    console.warn('[search-perf] ====== 段B：CFI 生成（搜索结果 → 高亮之间）======');
    report(
      '段B CFI.fromRange 逐条（未优化基线）',
      genTotal,
      generated.length,
      ` | p50 ${fmt(p50)}ms / p95 ${fmt(p95)}ms / max ${fmt(max)}ms`,
    );

    // 生产路径：resolveSearchResultCfis 实际使用 createBatchedSectionCfiResolver。
    const resolver = createBatchedSectionCfiResolver(prepared, sectionCfi);
    const t1 = performance.now();
    let batchedCount = 0;
    for (const [start, end] of matchPositions) {
      if (resolver(start, end) != null) batchedCount++;
    }
    const batchedTotal = performance.now() - t1;
    report(
      `段B batchedCfi（生产批量路径，成功 ${batchedCount} 条）`,
      batchedTotal,
      batchedCount,
      ` | 相对逐条加速 ${(genTotal / Math.max(batchedTotal, 0.001)).toFixed(1)}x`,
    );

    // 抽验 CFI 可解析（resolveNavigation 用得到）：首条应命中本节。
    const probe = bookDoc.resolveCFI?.(generated[0]!);
    expect(probe?.index).toBe(sectionIndex);
    cfis = generated;
  }, 120_000);

  it('段C：view.search 回放（核心段 H1）+ clearSearch + 二次回放', async () => {
    expect(cfis.length).toBe(matchPositions.length);
    await import('foliate-js/view.js');

    const container = document.createElement('div');
    Object.assign(container.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '800px',
      height: '600px',
    });
    document.body.appendChild(container);
    const view = document.createElement('foliate-view') as unknown as RawFoliateView;
    container.appendChild(view);

    try {
      await view.open(bookDoc);
      view.renderer.setAttribute('max-column-count', '1');
      view.renderer.setAttribute('max-inline-size', '800px');
      view.renderer.setAttribute('max-block-size', '1000px');
      view.renderer.setAttribute('margin-top', '0px');
      view.renderer.setAttribute('margin-bottom', '0px');
      view.renderer.setAttribute('margin-left', '0px');
      view.renderer.setAttribute('margin-right', '0px');
      view.renderer.setAttribute('gap', '0%');
      const stabilized = waitForEvent(view.renderer, 'stabilized');
      await view.renderer.goTo({ index: sectionIndex, anchor: 0 });
      await stabilized;
      // 等布局/分页彻底稳定再开始测量。
      await new Promise((r) => setTimeout(r, 500));

      const content = view.renderer.getContents().find((c) => c.index === sectionIndex);
      expect(content?.overlayer).toBeTruthy();

      // ---- monkey-patch（仅本 harness）----
      const origAddAnnotation = view.addAnnotation.bind(view);
      const origResolveNavigation = view.resolveNavigation.bind(view);
      const overlayer = content!.overlayer as OverlayerLike;
      const origOverlayerAdd = overlayer.add.bind(overlayer);
      const origGetClientRects = Range.prototype.getClientRects;
      // overlayer 的 Range 属于 section iframe 的 realm，主 realm 的
      // Range.prototype 补丁拦不到，必须分别包装。
      const iframeRangeProto = content!.doc.defaultView?.Range?.prototype;
      const origIframeGetClientRects = iframeRangeProto?.getClientRects;
      const isIframeRealm = Boolean(iframeRangeProto && iframeRangeProto !== Range.prototype);

      const stats = {
        addAnn: { count: 0, syncTotal: 0, deferredTotal: 0, max: 0, samples: [] as number[] },
        nav: { count: 0, total: 0 },
        toRange: { count: 0, total: 0 },
        olAdd: { count: 0, total: 0 },
        rects: { count: 0, total: 0 },
      };
      const resetStats = () => {
        stats.addAnn = { count: 0, syncTotal: 0, deferredTotal: 0, max: 0, samples: [] };
        stats.nav = { count: 0, total: 0 };
        stats.toRange = { count: 0, total: 0 };
        stats.olAdd = { count: 0, total: 0 };
        stats.rects = { count: 0, total: 0 };
      };

      let rectsEnabled = false;
      const wrapGetClientRects = (orig: () => DOMRectList) =>
        function (this: Range) {
          if (!rectsEnabled) return orig.call(this);
          const t0 = performance.now();
          const rects = orig.call(this);
          stats.rects.total += performance.now() - t0;
          stats.rects.count++;
          return rects;
        };
      Range.prototype.getClientRects = wrapGetClientRects(
        origGetClientRects,
      ) as typeof Range.prototype.getClientRects;
      if (isIframeRealm && iframeRangeProto) {
        iframeRangeProto.getClientRects = wrapGetClientRects(
          origIframeGetClientRects!,
        ) as typeof Range.prototype.getClientRects;
      }

      // 宏任务饥饿标记：必须在「风暴任务内部」武装 setTimeout(0)——异步生成器
      // 体在微任务里启动，循环外武装的定时器会在任务间隙提前触发，测不到冻结。
      // 首条注解的同步前缀就在风暴任务里，正好用于武装。
      let pendingArm: ((fireDelay: number) => void) | null = null;
      const armStarvation = () =>
        new Promise<number>((resolve) => {
          pendingArm = (fireDelay) => resolve(fireDelay);
        });

      let replayStart = 0;
      view.addAnnotation = async (annotation, remove) => {
        if (pendingArm) {
          const arm = pendingArm;
          pendingArm = null;
          const armStart = performance.now();
          setTimeout(() => arm(performance.now() - armStart), 0);
        }
        const t0 = performance.now();
        const done = origAddAnnotation(annotation, remove);
        stats.addAnn.syncTotal += performance.now() - t0;
        await done;
        const deferred = performance.now() - t0;
        stats.addAnn.deferredTotal += deferred;
        stats.addAnn.count++;
        stats.addAnn.samples.push(deferred);
        if (deferred > stats.addAnn.max) stats.addAnn.max = deferred;
        if (stats.addAnn.count % 500 === 0) {
          console.warn(
            `[search-perf] 回放进度 @${stats.addAnn.count} 条: 已进行 ${fmt(performance.now() - replayStart)}ms`,
          );
        }
        return undefined;
      };
      view.resolveNavigation = (target) => {
        const t0 = performance.now();
        const resolved = origResolveNavigation(target);
        stats.nav.total += performance.now() - t0;
        stats.nav.count++;
        if (resolved && typeof resolved.anchor === 'function') {
          const origAnchor = resolved.anchor;
          return {
            ...resolved,
            anchor: (doc: Document) => {
              const t1 = performance.now();
              const range = origAnchor(doc);
              stats.toRange.total += performance.now() - t1;
              stats.toRange.count++;
              return range;
            },
          };
        }
        return resolved;
      };
      overlayer.add = (key, range, draw, options) => {
        const t0 = performance.now();
        origOverlayerAdd(key, range, draw, options);
        stats.olAdd.total += performance.now() - t0;
        stats.olAdd.count++;
      };

      // longtask 观测（Chromium 支持；COOP/COEP 已由 vitest.browser.config.mts 设置）。
      const longTasks: PerformanceEntry[] = [];
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry);
      });
      try {
        po.observe({ type: 'longtask', buffered: true } as PerformanceObserverInit);
      } catch {
        console.warn('[search-perf] longtask 观测不可用，改用 chunk 时间戳近似');
      }

      const results = [
        {
          index: sectionIndex,
          label: '性能样章',
          subitems: cfis.map((cfi) => ({ cfi, excerpt: QUERY })),
        },
      ];
      const searchOpts = {
        scope: 'book',
        mode: 'contains',
        matchCase: false,
        matchDiacritics: false,
        query: QUERY,
        results,
      };

      const reportLongTasks = (phase: string, entries: PerformanceEntry[]) => {
        if (entries.length > 0) {
          const longest = entries.reduce((a, b) => (b.duration > a.duration ? b : a));
          const totalLong = entries.reduce((sum, e) => sum + e.duration, 0);
          console.warn(
            `[search-perf] ${phase} longtask(>50ms) 块: ${entries.length} 个，最长 ${fmt(longest.duration)}ms，合计 ${fmt(totalLong)}ms`,
          );
          for (const [i, entry] of entries.slice(0, 12).entries()) {
            console.warn(`[search-perf]   longtask#${i + 1}: ${fmt(entry.duration)}ms`);
          }
        } else {
          console.warn(`[search-perf] ${phase} longtask: 未观测到 >50ms 块`);
        }
      };

      const replay = async () => {
        const starvation = armStarvation();
        const t0 = performance.now();
        rectsEnabled = true;
        const taskCountBefore = longTasks.length;
        for await (const item of view.search(searchOpts)) {
          if (item === 'done') break;
        }
        const total = performance.now() - t0;
        // 让 addAnnotation 包装器的收尾微任务与 longtask 回调跑完。
        const starvationDelay = await starvation;
        await new Promise((r) => setTimeout(r, 100));
        rectsEnabled = false;
        return {
          total,
          starvationDelay,
          tasks: longTasks.slice(taskCountBefore),
          snapshot: {
            addAnn: { ...stats.addAnn, samples: [...stats.addAnn.samples] },
            nav: { ...stats.nav },
            toRange: { ...stats.toRange },
            olAdd: { ...stats.olAdd },
            rects: { ...stats.rects },
          },
        };
      };

      // 预热 foliate search.js 模块：view.search 首次调用有真实模块加载的
      // 宏任务边界，会把风暴切成两个 task，干扰长任务观测。
      await import('foliate-js/search.js');

      console.warn('[search-perf] ====== 段C：view.search 回放（核心段，H1 检验）======');
      replayStart = performance.now();
      const first = await replay();
      const s = first.snapshot;
      const { p50, p95, max } = percentiles(s.addAnn.samples);

      report('段C1 回放#1 view.search(results) 总耗时', first.total, s.addAnn.count);
      report('段C1   resolveNavigation 累计（CFI.parse + spine 定位）', s.nav.total, s.nav.count);
      report('段C1   CFI.toRange 累计（anchor(doc)）', s.toRange.total, s.toRange.count);
      report(
        '段C1   overlayer.add 累计（getRects + SVG 构建）',
        s.olAdd.total,
        s.olAdd.count,
        `；SVG 构建 ≈ ${fmt(s.olAdd.total - s.rects.total)}ms`,
      );
      report('段C1     └ 其中 getClientRects 累计', s.rects.total, s.rects.count);
      report(
        '段C1   addAnnotation 同步前缀累计（入队段，非 await）',
        s.addAnn.syncTotal,
        s.addAnn.count,
      );
      console.warn(
        `[search-perf] 段C1 addAnnotation await 兑现延迟: 均 ${fmt(s.addAnn.deferredTotal / Math.max(s.addAnn.count, 1))}ms | p50 ${fmt(p50)}ms / p95 ${fmt(p95)}ms / max ${fmt(max)}ms ← 每条注解的 promise 要等整个风暴排空才兑现（微任务不让步证据）`,
      );
      console.warn(
        `[search-perf] 段C1 宏任务饥饿 setTimeout(0) 实际延迟: ${fmt(first.starvationDelay)}ms ← 主线程连续冻结近似`,
      );
      reportLongTasks('段C1', first.tasks);
      syntheticMemo.hits = s.addAnn.count;
      syntheticMemo.replay1Ms = first.total;
      syntheticMemo.starvation1Ms = first.starvationDelay;
      syntheticMemo.longtasks1 = first.tasks.length;
      syntheticMemo.longtasks1MaxMs = first.tasks.reduce((m, t) => Math.max(m, t.duration), 0);

      // ---- clearSearch ----
      console.warn('[search-perf] ====== 段D：clearSearch 清旧注解 ======');
      resetStats();
      const clearStarvation = armStarvation();
      const tClear = performance.now();
      view.clearSearch();
      const clearSync = performance.now() - tClear;
      const clearFull = await clearStarvation;
      await new Promise((r) => setTimeout(r, 50));
      report(
        '段D clearSearch 同步段（含清注解的 CFI.parse）',
        clearSync,
        stats.nav.count,
        `；至宏任务恢复 ${fmt(clearFull)}ms`,
      );

      // ---- 回放#2：清旧 + 重放（近似翻页/resize 触发的重放成本） ----
      console.warn('[search-perf] ====== 段E：回放#2（含清旧，近似翻页/resize 重放）======');
      resetStats();
      const second = await replay();
      const e = second.snapshot;
      report(
        '段E 回放#2 view.search(results) 总耗时（含内部 clearSearch）',
        second.total,
        e.addAnn.count,
      );
      report('段E   resolveNavigation 累计', e.nav.total, e.nav.count);
      report('段E   CFI.toRange 累计', e.toRange.total, e.toRange.count);
      report(
        '段E   overlayer.add 累计',
        e.olAdd.total,
        e.olAdd.count,
        `；SVG 构建 ≈ ${fmt(e.olAdd.total - e.rects.total)}ms`,
      );
      console.warn(
        `[search-perf] 段E 宏任务饥饿 setTimeout(0) 实际延迟: ${fmt(second.starvationDelay)}ms`,
      );
      reportLongTasks('段E', second.tasks);
      syntheticMemo.replay2Ms = second.total;
      syntheticMemo.starvation2Ms = second.starvationDelay;
      syntheticMemo.longtasks2 = second.tasks.length;
      syntheticMemo.longtasks2MaxMs = second.tasks.reduce((m, t) => Math.max(m, t.duration), 0);

      // 收尾：清注解 + 关闭 + 还原补丁。
      view.clearSearch();
      Range.prototype.getClientRects = origGetClientRects;
      if (isIframeRealm && iframeRangeProto) {
        iframeRangeProto.getClientRects = origIframeGetClientRects!;
      }
      po.disconnect();
    } finally {
      try {
        view.close();
      } catch {
        /* 忽略 teardown 异常 */
      }
      container.remove();
    }
  }, 300_000);
});

// ---- 真实私人样本（本地夹具，缺失即跳过） ---------------------------------
// 隐私约束：本 describe 的一切输出只允许数值（字节数/节数/文本长度/命中数/耗时），
// 绝不打印书内文本、元数据、TOC 标签或摘录。样本路径已被 .gitignore 排除。
describe('真实样本回放诊断（私人 EPUB 本地夹具，缺失即跳过）', () => {
  it('真实样本 view.search 回放全部命中 + longtask + 二次回放（与合成书并排对照）', async (ctx) => {
    // 夹具是用户私人书籍：仅在本地存在，缺失时整体跳过（他人 clone 不能挂）。
    let sampleFile: File | null = null;
    try {
      const resp = await fetch(SAMPLE_URL);
      if (resp.ok) {
        sampleFile = new File([await resp.arrayBuffer()], SAMPLE_NAME, {
          type: 'application/epub+zip',
        });
      }
    } catch {
      sampleFile = null;
    }
    if (!sampleFile) {
      console.warn('[search-perf] 私人样本缺失（.gitignore 排除，他人 clone 无此文件），跳过');
      ctx.skip();
      return; // ctx.skip() 已中止测试，return 仅满足类型收窄
    }
    console.warn('[search-perf] ====== 真实样本：foliate view 回放（仅数值输出）======');
    console.warn(`[search-perf] fixture: ${SAMPLE_NAME} / ${sampleFile.size} 字节`);

    const sampleBookDoc = (await new DocumentLoader(sampleFile).open()).book;

    // 逐 linear 节提取 + contains 匹配（与段A同法；生产 batchedCfi 生成回放 CFI）。
    const walker = (await import('foliate-js/text-walker.js'))
      .textWalker as unknown as TextWalkerFn;
    const acceptNode = createRejectFilter({ tags: [], attributes: ['cfi-inert'] });
    const sampleSections: Array<{
      index: number;
      prepared: Prepared;
      hits: number;
      cfis: string[];
    }> = [];
    let totalTextLen = 0;
    let totalNodes = 0;
    // 与 extractSection 同型：闭包内赋值 + 抛错守卫（独立函数体保证 CFA 收窄）。
    const extractPrepared = async (doc: Document): Promise<Prepared> => {
      let extracted: Prepared | null = null;
      Array.from(
        walker(
          doc,
          (strings, makeRange) => {
            const text = strings.join('');
            const cumulative = [0];
            for (const value of strings) cumulative.push(cumulative.at(-1)! + value.length);
            extracted = { text, cumulative, makeRange };
            return [];
          },
          acceptNode,
        ),
      );
      if (!extracted) throw new Error('textWalker 未产出 section 文本');
      return extracted;
    };
    for (const [index, section] of (sampleBookDoc.sections ?? []).entries()) {
      if (section.linear === 'no' || typeof section.createDocument !== 'function') continue;
      const tDoc = performance.now();
      const doc = await section.createDocument();
      const createDocMs = performance.now() - tDoc;
      const tWalk = performance.now();
      const extracted = await extractPrepared(doc);
      const walkMs = performance.now() - tWalk;
      const positions: Array<[number, number]> = [];
      let cursor = extracted.text.indexOf(QUERY);
      while (cursor >= 0) {
        positions.push([cursor, cursor + QUERY.length]);
        cursor = extracted.text.indexOf(QUERY, cursor + 1);
      }
      const sectionCfi = section.cfi ?? CFI.fake.fromIndex(index);
      const resolver = createBatchedSectionCfiResolver(extracted, sectionCfi);
      const tCfi = performance.now();
      const cfis = positions
        .map(([start, end]) => resolver(start, end))
        .filter((cfi): cfi is string => cfi != null);
      const cfiMs = performance.now() - tCfi;
      sampleSections.push({ index, prepared: extracted, hits: positions.length, cfis });
      totalTextLen += extracted.text.length;
      totalNodes += extracted.cumulative.length - 1;
      console.warn(
        `[search-perf] 样本节#${index}: ${extracted.text.length} 字 / ${extracted.cumulative.length - 1} 文本节点 / ` +
          `${positions.length} 处命中 / ${cfis.length} 条 CFI（createDocument ${fmt(createDocMs)}ms, textWalker ${fmt(walkMs)}ms, batchedCfi ${fmt(cfiMs)}ms）`,
      );
    }
    expect(sampleSections.length).toBeGreaterThan(0);
    const totalHits = sampleSections.reduce((sum, s) => sum + s.hits, 0);
    const totalCfis = sampleSections.reduce((sum, s) => sum + s.cfis.length, 0);
    expect(totalCfis).toBe(totalHits);
    console.warn(
      `[search-perf] 样本合计: linear 节 ${sampleSections.length} 个, 文本 ${totalTextLen} 字 / ${totalNodes} 文本节点, 命中 ${totalHits} 处 / ${totalCfis} 条 CFI`,
    );

    await import('foliate-js/view.js');
    const container = document.createElement('div');
    Object.assign(container.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '800px',
      height: '600px',
    });
    document.body.appendChild(container);
    const view = document.createElement('foliate-view') as unknown as RawFoliateView;
    container.appendChild(view);

    try {
      await view.open(sampleBookDoc);
      view.renderer.setAttribute('max-column-count', '1');
      view.renderer.setAttribute('max-inline-size', '800px');
      view.renderer.setAttribute('max-block-size', '1000px');
      view.renderer.setAttribute('margin-top', '0px');
      view.renderer.setAttribute('margin-bottom', '0px');
      view.renderer.setAttribute('margin-left', '0px');
      view.renderer.setAttribute('margin-right', '0px');
      view.renderer.setAttribute('gap', '0%');
      // 命中最多的节作为回放锚点（多节书只有当前渲染节挂 overlayer）。
      const primary = sampleSections.reduce((a, b) => (b.cfis.length > a.cfis.length ? b : a));
      const stabilized = waitForEvent(view.renderer, 'stabilized');
      await view.renderer.goTo({ index: primary.index, anchor: 0 });
      await stabilized;
      // 等布局/分页彻底稳定再开始测量。
      await new Promise((r) => setTimeout(r, 500));

      // ---- monkey-patch（仅本 harness）----
      const stats = {
        addAnn: { count: 0, syncTotal: 0, deferredTotal: 0, max: 0, samples: [] as number[] },
        nav: { count: 0, total: 0 },
        toRange: { count: 0, total: 0 },
        olAdd: { count: 0, total: 0 },
        rects: { count: 0, total: 0 },
      };
      const resetStats = () => {
        stats.addAnn = { count: 0, syncTotal: 0, deferredTotal: 0, max: 0, samples: [] };
        stats.nav = { count: 0, total: 0 };
        stats.toRange = { count: 0, total: 0 };
        stats.olAdd = { count: 0, total: 0 };
        stats.rects = { count: 0, total: 0 };
      };

      let rectsEnabled = false;
      const wrapGetClientRects = (orig: () => DOMRectList) =>
        function (this: Range) {
          if (!rectsEnabled) return orig.call(this);
          const t0 = performance.now();
          const rects = orig.call(this);
          stats.rects.total += performance.now() - t0;
          stats.rects.count++;
          return rects;
        };
      // 主 realm + 每个 section iframe realm 分别包装（overlayer 的 Range 属于
      // iframe realm，主 realm 的 Range.prototype 补丁拦不到）。
      const restoreFns: Array<() => void> = [];
      const patchRangeRealm = (proto: Range | undefined) => {
        if (!proto) return;
        const orig = proto.getClientRects;
        proto.getClientRects = wrapGetClientRects(orig) as typeof Range.prototype.getClientRects;
        restoreFns.push(() => {
          proto.getClientRects = orig;
        });
      };
      patchRangeRealm(Range.prototype);
      for (const content of view.renderer.getContents()) {
        patchRangeRealm(content.doc.defaultView?.Range?.prototype);
      }
      // overlayer.add 对所有已加载且属于样本的节分别包装。
      let olAddPatched = 0;
      for (const content of view.renderer.getContents()) {
        if (!content.overlayer) continue;
        if (!sampleSections.some((s) => s.index === content.index)) continue;
        const overlayer = content.overlayer as OverlayerLike;
        const origOverlayerAdd = overlayer.add.bind(overlayer);
        overlayer.add = (key, range, draw, options) => {
          const t0 = performance.now();
          origOverlayerAdd(key, range, draw, options);
          stats.olAdd.total += performance.now() - t0;
          stats.olAdd.count++;
        };
        restoreFns.push(() => {
          overlayer.add = origOverlayerAdd;
        });
        olAddPatched++;
      }
      const loadedIndexes = view.renderer
        .getContents()
        .map((c) => c.index)
        .join(',');
      console.warn(
        `[search-perf] 已加载节: [${loadedIndexes}] / overlayer 已包装 ${olAddPatched} 个（锚点节 #${primary.index}）`,
      );

      const origAddAnnotation = view.addAnnotation.bind(view);
      const origResolveNavigation = view.resolveNavigation.bind(view);
      let pendingArm: ((fireDelay: number) => void) | null = null;
      const armStarvation = () =>
        new Promise<number>((resolve) => {
          pendingArm = (fireDelay) => resolve(fireDelay);
        });
      let replayStart = 0;
      view.addAnnotation = async (annotation, remove) => {
        if (pendingArm) {
          const arm = pendingArm;
          pendingArm = null;
          const armStart = performance.now();
          setTimeout(() => arm(performance.now() - armStart), 0);
        }
        const t0 = performance.now();
        const done = origAddAnnotation(annotation, remove);
        // 回放#2 前的内部 clearSearch 复用 addAnnotation(remove=true) 清注解，
        // 不计入注解风暴统计（否则命中数翻倍）。
        if (remove) {
          await done;
          return undefined;
        }
        stats.addAnn.syncTotal += performance.now() - t0;
        await done;
        const deferred = performance.now() - t0;
        stats.addAnn.deferredTotal += deferred;
        stats.addAnn.count++;
        stats.addAnn.samples.push(deferred);
        if (deferred > stats.addAnn.max) stats.addAnn.max = deferred;
        if (stats.addAnn.count % 500 === 0) {
          console.warn(
            `[search-perf] 回放进度 @${stats.addAnn.count} 条: 已进行 ${fmt(performance.now() - replayStart)}ms`,
          );
        }
        return undefined;
      };
      view.resolveNavigation = (target) => {
        const t0 = performance.now();
        const resolved = origResolveNavigation(target);
        stats.nav.total += performance.now() - t0;
        stats.nav.count++;
        if (resolved && typeof resolved.anchor === 'function') {
          const origAnchor = resolved.anchor;
          return {
            ...resolved,
            anchor: (doc: Document) => {
              const t1 = performance.now();
              const range = origAnchor(doc);
              stats.toRange.total += performance.now() - t1;
              stats.toRange.count++;
              return range;
            },
          };
        }
        return resolved;
      };

      // longtask 观测（Chromium 支持；COOP/COEP 已由 vitest.browser.config.mts 设置）。
      const longTasks: PerformanceEntry[] = [];
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry);
      });
      try {
        po.observe({ type: 'longtask', buffered: true } as PerformanceObserverInit);
      } catch {
        console.warn('[search-perf] longtask 观测不可用，改用 chunk 时间戳近似');
      }

      const reportLongTasks = (phase: string, entries: PerformanceEntry[]) => {
        if (entries.length > 0) {
          const longest = entries.reduce((a, b) => (b.duration > a.duration ? b : a));
          const totalLong = entries.reduce((sum, e) => sum + e.duration, 0);
          console.warn(
            `[search-perf] ${phase} longtask(>50ms) 块: ${entries.length} 个，最长 ${fmt(longest.duration)}ms，合计 ${fmt(totalLong)}ms`,
          );
        } else {
          console.warn(`[search-perf] ${phase} longtask: 未观测到 >50ms 块`);
        }
      };

      // 中性标签（不含书内文本）；excerpt 仅传查询字本身。
      const results = sampleSections
        .filter((s) => s.cfis.length > 0)
        .map((s) => ({
          index: s.index,
          label: `section-${s.index}`,
          subitems: s.cfis.map((cfi) => ({ cfi, excerpt: QUERY })),
        }));
      const searchOpts = {
        scope: 'book',
        mode: 'contains',
        matchCase: false,
        matchDiacritics: false,
        query: QUERY,
        results,
      };

      const replay = async () => {
        const starvation = armStarvation();
        const t0 = performance.now();
        rectsEnabled = true;
        const taskCountBefore = longTasks.length;
        for await (const item of view.search(searchOpts)) {
          if (item === 'done') break;
        }
        const total = performance.now() - t0;
        const starvationDelay = await starvation;
        await new Promise((r) => setTimeout(r, 100));
        rectsEnabled = false;
        return {
          total,
          starvationDelay,
          tasks: longTasks.slice(taskCountBefore),
          snapshot: {
            addAnn: { ...stats.addAnn, samples: [...stats.addAnn.samples] },
            nav: { ...stats.nav },
            toRange: { ...stats.toRange },
            olAdd: { ...stats.olAdd },
            rects: { ...stats.rects },
          },
        };
      };

      // 预热 foliate search.js 模块（与段C相同：避免首调宏任务边界干扰观测）。
      await import('foliate-js/search.js');

      console.warn('[search-perf] ====== 真实样本回放#1 ======');
      replayStart = performance.now();
      const first = await replay();
      const s = first.snapshot;
      const { p50, p95, max } = percentiles(s.addAnn.samples);
      report('真实样本 回放#1 view.search(results) 总耗时', first.total, s.addAnn.count);
      report('真实样本   resolveNavigation 累计', s.nav.total, s.nav.count);
      report('真实样本   CFI.toRange 累计（anchor(doc)）', s.toRange.total, s.toRange.count);
      report('真实样本   overlayer.add 累计', s.olAdd.total, s.olAdd.count);
      report('真实样本     └ 其中 getClientRects 累计', s.rects.total, s.rects.count);
      console.warn(
        `[search-perf] 真实样本 addAnnotation await 兑现延迟: 均 ${fmt(s.addAnn.deferredTotal / Math.max(s.addAnn.count, 1))}ms | p50 ${fmt(p50)}ms / p95 ${fmt(p95)}ms / max ${fmt(max)}ms`,
      );
      console.warn(
        `[search-perf] 真实样本 宏任务饥饿 setTimeout(0) 实际延迟: ${fmt(first.starvationDelay)}ms`,
      );
      reportLongTasks('真实样本回放#1', first.tasks);
      expect(s.addAnn.count).toBe(totalCfis);

      // ---- clearSearch + 二次回放 ----
      console.warn('[search-perf] ====== 真实样本回放#2（含内部 clearSearch）======');
      resetStats();
      const second = await replay();
      const e = second.snapshot;
      report('真实样本 回放#2 view.search(results) 总耗时', second.total, e.addAnn.count);
      report('真实样本   resolveNavigation 累计', e.nav.total, e.nav.count);
      report('真实样本   CFI.toRange 累计', e.toRange.total, e.toRange.count);
      report('真实样本   overlayer.add 累计', e.olAdd.total, e.olAdd.count);
      console.warn(
        `[search-perf] 真实样本 宏任务饥饿 setTimeout(0) 实际延迟: ${fmt(second.starvationDelay)}ms`,
      );
      reportLongTasks('真实样本回放#2', second.tasks);
      expect(e.addAnn.count).toBe(totalCfis);

      // 并排对照（同 browser 道、同 QUERY、同 contains 配置的合成书）。
      console.warn('[search-perf] ---- browser 道对照：合成书 vs 真实样本 ----');
      console.warn(`[search-perf]   命中总数: ${syntheticMemo.hits} vs ${totalCfis}`);
      console.warn(
        `[search-perf]   回放#1 总耗时: ${fmt(syntheticMemo.replay1Ms)} vs ${fmt(first.total)} ms`,
      );
      console.warn(
        `[search-perf]   回放#1 longtask 块/最长: ${syntheticMemo.longtasks1} 个 / ${fmt(syntheticMemo.longtasks1MaxMs)}ms vs ${first.tasks.length} 个 / ${fmt(first.tasks.reduce((m, t) => Math.max(m, t.duration), 0))}ms`,
      );
      console.warn(
        `[search-perf]   回放#2 总耗时: ${fmt(syntheticMemo.replay2Ms)} vs ${fmt(second.total)} ms`,
      );
      console.warn(
        `[search-perf]   回放#2 longtask 块/最长: ${syntheticMemo.longtasks2} 个 / ${fmt(syntheticMemo.longtasks2MaxMs)}ms vs ${second.tasks.length} 个 / ${fmt(second.tasks.reduce((m, t) => Math.max(m, t.duration), 0))}ms`,
      );
      console.warn(
        `[search-perf]   饥饿延迟#1: ${fmt(syntheticMemo.starvation1Ms)} vs ${fmt(first.starvationDelay)} ms`,
      );

      // 收尾：清注解 + 还原补丁。
      view.clearSearch();
      for (const restore of restoreFns) restore();
      po.disconnect();
    } finally {
      try {
        view.close();
      } catch {
        /* 忽略 teardown 异常 */
      }
      container.remove();
    }
  }, 300_000);
});
