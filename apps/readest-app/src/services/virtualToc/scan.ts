import type { BookDoc } from '@/libs/document';
import type { VirtualTocEntry } from '@/types/book';
import { buildElementCfi } from '@/services/nav/elementCfi';
import { runWithConcurrency } from '@/utils/concurrency';
import { buildChapterRegexps, matchChapterTitle } from '@/utils/chapterRules';

export interface ScanProgress {
  done: number;
  total: number;
}

export type ScanProgressCallback = (p: ScanProgress) => void;

const SCAN_CONCURRENCY = 64; // 与 nav enrichment 同量级：spine 读取有界并发
const BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,div';
const MAX_LABEL_LEN = 60;

const normalizeLabel = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LEN);

const collectMatches = async (
  bookDoc: BookDoc,
  pattern: string,
  language: string | undefined,
  countOnly: boolean,
  onProgress?: ScanProgressCallback,
): Promise<{ count: number; entries: VirtualTocEntry[] }> => {
  const sections = (bookDoc.sections ?? []).filter((s) => s.linear !== 'no');
  const regexps = buildChapterRegexps(language || 'zh', pattern ? [pattern] : []);
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
  // runWithConcurrency 返回位置对齐的 `{ item, result } | { item, error }`；
  // 失败项已在 worker 内 catch 成 []，这里的 error 分支仅为类型收窄。
  const entries = outcomes.flatMap((o) => ('result' in o ? o.result : []));
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
