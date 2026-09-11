import type { BookDoc, TOCItem } from '@/libs/document';
import type { VirtualTocEntry } from '@/types/book';
import { collectAllTocItems } from '@/services/nav/grouping';

// 巨型内容 section（slab）阈值：约 6 万字中文的 XHTML 字节数。单文件长篇小说的
// 正文常常就是「一个几百 KB 的 HTML + 3 条无锚点结构条目」，这是本功能的首要
// 目标书类；健康分章书每章只有 10–60KB，触发不到。常量化便于后续调整。
const SLAB_SIZE_BYTES = 128 * 1024;

/** 取 TOC href 的 section 路径。splitTOCHref 的返回形态随格式而异（EPUB 返回
 *  [路径, fragment]，PDF 是 async），拿不到数组时退回按 '#' 手拆，绝不抛错。 */
const sectionPathOf = (bookDoc: BookDoc, href: string): string => {
  const parts = bookDoc.splitTOCHref?.(href);
  const section = Array.isArray(parts) ? parts[0] : undefined;
  return typeof section === 'string' ? section : (href.split('#')[0] ?? href);
};

/**
 * 退化目录判据：存在一个巨型内容 section（slab，`size >= 128KB`）且指向它的
 * **不同 TOC 锚点 ≤ 1**。apply 门禁、侧栏入口、弹窗合成入口三处共用同一判据。
 *
 * 为什么不直接看「条目有没有锚点」：按文件分章的健康书每章一个文件、href 无
 * fragment，照样没有锚点——锚点是「健康」的充分信号，不是必要信号。健康分章书
 * 与退化单文件书的真正区别是**有没有 slab**。
 *
 * 「不同锚点」的去重键是**完整 href**（section 路径 + `#fragment`）：一本单文件书
 * 把几十个锚点指向同一个文件，正是健康的锚点目录；若只按去掉 fragment 的 section
 * 路径去重，这些锚点会被压成 1 个目标而误判退化。
 */
export const isTocDegraded = (bookDoc: BookDoc): boolean => {
  const slabs = (bookDoc.sections ?? []).filter(
    (section) => section.linear !== 'no' && section.size >= SLAB_SIZE_BYTES,
  );
  if (!slabs.length) return false;
  // slab 的比对键取 section.id：foliate-js 中它就是 manifest item 的 href 全路径，
  // 与 splitTOCHref 返回的 section 路径同源，nav/locations.ts 的 sectionsMap 也以
  // id 为键。section.href 只在个别 loader（mrexpt）上出现，一并认。section.cfi 不
  // 参与比对——它是 CFI 定位串而非 href 路径，splitTOCHref 永不返回它。
  const anchorsBySlab = new Map<string, Set<string>>();
  for (const slab of slabs) {
    for (const key of [slab.id, slab.href]) {
      if (key && !anchorsBySlab.has(key)) anchorsBySlab.set(key, new Set());
    }
  }
  for (const item of collectAllTocItems(bookDoc.toc ?? [])) {
    if (!item.href) continue;
    anchorsBySlab.get(sectionPathOf(bookDoc, item.href))?.add(item.href);
  }
  for (const anchors of anchorsBySlab.values()) {
    if (anchors.size <= 1) return true;
  }
  return false;
};

export const virtualTocToItems = (entries: VirtualTocEntry[]): TOCItem[] =>
  entries.map((entry, i) => ({
    id: -1 - i, // 负数 id 区分虚拟条目，避免与真实 TOC id 冲突
    label: entry.label,
    href: entry.cfi, // goTo 原生支持 CFI 目标（view.js resolveNavigation 先测 CFI.isCFI）
    index: 0,
    // subitems 键整键省略（不是 []）——空数组是 truthy，侧栏会据此画出可展开的
    // 假三角（TOCItem.tsx 判真）。叶子就必须是 undefined。
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
  // 条目数 > 1 不再等于「目录健康」：样本书的 3 条结构条目全都无锚点地指向同一个
  // 巨型 section，同样属于退化的目标书类。健康判据交给 isTocDegraded。
  if (real.length > 1 && !isTocDegraded(bookDoc)) return false;
  bookDoc.toc = [...real, ...virtualTocToItems(entries)];
  return true;
};
