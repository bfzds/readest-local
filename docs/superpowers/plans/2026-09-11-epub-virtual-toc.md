# EPUB 虚拟目录（正文生成目录）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让"目录元数据缺失或退化（只有封面/正文级条目）、但正文里有章节文本行"的 EPUB，能通过正则预选 + 命中预览的引导弹窗生成一份虚拟目录，存进书籍 config（不重写 EPUB 文件），侧栏目录/点击跳转立即可用，重开书不丢失。

**Architecture:** 三层：① 共享章节正则引擎（从 `utils/txt.ts` 抽出，TXT 转换与 EPUB 扫描共用）；② 扫描/合成服务（`services/virtualToc/`，spine section 块元素匹配章节规则 → 元素 CFI，或按 section 边界自动合成）；③ 阅读端接线（config.virtualToc 在 readerStore 打开路径合并进 `bookDoc.toc`，侧栏 TOC 空态提供生成入口 + VirtualTocDialog 弹窗——目录退化但非空时 `TOCView` 照常渲染、生成入口另挂，见 Task 6.5）。虚拟目录是**用户数据**，持久化在 `Books/{hash}/config.json`（与 progress/booknotes 同层），**不写入 nav.json**——nav.json 是随 `BOOK_NAV_VERSION` 整体失效重建的缓存，不能承载用户数据。

**Tech Stack:** TypeScript / React (reader components) / foliate-js（只读使用其 `CFI.fromElements`/`joinIndir`，**不修改子模块**）/ zustand（bookDataStore）/ vitest（jsdom）。

**Spec:** 无独立 spec 文档；本计划自带背景与已核实事实（见文末附录），来源为 2026-09-10/11 会话中的样本 EPUB 分析与外部评审结论。

## Global Constraints

- **不修改 `packages/foliate-js` 子模块**（所有新代码在 `apps/readest-app` 内）。
- **不 bump `BOOK_NAV_VERSION`**，不在 `computeBookNav` 内合并虚拟条目（缓存失效会冲掉用户数据）；合并只发生在 readerStore 打开路径（每次打开从 config 现读）。
- 每个 commit 必须过：`npx tsgo --noEmit` 0 错、`npx biome check` 干净、相关 vitest 用例全过（全量门禁在 Task 8）。
- 新 UI 文案走 i18n（`public/locales/{en,zh-CN,zh-TW}/translation.json` 三份同步加 key）。
- fixed-layout（`bookDoc.rendition?.layout === 'pre-paginated'`）书籍跳过整个功能，与 nav 管线的门禁一致。
- **退化目录判据唯一化（Task 6.5 起）**：「目录是否退化」只由 `isTocDegraded(bookDoc)` 一处判定——存在巨型内容 section（slab，`size >= 128KB`）且指向它的不同 TOC 锚点 ≤ 1。apply 门禁、侧栏入口、弹窗合成入口三处共用，不得改用「条目数 ≤ N」这类魔法数字（放宽阈值只会被下一个带 5 条结构条目的下载器 EPUB 击穿）。判据向宽松侧偏：误判「退化」只多一个入口（apply 语义是真实条目保留 + 虚拟条目追加，用户不点无副作用），误判「健康」则功能对这本书彻底不可用。
- 格式门禁：侧栏入口与弹窗挂载两处限 `book.format === 'EPUB'`，与 `store/readerStore.ts:254` 的 nav 门禁口径一致（MOBI/FB2/CBZ 也产出 `sections` 且不设 `rendition`，不能只靠 layout 判定）。
- 测试命令统一：`npx dotenv -e .env -e .env.test.local -- npx vitest run <paths>`（工作目录 `apps/readest-app`）。
- 提交信息用中文 conventional commits（仓库惯例）。

---

### Task 1: 抽取共享章节正则引擎 `utils/chapterRules.ts`

**Files:**
- Create: `apps/readest-app/src/utils/chapterRules.ts`
- Modify: `apps/readest-app/src/utils/txt.ts`（删除被移动的声明，改为 import；两处 `this.createChapterRegexps(...)` 调用点改为模块函数）
- Test: `apps/readest-app/src/__tests__/utils/chapter-rules.test.ts`

**Interfaces:**
- Produces（后续任务依赖的精确签名）:

```ts
export interface ChapterRule {
  source: string;
  flags: string;
}
export const CHAPTER_RULES: Record<string, ChapterRule[]>;
/** 与 TxtToEpubConverter.createChapterRegexps 行为一致：用户规则置前、
 *  非法/ReDoS 规则安全忽略、LRU 缓存已验证的规则源。 */
export function buildChapterRegexps(language: string, extraPatterns?: string[]): RegExp[];
/** 单行文本版匹配：把 split 导向的 `(?:^|\n)` 前缀换成行首 `^`，去掉 g 标志，
 *  对 trim 后的整段元素文本执行；命中返回捕获的标题（m[1] ?? m[0]），未命中返回 null。 */
export function matchChapterTitle(text: string, regexps: RegExp[]): string | null;
export function validateChapterPattern(pattern: string): string[];
export function buildChapterPatternFromSamples(samples: string[]): string | null;
export const CHAPTER_CANDIDATE_TITLE_RX: RegExp;
```

- [ ] **Step 1: 写失败测试**

```ts
// apps/readest-app/src/__tests__/utils/chapter-rules.test.ts
import { describe, expect, it } from 'vitest';
import {
  CHAPTER_CANDIDATE_TITLE_RX,
  buildChapterRegexps,
  matchChapterTitle,
  validateChapterPattern,
} from '@/utils/chapterRules';

describe('chapterRules 共享引擎', () => {
  it('内置 zh 规则可整行匹配“第X章”样式标题', () => {
    const regexps = buildChapterRegexps('zh');
    expect(matchChapterTitle('第12章 大战之前', regexps)).toBeTruthy();
    expect(matchChapterTitle('这是普通正文段落', regexps)).toBeNull();
  });

  it('用户规则优先于内置规则', () => {
    const regexps = buildChapterRegexps('zh', ['【[一二三四五六七八九十]+】[^\\n]{0,20}']);
    expect(matchChapterTitle('【一】开端', regexps)).toBe('【一】开端');
  });

  it('ReDoS 病态正则被安全忽略', () => {
    expect(validateChapterPattern('(a+)+b').length).toBeGreaterThan(0);
    const regexps = buildChapterRegexps('zh', ['(a+)+b']);
    expect(() => matchChapterTitle('第1章', regexps)).not.toThrow();
  });

  it('候选行正则仍以标题引导字开头判定', () => {
    expect(CHAPTER_CANDIDATE_TITLE_RX.test('【一】开端')).toBe(true);
    expect(CHAPTER_CANDIDATE_TITLE_RX.test('本章说：感谢打赏')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx dotenv -e .env -e .env.test.local -- npx vitest run src/__tests__/utils/chapter-rules.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 移动代码并创建模块**

从 `utils/txt.ts` **移动**（剪切，保持内容不变）以下声明到 `utils/chapterRules.ts`，并加 export：
`ChapterRule` 类型、`ZH_NUMBER`/`ZH_CHAPTER_UNIT`/`ZH_VOLUME_UNIT` 常量、`CHAPTER_RULES`（约 L41）、`CHAPTER_CANDIDATE_TITLE_RX`（约 L112）、`isNumChar`/`escapeRegExp`/`NUM_WILDCARD`、`buildChapterPatternFromSamples`（约 L121）、`validateChapterPattern`（约 L228）。

`createChapterRegexps`（约 L1057 的私有方法）改写为模块函数，静态缓存改为模块级：

```ts
// utils/chapterRules.ts（节选——createChapterRegexps 的搬运版）
const CHAPTER_REGEXP_CACHE_MAX = 32;
const chapterRegexpCache = new Map<string, Array<{ source: string; flags: string }>>();

export const buildChapterRegexps = (
  language: string,
  extraPatterns?: string[],
): RegExp[] => {
  const cacheKey = `${language}${extraPatterns?.join('') ?? ''}`;
  const cached = chapterRegexpCache.get(cacheKey);
  if (cached) {
    chapterRegexpCache.delete(cacheKey);
    chapterRegexpCache.set(cacheKey, cached);
    return cached.map(({ source, flags }) => new RegExp(source, flags));
  }
  // ……以下与原 createChapterRegexps 方法体一致（specs 构建 + 写缓存）……
};

