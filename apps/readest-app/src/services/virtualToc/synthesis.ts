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
        const firstBlock = Array.from(doc.querySelectorAll('p,div,h1,h2,h3,h4,h5,h6')).find((el) =>
          el.textContent?.trim(),
        );
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
  // runWithConcurrency 返回位置对齐的 `{ item, result } | { item, error }`；
  // 失败项已在 worker 内 catch，error 分支仅为类型收窄（同 Task 4 scan.ts）。
  return outcomes.flatMap((o) => ('result' in o ? [o.result] : []));
};
