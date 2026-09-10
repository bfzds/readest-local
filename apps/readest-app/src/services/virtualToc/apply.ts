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
