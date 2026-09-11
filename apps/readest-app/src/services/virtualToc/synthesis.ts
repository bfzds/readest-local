import type { BookDoc } from '@/libs/document';
import type { VirtualTocEntry } from '@/types/book';
import { runWithConcurrency } from '@/utils/concurrency';
import { isTocDegraded } from './apply';

const SYNTHESIS_CONCURRENCY = 64;
const MAX_LABEL_LEN = 40;

export const shouldOfferSynthesis = (bookDoc: BookDoc): boolean => {
  if (bookDoc.rendition?.layout === 'pre-paginated') return false;
  // 与 applyVirtualToc 门禁共用同一份「退化」认知：toc 条目数 > 1 也可能是退化
  // （样本书 4 个 spine section、3 条无锚点结构条目），否则弹窗里连「按文件分章」
  // 按钮都不会出现。
  if ((bookDoc.toc?.length ?? 0) > 1 && !isTocDegraded(bookDoc)) return false;
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
          // div 只在“纯文本 div（无块级子元素）”时才算候选行，避免容器节点（如
          // <div class="wrap"> 包住整章）被当成首块、把多段拼成一个标签（同 scan.ts）。
          .filter(
            (el) =>
              !/^div$/i.test(el.tagName) || !el.querySelector('p,div,h1,h2,h3,h4,h5,h6,table,img'),
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
  // runWithConcurrency 返回位置对齐的 `{ item, result } | { item, error }`；
  // 失败项已在 worker 内 catch，error 分支仅为类型收窄（同 Task 4 scan.ts）。
  return outcomes.flatMap((o) => ('result' in o ? [o.result] : []));
};
