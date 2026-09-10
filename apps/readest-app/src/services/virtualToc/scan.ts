import type { BookDoc } from '@/libs/document';
import type { VirtualTocEntry } from '@/types/book';
import { buildElementCfi } from '@/services/nav/elementCfi';
import { runWithConcurrency } from '@/utils/concurrency';
import {
  buildChapterRegexps,
  matchChapterTitle,
  validateChapterPattern,
} from '@/utils/chapterRules';

export interface ScanProgress {
  done: number;
  total: number;
}

export type ScanProgressCallback = (p: ScanProgress) => void;

const SCAN_CONCURRENCY = 64; // 与 nav enrichment 同量级：spine 读取有界并发
const BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,div';
const MAX_LABEL_LEN = 60;

const normalizeLabel = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LEN);

/**
 * 编译扫描用正则：
 * - `pattern` 为空 → 走内置语言规则（预览默认命中数）；
 * - `pattern` 非空 → 用户显式给出的规则，取代内置规则（无效规则返回空集，
 *   调用方（弹窗）已先用 validateChapterPattern 拦下非法输入，这里再兜一层）。
 *
 * 注意：与 `buildChapterRegexps` 的“用户规则置前 + 内置规则兜底”合并语义不同，
 * 扫描器的自定义规则是独占的——测试 `countChapterMatches(makeDoc(), '【[一二三]+】…')`
 * 期望 0，即自定义规则不命中时不回落到内置规则。
 */
const buildScanRegexps = (language: string | undefined, pattern: string): RegExp[] => {
  const lang = language || 'zh';
  if (!pattern) return buildChapterRegexps(lang);
  if (validateChapterPattern(pattern).length > 0) return [];
  try {
    new RegExp(String.raw`(?:^|\n)\s*(${pattern})`, 'u');
  } catch {
    return [];
  }
  // buildChapterRegexps 把用户规则置于最前；单条 pattern（合法）恰好一段，只取它。
  return buildChapterRegexps(lang, [pattern]).slice(0, 1);
};

/**
 * 元素级 CFI。真实 foliate section CFI 形如 `epubcfi(/6/N)`（无 indirection），
 * 直接 join 即可。若 section CFI 已经以空 indirection `!)` 结尾（非真实形态），
 * joinIndir 会产出非法的 `!!` 序列，此时回退到 section 锚点。
 */
const buildEntryCfi = (sectionCfi: string, element: Element): string => {
  if (sectionCfi.endsWith('!)')) return sectionCfi;
  return buildElementCfi(sectionCfi, element);
};

const resolveProgressArgs = (
  languageOrProgress?: string | ScanProgressCallback,
  onProgressOrLanguage?: ScanProgressCallback | string,
): { language: string | undefined; onProgress: ScanProgressCallback | undefined } => {
  if (typeof languageOrProgress === 'function') {
    return { language: undefined, onProgress: languageOrProgress };
  }
  return {
    language: languageOrProgress,
    onProgress: typeof onProgressOrLanguage === 'function' ? onProgressOrLanguage : undefined,
  };
};

const collectMatches = async (
  bookDoc: BookDoc,
  pattern: string,
  language: string | undefined,
  countOnly: boolean,
  onProgress?: ScanProgressCallback,
): Promise<{ count: number; entries: VirtualTocEntry[] }> => {
  const sections = (bookDoc.sections ?? []).filter((s) => s.linear !== 'no');
  const regexps = buildScanRegexps(language, pattern);
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
          !/^div$/i.test(el.tagName) || !el.querySelector('p,div,h1,h2,h3,h4,h5,h6,table,img'),
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
            cfi: buildEntryCfi(section.cfi, el),
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
  // runWithConcurrency 返回位置对齐的 `{ item, result } | { item, error }`；
  // 失败项已在 worker 内 catch 成 []，这里的 error 分支仅为类型收窄。
  const entries = outcomes.flatMap((o) => ('result' in o ? o.result : []));
  return { count: entries.length, entries };
};

export function countChapterMatches(
  bookDoc: BookDoc,
  pattern: string,
  language?: string,
  onProgress?: ScanProgressCallback,
): Promise<number>;
export function countChapterMatches(
  bookDoc: BookDoc,
  pattern: string,
  onProgress?: ScanProgressCallback,
  language?: string,
): Promise<number>;
export function countChapterMatches(
  bookDoc: BookDoc,
  pattern: string,
  languageOrProgress?: string | ScanProgressCallback,
  onProgressOrLanguage?: ScanProgressCallback | string,
): Promise<number> {
  const { language, onProgress } = resolveProgressArgs(languageOrProgress, onProgressOrLanguage);
  return collectMatches(bookDoc, pattern, language, true, onProgress).then((r) => r.count);
}

export const generateVirtualTocEntries = (
  bookDoc: BookDoc,
  pattern: string,
  language?: string,
  onProgress?: ScanProgressCallback,
): Promise<VirtualTocEntry[]> =>
  collectMatches(bookDoc, pattern, language, false, onProgress).then((r) => r.entries);