export const matchChapterTitle = (text: string, regexps: RegExp[]): string | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  for (const rx of regexps) {
    const lineRx = new RegExp(rx.source.replace('(?:^|\\n)', '^'), rx.flags.replace('g', ''));
    const m = lineRx.exec(trimmed);
    if (m) return (m[1] ?? m[0]).trim();
  }
  return null;
};
```

`utils/txt.ts` 改为 `import { CHAPTER_CANDIDATE_TITLE_RX, buildChapterRegexps, ... } from './chapterRules'`，类内 `this.createChapterRegexps(...)` 两处调用点（extractChaptersFromSegment / extractChaptersFromSegmentBySegments，约 L903/L984）改为 `buildChapterRegexps(...)`；删除静态缓存字段。

- [ ] **Step 4: 运行新旧测试确认通过**

Run: `npx dotenv -e .env -e .env.test.local -- npx vitest run src/__tests__/utils/chapter-rules.test.ts src/__tests__/utils/txt-converter.test.ts src/__tests__/utils/txt-extension.test.ts`
Expected: 全 PASS（txt 既有用例证明抽取无行为回归）

- [ ] **Step 5: tsgo + biome 后提交**

```bash
npx tsgo --noEmit && npx biome check --write src/utils/chapterRules.ts src/utils/txt.ts src/__tests__/utils/chapter-rules.test.ts
git add apps/readest-app/src/utils/chapterRules.ts apps/readest-app/src/utils/txt.ts apps/readest-app/src/__tests__/utils/chapter-rules.test.ts
git commit -m "refactor: 抽取章节正则引擎到共享模块 chapterRules（TXT/EPUB 共用）"
```

---

### Task 2: 抽取元素 CFI 工具 `services/nav/elementCfi.ts`

**Files:**
- Create: `apps/readest-app/src/services/nav/elementCfi.ts`
- Modify: `apps/readest-app/src/services/nav/fragments.ts`（删除搬走的两个函数，改为 import 并保留原调用点）
- Test: `apps/readest-app/src/__tests__/services/nav/element-cfi.test.ts`

**Interfaces:**
- Consumes: `CFI`（`@/libs/document`）
- Produces:

```ts
/** element 必须是 <body> 的严格后代（见 fragments.ts 原注释：foliate fromElements
 *  的终止检查在 body/html 上会越界崩溃）。不满足时返回 null。 */
export function isCfiAddressable(element: Element): boolean;
/** 元素相对 section 的 CFI：CFI.fromElements + joinIndir；不可寻址或异常时
 *  回退 sectionCfi（整个 section 级锚点）。 */
export function buildElementCfi(sectionCfi: string, element: Element): string;
```

- [ ] **Step 1: 写失败测试**

```ts
// apps/readest-app/src/__tests__/services/nav/element-cfi.test.ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildElementCfi, isCfiAddressable } from '@/services/nav/elementCfi';

const SECTION_CFI = 'epubcfi(/6/4!)';

