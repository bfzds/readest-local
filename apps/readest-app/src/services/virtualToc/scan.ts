import type { BookDoc } from '@/libs/document';
import type { VirtualTocEntry } from '@/types/book';
import { buildElementCfi } from '@/services/nav/elementCfi';
import { calculateCumulativeSizes, calculateSectionSizes } from '@/services/nav/locations';
import { SIZE_PER_LOC } from '@/services/constants';
import { runWithConcurrency } from '@/utils/concurrency';
import { buildChapterRegexps, isNumericNoiseLabel, matchChapterTitle } from '@/utils/chapterRules';

export interface ScanProgress {
  done: number;
  total: number;
}

export type ScanProgressCallback = (p: ScanProgress) => void;

const SCAN_CONCURRENCY = 64; // 与 nav enrichment 同量级：spine 读取有界并发
const BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,div';
const MAX_LABEL_LEN = 60;

// 内嵌目录簇的几何判据：正文开头的「章首目录列表」是一串连续短行，正文真标题
// 则沿文档跳跃。相邻命中的块下标差 ≤ GAP、且整簇长度 ≥ MIN 时判为内嵌目录，
// 整簇丢弃。样本书里 7 条目录列表项连续（blockIdx 差 1）、7 条真标题间隔极大，
// 因此判据把簇丢弃、把跳跃分布原样保留（不做 label 去重——「幕间」这类重名真
// 章节会被 keep-later 误杀）。
const EMBEDDED_TOC_RUN_GAP = 3;
const EMBEDDED_TOC_RUN_MIN = 3;

const normalizeLabel = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LEN);

interface BlockMatch {
  blockIdx: number;
  label: string;
  cfi: string;
  /** 本命中之前所有候选块的 textContent 累计长，用于估算该条的字节位置。 */
  prefixLen: number;
}

/** worker 产物：定稿前的命中（label 是否归一化由 countOnly 决定）。 */
interface ScannedMatch {
  label: string;
  cfi: string;
  current: number;
}

/** 丢弃 section 内「连续命中间隔 ≤ EMBEDDED_TOC_RUN_GAP 且总数 ≥ EMBEDDED_TOC_RUN_MIN」
 *  的密集簇，保留稀疏（跳跃）命中。入参按 blockIdx 升序。 */
const pruneEmbeddedTocRuns = (matches: BlockMatch[]): BlockMatch[] => {
  const kept: BlockMatch[] = [];
  let runStart = 0;
  for (let i = 1; i <= matches.length; i++) {
    const next = matches[i];
    const gap = next ? next.blockIdx - matches[i - 1]!.blockIdx : Infinity;
    if (gap > EMBEDDED_TOC_RUN_GAP) {
      if (i - runStart < EMBEDDED_TOC_RUN_MIN) kept.push(...matches.slice(runStart, i));
      runStart = i;
    }
  }
  return kept;
};

const collectMatches = async (
  bookDoc: BookDoc,
  pattern: string,
  language: string | undefined,
  countOnly: boolean,
  onProgress?: ScanProgressCallback,
): Promise<{ count: number; entries: VirtualTocEntry[] }> => {
  const sections = (bookDoc.sections ?? []).filter((s) => s.linear !== 'no');
  const regexps = buildChapterRegexps(language || 'zh', pattern ? [pattern] : []);
  // 数字噪声过滤只在内置规则路径生效：pattern 为空才过滤。用户手写正则是主权
  // 行为——日记体按日期分章的书（`^\d{4}-\d{2}-\d{2}$`）不能被引擎替他过滤掉。
  const filterNoise = !pattern;
  // location 口径与 nav/locations.ts 共用同一份纯函数（不复制数学）：条目字节
  // 位置 = 本 section 之前的累计字节 + 命中处文本占比 × 本 section 字节。
  const sizes = calculateSectionSizes(sections);
  const cumulativeSizes = calculateCumulativeSizes(sections);
  const totalSize = sizes.length
    ? cumulativeSizes[cumulativeSizes.length - 1]! + sizes[sizes.length - 1]!
    : 0;
  const totalLocations = Math.floor(totalSize / SIZE_PER_LOC);
  let done = 0;
  const total = sections.length;
  const now = Date.now();
  // 带上 section 下标：估算字节位置需要它在累计数组里的偏移。
  const targets = sections.map((section, index) => ({ section, index }));
  const outcomes = await runWithConcurrency(
    targets,
    SCAN_CONCURRENCY,
    async ({ section, index }): Promise<ScannedMatch[]> => {
      try {
        const doc = await section.createDocument();
        const elements = Array.from(doc.querySelectorAll(BLOCK_SELECTOR));
        // div 只在“纯文本 div（无块级子元素）”时才算候选行，避免容器节点误命中
        const candidates = elements.filter(
          (el) =>
            !/^div$/i.test(el.tagName) || !el.querySelector('p,div,h1,h2,h3,h4,h5,h6,table,img'),
        );
        const matches: BlockMatch[] = [];
        let textLen = 0;
        // 带下标循环：块下标是内嵌目录簇判据的输入，textLen 是占比估算的分子。
        for (let i = 0; i < candidates.length; i++) {
          const el = candidates[i]!;
          const text = el.textContent ?? '';
          const label = matchChapterTitle(text, regexps);
          if (label && !(filterNoise && isNumericNoiseLabel(label))) {
            matches.push({
              blockIdx: i,
              label,
              cfi: countOnly ? '' : buildElementCfi(section.cfi, el),
              prefixLen: textLen,
            });
          }
          textLen += text.length;
        }
        const sectionBytes = sizes[index]!;
        const baseBytes = cumulativeSizes[index]!;
        return pruneEmbeddedTocRuns(matches).map((m) => {
          const fraction = textLen > 0 ? m.prefixLen / textLen : 0;
          return {
            label: countOnly ? '' : normalizeLabel(m.label),
            cfi: m.cfi,
            current: Math.floor((baseBytes + fraction * sectionBytes) / SIZE_PER_LOC),
          };
        });
      } catch (e) {
        console.warn(`virtualToc scan: section ${section.id} failed:`, e);
        return [];
      } finally {
        done += 1;
        onProgress?.({ done, total });
      }
    },
  );
  // runWithConcurrency 返回位置对齐的 `{ item, result } | { item, error }`；
  // 失败项已在 worker 内 catch 成 []，这里的 error 分支仅为类型收窄。
  const flat = outcomes.flatMap((o) => ('result' in o ? o.result : []));
  const entries: VirtualTocEntry[] = flat.map((m, i) => ({
    label: m.label,
    cfi: m.cfi,
    source: 'pattern',
    generatedAt: now,
    location: {
      current: m.current,
      // 下一条 entry 的 current 即本条的 next；末条以全书总 loc 收尾。
      next: flat[i + 1]?.current ?? totalLocations,
      total: totalLocations,
    },
  }));
  return { count: entries.length, entries };
};

export const countChapterMatches = (
  bookDoc: BookDoc,
  pattern: string,
  language?: string,
  onProgress?: ScanProgressCallback,
): Promise<number> =>
  collectMatches(bookDoc, pattern, language, true, onProgress).then((r) => r.count);

export const generateVirtualTocEntries = (
  bookDoc: BookDoc,
  pattern: string,
  language?: string,
  onProgress?: ScanProgressCallback,
): Promise<VirtualTocEntry[]> =>
  collectMatches(bookDoc, pattern, language, false, onProgress).then((r) => r.entries);
