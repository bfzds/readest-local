import type { BookDoc, TOCItem } from '@/libs/document';
import { CFI } from '@/libs/document';
import type { VirtualTocEntry } from '@/types/book';
import { collectAllTocItems } from '@/services/nav/grouping';
import { getIndexFromCfi } from '@/utils/cfi';

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
    // 旧实现恒为 0（页码恒为 1）；用 CFI 推出真 spine 序，占位至少有意义。
    index: getIndexFromCfi(entry.cfi) ?? 0,
    // subitems 键整键省略（不是 []）——空数组是 truthy，侧栏会据此画出可展开的
    // 假三角（TOCItem.tsx 判真）。叶子就必须是 undefined。
    // 旧 config 的条目无 location：整键省略，行为同现状。
    ...(entry.location ? { location: entry.location } : {}),
  }));

/** 虚拟条目的稳定特征：href 是 CFI 串（config 里存的就是 CFI）。
 *  不能只看 id：nav 管线会把条目重新编号成非负（locations.ts `item.id ??= index++`），
 *  历史 nav.json 里那 14 条虚拟条目就是这样变成 id=3..16 的，之后 id 判据就失效了。
 *  isCFI 是 RegExp，必须用 .test()，不能当函数调。 */
export const isVirtualTocItem = (item: TOCItem): boolean =>
  CFI.isCFI.test(item.href ?? '') || item.id < 0;

/**
 * 原地剥离 bookDoc.toc 里的虚拟条目（无论 id 被重编号成正还是负），返回剥离条数。
 *
 * 用途：nav.json 只承载真实目录。`computeBookNav` 读的是内存里的 `bookDoc.toc`，
 * 若它已经被上一次 `applyVirtualToc` 合并过虚拟条目，这些条目就会被写进 nav.json
 * 并被重新编号，下次打开认不出来 → 每次开书叠加一轮（真机 21 条）。所以计算 nav
 * **之前**先剥一次。只在内存里改 toc：不写 config、不动 nav.json 文件本身。
 */
export const stripVirtualTocItems = (bookDoc: BookDoc): number => {
  const items = bookDoc.toc;
  if (!items?.length) return 0;
  const real = items.filter((item) => !isVirtualTocItem(item));
  const stripped = items.length - real.length;
  if (stripped > 0) bookDoc.toc = real;
  return stripped;
};

export const applyVirtualToc = (
  bookDoc: BookDoc,
  entries: VirtualTocEntry[] | undefined,
): boolean => {
  if (!entries?.length) return false;
  if (bookDoc.rendition?.layout === 'pre-paginated') return false;
  // 先剥离既有虚拟条目再判健康目录——否则"重新生成"会被 healthy 守卫拒绝、
  // 无法替换（R2）。判据是 href 是否 CFI 串，不依赖 id（历史 nav.json 里留下的
  // 虚拟条目 id 已被重编号成非负，只判 id < 0 会认不出来）。
  const real = (bookDoc.toc ?? []).filter((item) => !isVirtualTocItem(item));
  // 条目数 > 1 不再等于「目录健康」：样本书的 3 条结构条目全都无锚点地指向同一个
  // 巨型 section，同样属于退化的目标书类。健康判据交给 isTocDegraded。
  if (real.length > 1 && !isTocDegraded(bookDoc)) return false;
  bookDoc.toc = [...real, ...virtualTocToItems(entries)];
  return true;
};