describe('elementCfi', () => {
  it('body 的严格后代可寻址，元素 CFI 以 section CFI 为前缀', () => {
    const doc = new DOMParser().parseFromString(
      '<html><body><p id="a">第一章</p></body></html>',
      'text/html',
    );
    const p = doc.getElementById('a')!;
    expect(isCfiAddressable(p)).toBe(true);
    const cfi = buildElementCfi(SECTION_CFI, p);
    expect(cfi.startsWith(SECTION_CFI)).toBe(true);
  });

  it('body 本身与脱离 body 的元素回退 section CFI', () => {
    const doc = new DOMParser().parseFromString(
      '<html><body><p>x</p></body></html>',
      'text/html',
    );
    expect(isCfiAddressable(doc.body!)).toBe(false);
    expect(buildElementCfi(SECTION_CFI, doc.body!)).toBe(SECTION_CFI);
    const detached = doc.createElement('p');
    expect(isCfiAddressable(detached)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx dotenv -e .env -e .env.test.local -- npx vitest run src/__tests__/services/nav/element-cfi.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 移动实现**

把 `fragments.ts` 中的 `isCfiAddressable`、`buildFragmentCfi`（改名为 `buildElementCfi`，签名从 `(section: SectionItem, element)` 改为 `(sectionCfi: string, element)`，调用点 `buildFragmentCfi(section, element)` 改为 `buildElementCfi(section.cfi, element)`）及其注释整体搬到 `services/nav/elementCfi.ts` 并 export。`fragments.ts` import 之。

- [ ] **Step 4: 运行测试确认通过（含 nav 既有用例）**

Run: `npx dotenv -e .env -e .env.test.local -- npx vitest run src/__tests__/services/nav/element-cfi.test.ts && npx dotenv -e .env -e .env.test.local -- npx vitest run src/__tests__ -t nav`
Expected: PASS

- [ ] **Step 5: tsgo + biome 后提交**

```bash
npx tsgo --noEmit && npx biome check --write src/services/nav/elementCfi.ts src/services/nav/fragments.ts src/__tests__/services/nav/element-cfi.test.ts
git add apps/readest-app/src/services/nav/elementCfi.ts apps/readest-app/src/services/nav/fragments.ts apps/readest-app/src/__tests__/services/nav/element-cfi.test.ts
git commit -m "refactor: 抽取元素 CFI 工具到 nav/elementCfi（虚拟目录扫描复用）"
```

---

### Task 3: VirtualTocEntry 类型 + config 字段 + apply 纯函数

**Files:**
- Modify: `apps/readest-app/src/types/book.ts`（BookConfig 约 L578 处加字段 + 新类型）
- Create: `apps/readest-app/src/services/virtualToc/apply.ts`
- Test: `apps/readest-app/src/__tests__/services/virtual-toc-apply.test.ts`

**Interfaces:**
- Produces:

```ts
// types/book.ts
export interface VirtualTocEntry {
  label: string;
  /** epubcfi(...) 字符串；侧栏 goTo 原生支持 CFI 目标（view.js resolveNavigation）。 */
  cfi: string;
  source: 'pattern' | 'section';
  generatedAt: number;
}
// BookConfig 增加：
//   /** 用户生成的虚拟目录（EPUB 目录元数据缺失/退化时）。用户数据，存 config.json
//    *    而非 nav.json（后者随 BOOK_NAV_VERSION 重建）。 */
//   virtualToc?: VirtualTocEntry[];

// services/virtualToc/apply.ts
export function virtualTocToItems(entries: VirtualTocEntry[]): TOCItem[];
/** toc 为空或退化（≤1 条）且非 fixed-layout 时，把虚拟条目并入 bookDoc.toc，
 *  返回是否应用。必须赋**新数组**引用（bookDoc.toc = [...existing, ...items]），
 *  否则 TOCView 的 memo 比较看不到变化。 */
export function applyVirtualToc(bookDoc: BookDoc, entries: VirtualTocEntry[] | undefined): boolean;
```

- [ ] **Step 1: 写失败测试**

```ts
// apps/readest-app/src/__tests__/services/virtual-toc-apply.test.ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyVirtualToc, virtualTocToItems } from '@/services/virtualToc/apply';
import type { VirtualTocEntry } from '@/types/book';
import type { BookDoc } from '@/libs/document';

const entries: VirtualTocEntry[] = [
  { label: '第1章', cfi: 'epubcfi(/6/4!/4/2)', source: 'pattern', generatedAt: 1 },
  { label: '第2章', cfi: 'epubcfi(/6/4!/4/8)', source: 'pattern', generatedAt: 1 },
];

const makeDoc = (toc: BookDoc['toc']): BookDoc =>
  ({ toc, sections: [], rendition: {} }) as unknown as BookDoc;

describe('applyVirtualToc', () => {
  it('空目录时并入并产生新数组引用', () => {
    const doc = makeDoc([]);
    expect(applyVirtualToc(doc, entries)).toBe(true);
    expect(doc.toc).toHaveLength(2);
    expect(doc.toc![0]!.label).toBe('第1章');
    expect(doc.toc![0]!.href).toBe('epubcfi(/6/4!/4/2)');
  });

  it('退化目录（1 条）时追加而非替换', () => {
    const existing = { id: 1, label: '正文', href: 'a.html', index: 0, subitems: [] };
    const doc = makeDoc([existing]);
    expect(applyVirtualToc(doc, entries)).toBe(true);
    expect(doc.toc).toHaveLength(3);
    expect(doc.toc![0]).toBe(existing);
  });

  it('健康目录（>1 条真实条目）、空条目、fixed-layout 均不应用', () => {
    const healthy = makeDoc([
      { id: 1, label: 'a', href: 'a', index: 0, subitems: [] },
      { id: 2, label: 'b', href: 'b', index: 0, subitems: [] },
    ]);
    expect(applyVirtualToc(healthy, entries)).toBe(false);
    expect(applyVirtualToc(makeDoc([]), [])).toBe(false);
    expect(applyVirtualToc(makeDoc([]), undefined)).toBe(false);
    const fixed = makeDoc([]);
    (fixed as { rendition?: { layout?: string } }).rendition = { layout: 'pre-paginated' };
    expect(applyVirtualToc(fixed, entries)).toBe(false);
  });

  it('重新生成：既有虚拟条目（负 id）被剥离替换而非叠加（R2）', () => {
    const virtualized = makeDoc([
      { id: 1, label: '正文', href: 'a.html', index: 0, subitems: [] },
      { id: -1, label: '旧第1章', href: 'epubcfi(/6/4!/4/2)', index: 0, subitems: [] },
      { id: -2, label: '旧第2章', href: 'epubcfi(/6/4!/4/8)', index: 0, subitems: [] },
    ]);
    expect(applyVirtualToc(virtualized, entries)).toBe(true);
    expect(virtualized.toc).toHaveLength(3); // 1 真实 + 2 新虚拟
    expect(virtualized.toc!.filter((t) => t.id < 0).map((t) => t.label)).toEqual([
      '第1章',
      '第2章',
    ]);
  });

  it('virtualTocToItems 生成负数 id 与空 subitems', () => {
    const items = virtualTocToItems(entries);
    expect(items[0]!.id).toBeLessThan(0);
    expect(items[0]!.subitems).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx dotenv -e .env -e .env.test.local -- npx vitest run src/__tests__/services/virtual-toc-apply.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// apps/readest-app/src/services/virtualToc/apply.ts
import type { BookDoc, TOCItem } from '@/libs/document';
import type { VirtualTocEntry } from '@/types/book';

export const virtualTocToItems = (entries: VirtualTocEntry[]): TOCItem[] =>
  entries.map((entry, i) => ({
    id: -1 - i, // 负数 id 区分虚拟条目，避免与真实 TOC id 冲突
    label: entry.label,
    href: entry.cfi, // goTo 原生支持 CFI 目标（view.js resolveNavigation 先测 CFI.isCFI）
    index: 0,
    subitems: [],
  }));

export const applyVirtualToc = (
  bookDoc: BookDoc,
  entries: VirtualTocEntry[] | undefined,
): boolean => {
  if (!entries?.length) return false;
  if (bookDoc.rendition?.layout === 'pre-paginated') return false;
  // 先剥离既有虚拟条目（负 id）再判健康目录——否则"重新生成"会被
  // healthy 守卫拒绝、无法替换（R2）。真实 TOC id 均为非负。
  const real = (bookDoc.toc ?? []).filter((item) => item.id >= 0);
  if (real.length > 1) return false; // 健康目录不动
  bookDoc.toc = [...real, ...virtualTocToItems(entries)];
  return true;
};
```

types/book.ts：在 `BookConfig` 里 `searchConfig` 字段之后加 `virtualToc?: VirtualTocEntry[];`（带上面接口块里的注释），文件内新增 `VirtualTocEntry` interface 并 export。

> **后续修正（Task 6.5）**：上面代码块里的 `if (real.length > 1) return false; // 健康目录不动` 已改为 `if (real.length > 1 && !isTocDegraded(bookDoc)) return false;`——「健康」不能只看条目数（样本书 NCX 有 3 条结构条目，`3 > 1` 会让功能永远不可达）。R2 的「先剥离负 id 再判」顺序与追加语义均不变。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx dotenv -e .env -e .env.test.local -- npx vitest run src/__tests__/services/virtual-toc-apply.test.ts`
Expected: PASS

- [ ] **Step 5: tsgo + biome 后提交**

```bash
npx tsgo --noEmit && npx biome check --write src/types/book.ts src/services/virtualToc/apply.ts src/__tests__/services/virtual-toc-apply.test.ts
git add apps/readest-app/src/types/book.ts apps/readest-app/src/services/virtualToc/apply.ts apps/readest-app/src/__tests__/services/virtual-toc-apply.test.ts
git commit -m "feat: 虚拟目录条目类型与 config 持久化字段（apply 纯函数）"
```

---

### Task 4: 扫描器 `services/virtualToc/scan.ts`

**Files:**
- Create: `apps/readest-app/src/services/virtualToc/scan.ts`
- Test: `apps/readest-app/src/__tests__/services/virtual-toc-scan.test.ts`

**Interfaces:**
- Consumes: `buildChapterRegexps`/`matchChapterTitle`（Task 1）、`buildElementCfi`（Task 2）、`runWithConcurrency`（`@/utils/concurrency`，nav 管线同款）、`SectionItem`/`BookDoc`（`@/libs/document`）
- Produces:

```ts
export interface ScanProgress {
  done: number;
  total: number;
}
/** countOnly 模式：只统计命中数（预览用，不做 DOM CFI 计算）。 */
export async function countChapterMatches(
  bookDoc: BookDoc,
  pattern: string,
  language?: string,
  onProgress?: (p: ScanProgress) => void,
): Promise<number>;
/** 完整模式：逐 section 解析 DOM，块元素文本命中章节规则 → 生成 VirtualTocEntry。 */
export async function generateVirtualTocEntries(
  bookDoc: BookDoc,
  pattern: string,
  language?: string,
  onProgress?: (p: ScanProgress) => void,
): Promise<VirtualTocEntry[]>;
```

- [ ] **Step 1: 写失败测试**

```ts
// apps/readest-app/src/__tests__/services/virtual-toc-scan.test.ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { countChapterMatches, generateVirtualTocEntries } from '@/services/virtualToc/scan';
import type { BookDoc, SectionItem } from '@/libs/document';

const html = (title: string) =>
  `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>` +
  `<p>开场白</p><p>${title}</p><p>正文内容。</p></body></html>`;

const makeSection = (id: string, body: string, cfi: string): SectionItem =>
  ({
    id,
    cfi,
    size: body.length,
    linear: 'yes',
    loadText: async () => body,
    createDocument: async () =>
      new DOMParser().parseFromString(body, 'application/xhtml+xml'),
  }) as unknown as SectionItem;

const makeDoc = (): BookDoc =>
  ({
    rendition: {},
    sections: [
      makeSection('s1', html('第一章 开端'), 'epubcfi(/6/4)'),
      makeSection('s2', html('第二章 发展'), 'epubcfi(/6/8)'),
      makeSection('s3', html('只是普通段落'), 'epubcfi(/6/12)'),
    ],
  }) as unknown as BookDoc;

describe('virtualToc scan', () => {
  it('countChapterMatches 统计命中数（自定义规则叠加内置规则）', async () => {
    expect(await countChapterMatches(makeDoc(), '')).toBe(2);
    // 叠加语义：自定义规则不命中时仍回落内置规则的 2 处
    expect(await countChapterMatches(makeDoc(), '【[一二三]+】[^\\n]{0,20}')).toBe(2);
    // 自定义规则自身命中 3 处“开场白”，叠加内置 2 处 = 5
    expect(await countChapterMatches(makeDoc(), '开场白')).toBe(5);
  });

  it('generateVirtualTocEntries 产出带 label 与元素级 CFI 的条目', async () => {
    const entries = await generateVirtualTocEntries(makeDoc(), '');
    expect(entries.map((e) => e.label)).toEqual(['第一章 开端', '第二章 发展']);
    // 元素 CFI 在 section 锚点上追加间接符（真实 section CFI 形如 epubcfi(/6/N)）
    expect(entries[0]!.cfi.startsWith('epubcfi(/6/4!')).toBe(true);
    expect(entries[0]!.cfi).not.toBe('epubcfi(/6/4)');
    expect(entries[0]!.source).toBe('pattern');
    expect(entries[0]!.generatedAt).toBeGreaterThan(0);
  });

  it('onProgress 汇报进度且 done 最终等于 total', async () => {
    const seen: ScanProgress[] = [];
    await countChapterMatches(makeDoc(), '', undefined, (p) => seen.push({ ...p }));
    expect(seen.at(-1)!.done).toBe(seen.at(-1)!.total);
  });
});
```

（`ScanProgress` 从被测模块 import。）

- [ ] **Step 2: 运行确认失败**

Run: `npx dotenv -e .env -e .env.test.local -- npx vitest run src/__tests__/services/virtual-toc-scan.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// apps/readest-app/src/services/virtualToc/scan.ts
import type { BookDoc } from '@/libs/document';
import type { VirtualTocEntry } from '@/types/book';
import { buildElementCfi } from '@/services/nav/elementCfi';
import { runWithConcurrency } from '@/utils/concurrency';
import { buildChapterRegexps, matchChapterTitle } from '@/utils/chapterRules';

export interface ScanProgress {
  done: number;
  total: number;
}

const SCAN_CONCURRENCY = 64; // 与 nav enrichment 同量级：spine 读取有界并发
const BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,div';
const MAX_LABEL_LEN = 60;

const normalizeLabel = (s: string): string =>
  s.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LEN);

const collectMatches = async (
  bookDoc: BookDoc,
  pattern: string,
  language: string | undefined,
  countOnly: boolean,
  onProgress?: (p: ScanProgress) => void,
): Promise<{ count: number; entries: VirtualTocEntry[] }> => {
  const sections = (bookDoc.sections ?? []).filter((s) => s.linear !== 'no');
  const regexps = buildChapterRegexps(language ?? 'zh', pattern ? [pattern] : []);
  let done = 0;
  const total = sections.length;
  const now = Date.now();
  const outcomes = await runWithConcurrency(sections, SCAN_CONCURRENCY, async (section) => {
    try {
      const doc = await section.createDocument();
      const elements = Array.from(doc.querySelectorAll(BLOCK_SELECTOR));
      // div 只在“纯文本 div（无块级子元素）”时才算候选行，避免容器节点误命中
      const candidates = elements.filter(
        (el) =>
          !/^div$/i.test(el.tagName) ||
          !el.querySelector('p,div,h1,h2,h3,h4,h5,h6,table,img'),
      );
      const local: VirtualTocEntry[] = [];
      for (const el of candidates) {
        const label = matchChapterTitle(el.textContent ?? '', regexps);
        if (!label) continue;
        if (countOnly) {
          local.push({ label: '', cfi: '', source: 'pattern', generatedAt: now });
        } else {
          local.push({
            label: normalizeLabel(label),
            cfi: buildElementCfi(section.cfi, el),
            source: 'pattern',
            generatedAt: now,
          });
        }
      }
      return local;
    } catch (e) {
      console.warn(`virtualToc scan: section ${section.id} failed:`, e);
      return [] as VirtualTocEntry[];
    } finally {
      done += 1;
      onProgress?.({ done, total });
    }
  });
  const entries = outcomes.flatMap((o) => ('result' in o ? o.result : []));
  return { count: entries.length, entries };
};

export const countChapterMatches = (
  bookDoc: BookDoc,
  pattern: string,
  language?: string,
  onProgress?: (p: ScanProgress) => void,
) =>
  collectMatches(bookDoc, pattern, language, true, onProgress).then((r) => r.count);

export const generateVirtualTocEntries = (
  bookDoc: BookDoc,
  pattern: string,
  language?: string,
  onProgress?: (p: ScanProgress) => void,
) =>
  collectMatches(bookDoc, pattern, language, false, onProgress).then((r) => r.entries);
```

注：`runWithConcurrency` 的返回形状以 `utils/concurrency.ts` 实际为准（nav/index.ts L170 起的用法是 `{error, item, result}` 结构）；若签名不同，按 nav 管线的同款用法适配，测试不变。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx dotenv -e .env -e .env.test.local -- npx vitest run src/__tests__/services/virtual-toc-scan.test.ts`
Expected: PASS

- [ ] **Step 5: tsgo + biome 后提交**

```bash
npx tsgo --noEmit && npx biome check --write src/services/virtualToc/scan.ts src/__tests__/services/virtual-toc-scan.test.ts
git add apps/readest-app/src/services/virtualToc/scan.ts apps/readest-app/src/__tests__/services/virtual-toc-scan.test.ts
git commit -m "feat: EPUB 章节行扫描器（块元素匹配 + 元素 CFI + 命中计数）"
```

---

### Task 5: section 级自动合成 `services/virtualToc/synthesis.ts`

**Files:**
- Create: `apps/readest-app/src/services/virtualToc/synthesis.ts`
- Test: `apps/readest-app/src/__tests__/services/virtual-toc-synthesis.test.ts`

**Interfaces:**
- Consumes: `buildElementCfi`（Task 2）、`SectionItem`/`BookDoc`
- Produces:

```ts
/** toc 空/退化（≤1 条）且 spine 有多个 section 时为 true——这种书（按章分了
 *  文件但没目录）不需要引导，直接按文件边界合成。 */
export function shouldOfferSynthesis(bookDoc: BookDoc): boolean;
/** 每个 spine section 一条：label 取首个 h1-h3 文本，无标题则取首个非空块元素
 *  文本（截断 40 字符），cfi 直接用 section.cfi（零 DOM 计算）。 */
export async function synthesizeSectionToc(bookDoc: BookDoc): Promise<VirtualTocEntry[]>;
```

- [ ] **Step 1: 写失败测试**

```ts
// apps/readest-app/src/__tests__/services/virtual-toc-synthesis.test.ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { shouldOfferSynthesis, synthesizeSectionToc } from '@/services/virtualToc/synthesis';
import type { BookDoc, SectionItem } from '@/libs/document';

const section = (id: string, body: string): SectionItem =>
  ({
    id,
    cfi: `epubcfi(/6/${id})`,
    size: body.length,
    linear: 'yes',
    loadText: async () => body,
    createDocument: async () =>
      new DOMParser().parseFromString(body, 'application/xhtml+xml'),
  }) as unknown as SectionItem;

const doc3 = (): BookDoc =>
  ({
    rendition: {},
    toc: [],
    sections: [
      section('4', '<html><body><h2>第一章</h2><p>a</p></body></html>'),
      section('8', '<html><body><p>第二章 无标题文件的首行</p><p>b</p></body></html>'),
      section('12', '<html><body><p>c</p></body></html>'),
    ],
  }) as unknown as BookDoc;

describe('synthesizeSectionToc', () => {
  it('toc 空且多 section 时建议合成', () => {
    expect(shouldOfferSynthesis(doc3())).toBe(true);
  });

  it('toc 健康或单 section 时不建议', () => {
    const healthy = { ...doc3(), toc: [{ id: 1 }, { id: 2 }] } as unknown as BookDoc;
    expect(shouldOfferSynthesis(healthy)).toBe(false);
    const single = { ...doc3(), sections: [section('4', 'x')] } as unknown as BookDoc;
    expect(shouldOfferSynthesis(single)).toBe(false);
  });

  it('label 取标题元素，缺省取首行并截断，cfi 用 section.cfi', async () => {
    const entries = await synthesizeSectionToc(doc3());
    expect(entries).toHaveLength(3);
    expect(entries[0]!.label).toBe('第一章');
    expect(entries[1]!.label.startsWith('第二章')).toBe(true);
    expect(entries[0]!.cfi).toBe('epubcfi(/6/4)');
    expect(entries.every((e) => e.source === 'section')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx dotenv -e .env -e .env.test.local -- npx vitest run src/__tests__/services/virtual-toc-synthesis.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// apps/readest-app/src/services/virtualToc/synthesis.ts
import type { BookDoc } from '@/libs/document';
import type { VirtualTocEntry } from '@/types/book';
import { runWithConcurrency } from '@/utils/concurrency';

const SYNTHESIS_CONCURRENCY = 64;
const MAX_LABEL_LEN = 40;

export const shouldOfferSynthesis = (bookDoc: BookDoc): boolean => {
  if (bookDoc.rendition?.layout === 'pre-paginated') return false;
  if ((bookDoc.toc?.length ?? 0) > 1) return false;
  return (bookDoc.sections ?? []).filter((s) => s.linear !== 'no').length > 1;
};

export const synthesizeSectionToc = async (bookDoc: BookDoc): Promise<VirtualTocEntry[]> => {
  const sections = (bookDoc.sections ?? []).filter((s) => s.linear !== 'no');
  const now = Date.now();
  const outcomes = await runWithConcurrency(sections, SYNTHESIS_CONCURRENCY, async (section) => {
    let label = '';
    try {
      const doc = await section.createDocument();
      const heading = doc.querySelector('h1,h2,h3');
      if (heading?.textContent?.trim()) {
        label = heading.textContent;
      } else {
        const firstBlock = Array.from(doc.querySelectorAll('p,div,h1,h2,h3,h4,h5,h6'))
          // div 只在“纯文本 div（无块级子元素）”时才算候选行（同 scan.ts:37-40），
          // 避免 <div class="wrap"> 容器被当成首块、把多段拼成一个标签。
          .filter(
            (el) =>
              !/^div$/i.test(el.tagName) ||
              !el.querySelector('p,div,h1,h2,h3,h4,h5,h6,table,img'),
          )
          .find((el) => el.textContent?.trim());
        label = firstBlock?.textContent ?? '';
      }
    } catch (e) {
      console.warn(`virtualToc synthesis: section ${section.id} failed:`, e);
    }
    return {
      label: label.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LEN) || section.id,
      cfi: section.cfi,
      source: 'section' as const,
      generatedAt: now,
    };
  });
  return outcomes.flatMap((o) => ('result' in o ? [o.result] : []));
};
```

（`runWithConcurrency` 返回形状同 Task 4 的注。）

> **执行后已应用的两处修正（R5/R6）**：① 夹具 section CFI 改用真实形态 `epubcfi(/6/N)`（foliate `fake.fromIndex = index => \`/6/${(index+1)*2}\``，无间接符），实现为透传 `section.cfi` 故行为不变；② 兜底块选择器按 R6 加了「纯文本 div 才算候选」过滤（同 `scan.ts:37-40`），并新增 wrapper-div 回归用例与 fixed-layout 门禁用例——实际测试文件共 5 例，见 `src/__tests__/services/virtual-toc-synthesis.test.ts`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx dotenv -e .env -e .env.test.local -- npx vitest run src/__tests__/services/virtual-toc-synthesis.test.ts`
Expected: PASS

- [ ] **Step 5: tsgo + biome 后提交**

```bash
npx tsgo --noEmit && npx biome check --write src/services/virtualToc/synthesis.ts src/__tests__/services/virtual-toc-synthesis.test.ts
git add apps/readest-app/src/services/virtualToc/synthesis.ts apps/readest-app/src/__tests__/services/virtual-toc-synthesis.test.ts
git commit -m "feat: section 级虚拟目录自动合成（退化目录、按文件分章）"
```

---

### Task 6: readerStore 打开时应用 + 侧栏空态入口

**Files:**
- Modify: `apps/readest-app/src/store/readerStore.ts`（initViewState 的 nav 块之后、`updateToc` 之前插入一行）
- Modify: `apps/readest-app/src/app/reader/components/sidebar/Content.tsx`（L85 起的 toc 分支加空态）
- Test: `apps/readest-app/src/__tests__/app/reader/virtual-toc-empty-state.test.tsx`

**Interfaces:**
- Consumes: `applyVirtualToc`（Task 3）、`shouldOfferSynthesis`（Task 5）、`BookData`（bookDataStore）

- [ ] **Step 1: 写失败测试（侧栏空态渲染）**

```tsx
// apps/readest-app/src/__tests__/app/reader/virtual-toc-empty-state.test.tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Content from '@/app/reader/components/sidebar/Content';

vi.mock('@/app/reader/components/sidebar/TOCView', () => ({ default: () => <div>toc-view' </div> }));
vi.mock('@/components/Dialog', () => ({ default: () => null }));
vi.mock('react-internationalization', () => ({ useTranslation: () => (s: string) => s }));

const makeProps = (toc: unknown[]) =>
  ({
    bookDoc: {
      toc,
      sections: [{ id: 's1' }],
      rendition: {},
      metadata: {},
    },
    sideBarBookKey: 'k1',
  }) as never;

describe('侧栏 TOC 空态', () => {
  it('toc 为空数组时显示“从正文生成目录”入口', () => {
    render(<Content {...makeProps([])} />);
    expect(screen.getByRole('button', { name: 'Generate TOC from content' })).toBeTruthy();
  });

  it('toc 有条目时不显示生成入口', () => {
    render(
      <Content
        {...makeProps([{ id: 1, label: 'a', href: 'h', index: 0, subitems: [] }])}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Generate TOC from content' })).toBeNull();
  });
});
```

（mock 路径/组件名以 Content.tsx 实际依赖为准——执行时先读文件头部的 import 再对齐；`useTranslation` 的 mock 需匹配 `@/hooks/useTranslation` 的真实导入路径。）

- [ ] **Step 2: 运行确认失败**

Run: `npx dotenv -e .env -e .env.test.local -- npx vitest run src/__tests__/app/reader/virtual-toc-empty-state.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

readerStore.ts —— 在 nav 块结束后、`await updateToc(...)` 之前插入：

```ts
// 虚拟目录（EPUB 目录元数据缺失/退化时用户生成的）：用户数据存 config.json，
// 每次打开现读现并；必须在 updateToc 之前，让 simplecc 标签转换一并处理。
applyVirtualToc(bookDoc, config.virtualToc);
```

（顶部加 `import { applyVirtualToc } from '@/services/virtualToc/apply';`。）

Content.tsx —— L85 的分支改为：

```tsx
{activeTab === 'toc' &&
  (bookDoc.toc && bookDoc.toc.length > 0 ? (
    <TOCView toc={bookDoc.toc} bookKey={sideBarBookKey} />
  ) : (
    <VirtualTocEmptyState bookKey={sideBarBookKey} bookDoc={bookDoc} />
  ))}
```

新增本地组件（同文件底部，样式参考现有空态/`text-base-content/60` 用法）：

```tsx
const VirtualTocEmptyState = ({ bookKey, bookDoc }: { bookKey: string; bookDoc: BookDoc }) => {
  const _ = useTranslation();
  const [open, setOpen] = useState(false);
  const eligible =
    bookDoc.rendition?.layout !== 'pre-paginated' && (bookDoc.sections?.length ?? 0) > 0;
  if (!eligible) {
    return <div className='text-base-content/60 p-4 text-sm'>{_('No TOC')}</div>;
  }
  return (
    <div className='flex flex-col items-center gap-3 p-4'>
      <p className='text-base-content/60 text-sm'>{_('No table of contents in this book.')}</p>
      <button
        type='button'
        className='btn btn-contrast btn-sm'
        onClick={() => setOpen(true)}
      >
        {_('Generate TOC from content')}
      </button>
      {open && (
        <VirtualTocDialog bookKey={bookKey} bookDoc={bookDoc} onClose={() => setOpen(false)} />
      )}
    </div>
  );
};
```

（`VirtualTocDialog` 先以占位 import 引入——本任务提交前在 `reader/components/VirtualTocDialog.tsx` 建最小骨架 `{ props } => null`，Task 7 完整实现；Content.tsx 头部补 `useState` import 与 `VirtualTocDialog` import。）

> **执行后修正（Task 6.5）**：本任务的两处判定已被扩展——① 入口条件从「toc 为空」扩展为「toc 为空 **或** `isTocDegraded(bookDoc)`」；② 退化但非空时不再整块替换成空态，而是 `TOCView` 照常渲染结构条目 + 生成入口另挂（页头/固定底栏）。样本书 toc 有 3 条结构条目，原条件会让生成入口根本不出现（Task 8 步骤 1 必失败）。另补 `book.format === 'EPUB'` 格式门禁。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx dotenv -e .env -e .env.test.local -- npx vitest run src/__tests__/app/reader/virtual-toc-empty-state.test.tsx`
Expected: PASS

- [ ] **Step 5: tsgo + biome 后提交**

```bash
npx tsgo --noEmit && npx biome check --write src/store/readerStore.ts src/app/reader/components/sidebar/Content.tsx src/app/reader/components/VirtualTocDialog.tsx src/__tests__/app/reader/virtual-toc-empty-state.test.tsx
git add apps/readest-app/src/store/readerStore.ts apps/readest-app/src/app/reader/components/sidebar/Content.tsx apps/readest-app/src/app/reader/components/VirtualTocDialog.tsx apps/readest-app/src/__tests__/app/reader/virtual-toc-empty-state.test.tsx
git commit -m "feat: 阅读器打开时应用虚拟目录 + 侧栏目录空态生成入口"
```

---

### Task 6.5: 退化目录判据修正（slab 判据 + 入口条件 + 退化非空态 UI）

**背景（2026-09-11 解包实测，证据链）**：Task 3 的 `if (real.length > 1) return false`（「健康目录不动」）与 Task 6 的 `toc.length > 0 → 渲染 TOCView` 组合起来，会让本功能的首要目标书类完全不可达：

NCX 3 条 navPoint（信息/目录/全文）无锚点 → nav 富化门槛是 `sections.length > 64`（`services/nav/enrichment.ts:104`），样本书只有 4 个 spine section，**富化不触发** → `hydrateBookNav` 直接 `bookDoc.toc = cloneTocItems(bookNav.toc)`（`services/nav/index.ts:235`）→ 打开后 `bookDoc.toc` **恒为 3 条**。后果有两层，且失败发生在更早的一层：

1. `sidebar/Content.tsx` 的入口条件是 `toc.length > 0` 就渲染 TOCView → 样本书侧栏显示那 3 条结构条目，**空态与「生成」按钮根本不出现**（Task 8 步骤 1 即失败）。
2. 即便入口出现，`applyVirtualToc` 也会因 `real.length = 3 > 1` **永远拒绝**——生成时用户看到成功 toast、目录纹丝不动（Task 8 步骤 3 静默失败）。

**判据（取代「条目数 ≤ 1」）**：存在一个巨型内容 section（slab，`size >= 128KB`，约 6 万字中文；常量化便于调整），且指向它的**不同 TOC 锚点 ≤ 1**。

- 「条目有没有指向正文内部的锚点」**不能**单独当判据：按文件分章的健康书同样没有锚点（每章一个文件，href 无 fragment）。锚点是「健康」的充分信号、不是必要信号。
- 样本实测：`page-0.html` 267KB（同级文件 0.4–1.4KB），只被 1 条无锚点条目指到 → 退化 ✓
- 健康分章书：每章 10–60KB，无 slab → 不退化 ✓
- 单文件 + 锚点目录的健康书：有 slab 但几十个锚点 → 不退化 ✓
- 误报代价不对称：多一个入口无副作用（apply 语义是真实条目保留 + 虚拟条目追加），判据应向宽松侧偏。

**Files:**
- Modify: `apps/readest-app/src/services/virtualToc/apply.ts`（新增 `isTocDegraded` + 门禁改造）
- Modify: `apps/readest-app/src/app/reader/components/sidebar/Content.tsx`（入口条件 + 退化非空态 UI + EPUB 格式守卫）
- Test: `apps/readest-app/src/__tests__/services/virtual-toc-apply.test.ts`、`apps/readest-app/src/__tests__/app/reader/virtual-toc-empty-state.test.tsx`

**Interfaces:**
- Produces:

```ts
// services/virtualToc/apply.ts
/** 退化目录判据：存在一个巨型内容 section（slab）且指向它的不同 TOC 锚点 ≤ 1。
 *  三个消费点共用：applyVirtualToc 门禁、侧栏入口条件、弹窗合成入口。 */
export function isTocDegraded(bookDoc: BookDoc): boolean;
```

**执行前必须核实的四点（写进实现者简报）**：
1. `SectionItem.size` 的单位是字节还是字符——决定 128KB 阈值的实际含义（若为字符需换算并在报告注明）。
2. `collectAllTocItems` / `splitTOCHref` 的确切签名与返回形态；「去重目标数」用哪一级键（归一化 href 还是解析出的 section index）。
3. `TOCView` 的高度计算依赖父容器 `.scroll-container`（`TOCView.tsx` 的 `updateHeight`）——退化态新增入口若放在 TOCView **之后**可能被推出可视区。位置需实测，优先页头或固定底栏。
4. `shouldOfferSynthesis`（Task 5）的 toc 判据应否同步为 `toc.length <= 1 || isTocDegraded(bookDoc)`：样本书 4 个 spine section（> 1）但 3 条目录，现状会让弹窗内「按文件分章」按钮不出现。建议同步，保持两处判据一致。

- [ ] **Step 1: 写失败测试**

```ts
// apps/readest-app/src/__tests__/services/virtual-toc-apply.test.ts（新增，既有用例不动）
it('3 条结构条目 + slab（大 section 只被 1 条指到）时应用虚拟目录', () => {
  const doc = makeDoc([
    { id: 1, label: '信息', href: 'page-0.html', index: 0, subitems: [] },
    { id: 2, label: '目录', href: 'page-0.html', index: 0, subitems: [] },
    { id: 3, label: '全文', href: 'page-0.html', index: 0, subitems: [] },
  ]);
  doc.sections = [{ id: 's1', size: 300 * 1024, linear: 'yes' } as never];
  expect(applyVirtualToc(doc, entries)).toBe(true);
  expect(doc.toc!.filter((t) => t.id < 0)).toHaveLength(2);
});

it('健康分章书（多章节 section、无 slab、多条目录）不应用', () => { /* → false */ });

it('有 slab 但被多条不同锚点指到（单文件 + 锚点目录）不应用', () => { /* → false */ });
```

既有 `healthy` 夹具（`sections: []`）天然兼容——无 slab 即不退化，无需改动。
侧栏测试新增三例：`toc 3 条 + slab → TOCView 与生成入口同时出现`、`toc 3 条 + 无 slab → 只有 TOCView、无入口`、`非 EPUB（如 MOBI）→ 无入口`。

- [ ] **Step 2: 运行确认失败**

Run: `npx dotenv -e .env -e .env.test.local -- npx vitest run src/__tests__/services/virtual-toc-apply.test.ts src/__tests__/app/reader/virtual-toc-empty-state.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

1. `apply.ts`：新增 `SLAB_SIZE_BYTES = 128 * 1024` 与 `isTocDegraded(bookDoc)`；门禁改为
   `if (real.length > 1 && !isTocDegraded(bookDoc)) return false;`（保留原 `real.length <= 1` 放行分支与 R2 顺序）。
2. `Content.tsx`：入口条件改为 `toc 为空 || isTocDegraded(bookDoc)`；**退化非空态不是空态**——TOCView 照常渲染那些结构条目，生成入口另挂在目录页头/固定底栏（沿用同一个 `VirtualTocDialog` 挂载与 open 状态）。
3. 格式守卫：入口与弹窗挂载两处限 `book.format === 'EPUB'`（format 从 `useBookDataStore` 的 `booksData` 取）。

- [ ] **Step 4: 运行测试确认通过**

- [ ] **Step 5: tsgo + biome 后提交**

```bash
npx tsgo --noEmit && npx biome check --write src/services/virtualToc/apply.ts src/app/reader/components/sidebar/Content.tsx src/__tests__/services/virtual-toc-apply.test.ts src/__tests__/app/reader/virtual-toc-empty-state.test.tsx
git add apps/readest-app/src/services/virtualToc/apply.ts apps/readest-app/src/app/reader/components/sidebar/Content.tsx apps/readest-app/src/__tests__/services/virtual-toc-apply.test.ts apps/readest-app/src/__tests__/app/reader/virtual-toc-empty-state.test.tsx
git commit -m "fix: 退化目录改用 slab 判据（3 条结构条目的单文件书可达生成入口）"
```

---

### Task 7: VirtualTocDialog 完整弹窗（正则预选 / 命中预览 / 持久化 / 刷新）

**Files:**
- Modify: `apps/readest-app/src/app/reader/components/VirtualTocDialog.tsx`（替换 Task 6 的骨架）
- Modify: `apps/readest-app/public/locales/en/translation.json`、`zh-CN/translation.json`、`zh-TW/translation.json`
- Test: `apps/readest-app/src/__tests__/app/reader/virtual-toc-dialog.test.tsx`

**Interfaces:**
- Consumes: `countChapterMatches`/`generateVirtualTocEntries`（Task 4）、`shouldOfferSynthesis`/`synthesizeSectionToc`（Task 5）、`applyVirtualToc`/`isTocDegraded`（Task 3 / Task 6.5）、`useBookDataStore.saveConfig`、`eventDispatcher.dispatch('toast')`
- Produces:

```ts
// VirtualTocDialog.tsx
type VirtualTocDialogProps = {
  bookKey: string;
  bookDoc: BookDoc;
  onClose: () => void;
};
```

- [ ] **Step 1: 写失败测试**

```tsx
// apps/readest-app/src/__tests__/app/reader/virtual-toc-dialog.test.tsx
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const scanMock = vi.hoisted(() => ({
  countChapterMatches: vi.fn().mockResolvedValue(15),
  generateVirtualTocEntries: vi
    .fn()
    .mockResolvedValue([
      { label: '第1章', cfi: 'epubcfi(/6/4!/4/2)', source: 'pattern', generatedAt: 1 },
    ]),
}));
// 两个模块各自独立 mock——原稿让 scan 与 synthesis 共用同一个对象，
// 会让「synthesis 没被调用」这类断言失去判别力。
const synthMock = vi.hoisted(() => ({
  synthesizeSectionToc: vi.fn().mockResolvedValue([
    { label: 's1', cfi: 'epubcfi(/6/4)', source: 'section', generatedAt: 1 },
  ]),
  shouldOfferSynthesis: vi.fn().mockReturnValue(false),
}));
const applyMock = vi.hoisted(() => ({
  applyVirtualToc: vi.fn(() => true),
  isTocDegraded: vi.fn(() => true),
}));

vi.mock('@/services/virtualToc/scan', () => scanMock);
vi.mock('@/services/virtualToc/synthesis', () => synthMock);
vi.mock('@/services/virtualToc/apply', () => applyMock);
// 仓库真实路径是 @/hooks/useTranslation（原稿写的 react-internationalization 不存在）
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (s: string) => s }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {} }) }));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) },
}));
vi.mock('@/components/Dialog', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div role='dialog'>{children}</div>,
}));

import VirtualTocDialog from '@/app/reader/components/VirtualTocDialog';
import { useBookDataStore } from '@/store/bookDataStore';
import type { BookDoc } from '@/libs/document';

const bookDoc = {
  rendition: {},
  toc: [],
  sections: [{ id: 's1' }],
  metadata: { language: 'zh' },
} as unknown as BookDoc;

describe('VirtualTocDialog', () => {
  it('挂载即对内置规则做命中预览', async () => {
    render(<VirtualTocDialog bookKey='k1' bookDoc={bookDoc} onClose={() => {}} />);
    await waitFor(() =>
      expect(scanMock.countChapterMatches).toHaveBeenCalledWith(bookDoc, '', 'zh'),
    );
    await waitFor(() =>
      expect(screen.getByText(/matches 15 locations/iu)).toBeTruthy(),
    );
  });

  it('确认生成：写入 config、应用并刷新 bookData', async () => {
    const setSpy = vi.spyOn(useBookDataStore, 'setState');
    const saveSpy = vi.spyOn(useBookDataStore.getState(), 'saveConfig').mockResolvedValue();
    render(<VirtualTocDialog bookKey='k1' bookDoc={bookDoc} onClose={() => {}} />);
    await waitFor(() => screen.getByRole('button', { name: /generate/iu }));
    fireEvent.click(screen.getByRole('button', { name: /generate/iu }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalled());
    await waitFor(() => expect(setSpy).toHaveBeenCalled());
    expect(scanMock.generateVirtualTocEntries).toHaveBeenCalled();
  });

  it('apply 被拒时：错误 toast、不写 config、不关弹窗（防死配置）', async () => {
    // 守卫拒绝（健康目录 / pre-paginated / 空条目）时，绝不能先持久化再 apply——
    // 那会留下一份永远不生效的死配置，而用户看到的是成功提示。
    applyMock.applyVirtualToc.mockReturnValueOnce(false);
    const saveSpy = vi.spyOn(useBookDataStore.getState(), 'saveConfig').mockResolvedValue();
    const onClose = vi.fn();
    render(<VirtualTocDialog bookKey='k1' bookDoc={bookDoc} onClose={onClose} />);
    await waitFor(() => screen.getByRole('button', { name: /generate/iu }));
    fireEvent.click(screen.getByRole('button', { name: /generate/iu }));
    await waitFor(() => expect(applyMock.applyVirtualToc).toHaveBeenCalled());
    expect(saveSpy).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
```

（`useTranslation`、toast 依赖按 Content.tsx 同款方式 mock；断言文案以实现为准对齐 i18n key。）

- [ ] **Step 2: 运行确认失败**

Run: `npx dotenv -e .env -e .env.test.local -- npx vitest run src/__tests__/app/reader/virtual-toc-dialog.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现组件**

```tsx
// apps/readest-app/src/app/reader/components/VirtualTocDialog.tsx（完整实现）
'use client';

import { useEffect, useMemo, useState } from 'react';
import Dialog from '@/components/Dialog';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { eventDispatcher } from '@/utils/event';
import { useBookDataStore } from '@/store/bookDataStore';
import { useSettingsStore } from '@/store/settingsStore';
import type { BookDoc } from '@/libs/document';
import type { VirtualTocEntry } from '@/types/book';
import { validateChapterPattern } from '@/utils/chapterRules';
import {
  countChapterMatches,
  generateVirtualTocEntries,
} from '@/services/virtualToc/scan';
import { shouldOfferSynthesis, synthesizeSectionToc } from '@/services/virtualToc/synthesis';
import { applyVirtualToc } from '@/services/virtualToc/apply';

type VirtualTocDialogProps = {
  bookKey: string;
  bookDoc: BookDoc;
  onClose: () => void;
};

const VirtualTocDialog = ({ bookKey, bookDoc, onClose }: VirtualTocDialogProps) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const language = bookDoc.metadata?.language || 'zh';
  const [pattern, setPattern] = useState('');
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const offerSynthesis = useMemo(() => shouldOfferSynthesis(bookDoc), [bookDoc]);
  const patternErrors = pattern ? validateChapterPattern(pattern) : [];

  useEffect(() => {
    if (patternErrors.length > 0) return;
    let cancelled = false;
    setScanning(true);
    const timer = setTimeout(async () => {
      try {
        const count = await countChapterMatches(bookDoc, pattern, language);
        if (!cancelled) setPreviewCount(count);
      } finally {
        if (!cancelled) setScanning(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pattern, bookDoc, language]);

  // 顺序必须是「先 apply、后 saveConfig」：apply 会被 isTocDegraded / pre-paginated /
  // 空条目三道守卫拒绝，若先持久化就会留下一份永远不生效的死配置。
  // 返回 false 时：错误 toast、不写 config、不关弹窗（调用方据此决定是否 onClose）。
  const persistAndApply = async (entries: VirtualTocEntry[]): Promise<boolean> => {
    if (!applyVirtualToc(bookDoc, entries)) {
      eventDispatcher.dispatch('toast', {
        message: _('Cannot apply virtual TOC to this book'),
        type: 'error',
        timeout: 4000,
      });
      return false;
    }
    const store = useBookDataStore.getState();
    const existing = store.getConfig(bookKey) ?? { updatedAt: 0 };
    const config = { ...existing, virtualToc: entries, updatedAt: Date.now() };
    await store.saveConfig(envConfig, bookKey, config, useSettingsStore.getState().settings);
    // 新 bookDoc 引用 + 新 toc 数组引用，触发 TOCView 重渲染
    useBookDataStore.setState((state) => ({
      booksData: {
        ...state.booksData,
        [bookKey]: { ...state.booksData[bookKey]!, bookDoc: { ...bookDoc } },
      },
    }));
    eventDispatcher.dispatch('toast', {
      message: _('TOC generated: {{count}} entries', { count: entries.length }),
      type: 'success',
      timeout: 2500,
    });
    return true;
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const entries = await generateVirtualTocEntries(bookDoc, pattern, language);
      if (entries.length === 0) {
        eventDispatcher.dispatch('toast', {
          message: _('No chapter-like lines matched. Try a custom pattern.'),
          type: 'error',
          timeout: 4000,
        });
        return;
      }
      if (await persistAndApply(entries)) onClose();
    } catch (e) {
      console.error('virtualToc generate failed:', e);
      eventDispatcher.dispatch('toast', { message: _('Failed to generate TOC'), type: 'error' });
    } finally {
      setGenerating(false);
    }
  };

  const handleSynthesize = async () => {
    setGenerating(true);
    try {
      if (await persistAndApply(await synthesizeSectionToc(bookDoc))) onClose();
    } catch (e) {
      console.error('virtualToc synthesize failed:', e);
      eventDispatcher.dispatch('toast', { message: _('Failed to generate TOC'), type: 'error' });
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Dialog isOpen title={_('Generate TOC from content')} onClose={onClose} useOverlayScroll>
      <div className='flex flex-col gap-3 p-4'>
        <p className='text-base-content/80 text-sm leading-relaxed'>
          {_('This book has no usable TOC. Pick a chapter pattern; matches become TOC entries.')}
        </p>
        <label className='form-control'>
          <div className='label-text text-base-content/70'>
            {_('Custom chapter pattern (optional, e.g. 第\\d+章)')}
          </div>
          <input
            type='text'
            className='input input-sm input-bordered mt-1'
            value={pattern}
            onChange={(e) => {
              setPattern(e.target.value);
              setPreviewCount(null);
            }}
            placeholder='第[0-9一二三四五六七八九十]+章'
          />
        </label>
        {patternErrors.length > 0 && (
          <p className='text-error text-xs'>{_('Invalid pattern: {{reason}}', { reason: patternErrors[0] })}</p>
        )}
        {patternErrors.length === 0 && (
          <p className='text-base-content/70 text-sm'>
            {scanning
              ? _('Scanning…')
              : previewCount !== null
                ? _('This pattern matches {{count}} locations', { count: previewCount })
                : ''}
          </p>
        )}
        {offerSynthesis && (
          <button
            type='button'
            className='btn btn-ghost btn-sm'
            disabled={generating}
            onClick={handleSynthesize}
          >
            {_('Use section files as chapters')}
          </button>
        )}
        <div className='mt-1 flex justify-end gap-2 pb-2'>
          <button type='button' className='btn btn-ghost btn-sm' onClick={onClose}>
            {_('Cancel')}
          </button>
          <button
            type='button'
            className='btn btn-contrast btn-sm'
            disabled={generating || patternErrors.length > 0 || previewCount === 0}
            onClick={handleGenerate}
          >
            {generating ? _('Scanning…') : _('Generate')}
          </button>
        </div>
        <p className='text-base-content/50 text-xs leading-relaxed'>
          {_('Virtual TOC is saved per book and never modifies the EPUB file.')}
        </p>
      </div>
    </Dialog>
  );
};

export default VirtualTocDialog;
```

i18n：三份 locale 各加以下 key（zh-TW 用繁体，此处列 zh-CN 值）：

| key | en | zh-CN |
|---|---|---|
| `Generate TOC from content` | Generate TOC from content | 从正文生成目录 |
| `No table of contents in this book.` | No table of contents in this book. | 本书没有目录信息。 |
| `Custom chapter pattern (optional, e.g. 第\\d+章)` | Custom chapter pattern (optional) | 自定义章节正则（可选） |
| `Invalid pattern: {{reason}}` | Invalid pattern: {{reason}} | 正则无效：{{reason}} |
| `This pattern matches {{count}} locations` | This pattern matches {{count}} locations | 此规则将命中 {{count}} 处 |
| `Scanning…` | Scanning… | 扫描中… |
| `Use section files as chapters` | Use section files as chapters | 按文件分章 |
| `Cancel` / `Generate` | Cancel / Generate | 取消 / 生成 |
| `TOC generated: {{count}} entries` | TOC generated: {{count}} entries | 已生成目录：{{count}} 条 |
| `No chapter-like lines matched. Try a custom pattern.` | … | 未匹配到章节样式行，可试试自定义正则 |
| `Failed to generate TOC` | Failed to generate TOC | 生成目录失败 |
| `Cannot apply virtual TOC to this book` | Cannot apply virtual TOC to this book | 本书目录结构无法应用虚拟目录 |
| `Virtual TOC is saved per book and never modifies the EPUB file.` | … | 虚拟目录按书保存，不会修改 EPUB 文件。 |

（`Cancel` 已存在于三份文件，跳过；`Generate` 需新增。Task 6 已提前加入 `No TOC` / `No table of contents in this book.` / `Generate TOC from content` 三个 key，本任务**不要重复添加**。三份文件 key 必须一致。）

- [ ] **Step 4: 运行测试确认通过**

Run: `npx dotenv -e .env -e .env.test.local -- npx vitest run src/__tests__/app/reader/virtual-toc-dialog.test.tsx src/__tests__/app/reader/virtual-toc-empty-state.test.tsx`
Expected: PASS

- [ ] **Step 5: tsgo + biome 后提交**

```bash
npx tsgo --noEmit && npx biome check --write src/app/reader/components/VirtualTocDialog.tsx src/__tests__/app/reader/virtual-toc-dialog.test.tsx
git add apps/readest-app/src/app/reader/components/VirtualTocDialog.tsx apps/readest-app/public/locales/en/translation.json apps/readest-app/public/locales/zh-CN/translation.json apps/readest-app/public/locales/zh-TW/translation.json apps/readest-app/src/__tests__/app/reader/virtual-toc-dialog.test.tsx
git commit -m "feat: 虚拟目录引导弹窗（正则预选+命中预览+按文件分章+持久化）"
```

---

### Task 8: 端到端手工验证 + 全量门禁

**Files:**
- 无新文件（验证任务）

- [ ] **Step 1: dev 起服务**

Run: `npx dotenv -e .env -- npx next dev -p 34567`（后台）

- [ ] **Step 2: 样本书全链路验证**

样本：`C:\Users\30575\Downloads\371c57b3-ecad-4256-99ae-d4394e2ec0ff.epub`（Pixiv 下载器 EPUB：8 万字单 HTML、约 15 处「第X章」文本行、NCX 3 条结构条目）。导入后打开：

1. 侧栏显示那 **3 条结构条目（信息/目录/全文）+ 生成入口**（退化非空态，**不是空态**；这是 Task 6.5 修正后的预期）✓
2. 点生成 → 弹窗内置规则预览显示命中约 15 处 ✓
3. 点「生成」 → **原有 3 条真实条目保留 + 新增约 15 条虚拟条目（共约 18 条）**；toast 报数 ✓（apply 语义是追加，不是替换）
4. 点击任一虚拟条目 → 视图跳到对应章节位置（CFI 生效）✓
5. 关书重开 → 目录仍在（`Books/{hash}/config.json` 含 `virtualToc`；再次打开时负 id 虚拟条目先被剥离、再按 slab 判据重新应用）✓
6. 再次打开生成弹窗重新生成 → 虚拟条目被替换而非叠加（负 id 剥离 + 新数组覆盖 config）✓
7. 正常 EPUB（有健康目录）打开 → 无生成入口 ✓
8. 降级路径：让 `applyVirtualToc` 返回 false（临时改回拒绝条件，或用手上的健康目录书强触发）→ 点生成应得到**错误 toast、config 不被写入、弹窗不关闭** ✓

**已知数据怪癖（不是缺陷，验证时别当 bug 报）**：正文开头有一段内嵌目录列表（序章/第一~六章连排的 `<p>`），形状与真标题一模一样，会被扫描器一并命中——约 15 处命中里有一半来自这段列表，生成的条目会指向开头那个列表块。属预期数据怪癖。

- [ ] **Step 3: 全量门禁**

Run: `npx tsgo --noEmit && npx biome lint . && npx dotenv -e .env -e .env.test.local -- npx vitest run`
Expected: 0 错 / 干净 / 全过

- [ ] **Step 4: 提交（如有验证中修复）并推送**

```bash
git push origin readest-local
```

---

## 附录：已核实事实（执行者可复核）

| 事实 | 位置 |
|---|---|
| `view.goTo` 原生接受 CFI（先 `CFI.isCFI` 再 `resolveCFI`） | `packages/foliate-js/view.js:516-529` |
| 侧栏目录点击走 `getView(bookKey)?.goTo(item.href)`——虚拟条目把 CFI 填进 `href` 即可跳转 | `sidebar/TOCView.tsx:194-202`、`TOCItem.tsx:76` |
| 侧栏目录空态条件分支现状 `bookDoc.toc && <TOCView/>` | `sidebar/Content.tsx:85` |
| nav 缓存层：打开书时 `hydrateBookNav`/`computeBookNav` + nav.json（`BOOK_NAV_VERSION=4` 整体失效） | `services/nav/index.ts:79`、`store/readerStore.ts:252-264` |
| nav v3 已有“稀疏 NCX 时扫描 section HTML 合并顶层 TOC”先例（并发上限、loadText 用法可抄） | `services/nav/enrichment.ts:1-30` |
| 元素→CFI 生成与 body 越界防护已有实现（本计划 Task 2 抽取复用） | `services/nav/fragments.ts:80-103` |
| 章节正则引擎（CHAPTER_RULES/validateChapterPattern/createChapterRegexps，含 LRU 缓存与 ReDoS 守门） | `utils/txt.ts:41,112,121,228,1057` |
| TXT 引导是“重切物化 ncx”范式（与本方案不同范式，不复用其流程） | `utils/txt.ts:1100-1137`（createEpub 写 navPoint） |
| readerStore 打开路径：config → nav → updateToc；bookData 写入模式 `useBookDataStore.setState` | `store/readerStore.ts:230-313` |
| bookDataStore 提供 `getConfig`/`setConfig`/`saveConfig` | `store/bookDataStore.ts:70-120` |
| 样本书结构：单 `page-0.html`（3544 段、0 锚点、约 15 处「第X章」文本行），NCX 仅 3 条 navPoint（信息/目录/全文，均无锚点） | 2026-09-11 解包复核 |
| 样本书更正：`page-0.html` **并非**「0 个 h1-h4」——有 1 个 `<h2 class="chapter-title">`（书名，不命中章节规则，无碍）；章节行是普通 `<p>`（如 `<p>第一章：少女初情</p>`） | 2026-09-11 解包复核 |
| 样本书 `page-0.html` 267KB（同级文件 0.4–1.4KB）→ 构成 slab；且只被 1 条无锚点条目指到 → 退化判据命中 | 2026-09-11 解包复核 |
| nav 富化门槛 `sections.length > 64`，样本书只有 4 个 spine section 故富化不触发 → `hydrateBookNav` 直赋 `bookDoc.toc = cloneTocItems(bookNav.toc)`，打开后 toc 恒为 3 条 | `services/nav/enrichment.ts:104`、`services/nav/index.ts:235` |

## 风险与边界（已内置到任务里）

- **nav.json 不承载虚拟条目**（缓存语义冲突）→ 合并只在 readerStore 打开路径（Task 6）。
- **TOCView memo 不重渲染** → `applyVirtualToc` 必须赋新数组引用（Task 3 接口注释 + 测试）。
- **foliate fromElements 在 body/html 越界崩溃** → 复用 `isCfiAddressable` 防护（Task 2）。
- **fixed-layout** → 与 nav 管线同门禁跳过（Task 3/5）。
- **超大书扫描** → 有界并发 64 + countOnly 预览先行（Task 4）；引导交互是“正则预选+命中数”而非逐行勾选（评审修正采纳）。
- **健康目录不被动** → `applyVirtualToc` 门禁 = 真实条目 ≤ 1 **或** `isTocDegraded(bookDoc)`（Task 6.5 修正；原「仅 ≤1 条」会让 NCX 带 3 条结构条目的单文件书永远不可达）。
- **静默失败** → `persistAndApply` 必须先 apply 并检查返回值、再 saveConfig；被拒绝时不写 config、不关弹窗、报错误 toast（Task 7）。
- **格式门禁** → 侧栏入口与弹窗挂载限 `book.format === 'EPUB'`（Task 6.5），与 nav 门禁口径一致（MOBI/FB2/CBZ 也产出 `sections` 且不设 `rendition`）。

## Self-Review 记录

- 覆盖度：评审五条修正（范式澄清/伪流式/正则预选/触发放宽/nav 层复用）分别落在 Task 3（范式）、Task 4 注（随机访问）、Task 7（预选+预览）、Task 5（退化自动合成）、Task 6（打开路径合并）。✓
- 占位符扫描：Task 6 Step 3 的 `VirtualTocDialog` 骨架是有意的跨任务依赖（Task 7 完整实现），接口签名已给出；无 TBD/TODO。✓
- 类型一致性：`VirtualTocEntry`（Task 3 定义）在 Task 4/5/7 消费一致；`buildChapterRegexps`/`matchChapterTitle`（Task 1）在 Task 4 消费一致；`buildElementCfi(sectionCfi, element)`（Task 2）在 Task 4/5 消费一致。✓
- **2026-09-11 执行期修正（第二轮评审）**：新增 **Task 6.5**（退化判据 slab 化 + 入口条件 + 退化非空态 UI + 格式门禁），因为它暴露了原计划的两条内部矛盾——Task 3 的「toc ≤1 才应用」与 Task 8 E2E「样本书生成 15 条」不可同时成立；Task 6 的「toc > 0 即渲染 TOCView」又让入口在样本书上根本不出现。同时修正：Task 7 的静默失败顺序（先 apply 再 saveConfig + 返回值检查）、Task 7 测试 mock 的三处错误与新增被拒用例、Task 8 的步骤 1/3 预期与附录事实（slab 证据链）。✓
