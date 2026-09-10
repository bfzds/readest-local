import { SectionFragment, SectionItem, TOCItem } from '@/libs/document';
import { buildElementCfi } from './elementCfi';

const findFragmentPosition = (html: string, fragmentId: string | undefined): number => {
  if (!fragmentId) return html.length;
  const patterns = [
    new RegExp(`\\sid=["']${CSS.escape(fragmentId)}["']`, 'i'),
    new RegExp(`\\sname=["']${CSS.escape(fragmentId)}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && typeof match.index === 'number') return match.index;
  }
  return -1;
};

// Memoized variant for use inside buildSectionFragments — within a single
// section, each TOC fragment id is consulted twice (once as the current
// boundary, once as the next item's `prev`), so without caching we run 2N
// regex scans over the whole HTML for N fragments. The cache collapses that
// to N. Cache lifetime is one section pass; not exposed.
const makeFragmentPositionCache = (html: string) => {
  const memo = new Map<string, number>();
  return (fragmentId: string | undefined): number => {
    if (!fragmentId) return html.length;
    const cached = memo.get(fragmentId);
    if (cached !== undefined) return cached;
    const pos = findFragmentPosition(html, fragmentId);
    memo.set(fragmentId, pos);
    return pos;
  };
};

const calculateFragmentSize = (
  content: string,
  fragmentId: string | undefined,
  prevFragmentId: string | undefined,
  positionOf: (id: string | undefined) => number,
): number => {
  const endPos = positionOf(fragmentId);
  if (endPos < 0) return 0;
  const startPos = prevFragmentId ? positionOf(prevFragmentId) : 0;
  const validStartPos = Math.max(0, startPos);
  if (endPos < validStartPos) return 0;
  return new Blob([content.substring(validStartPos, endPos)]).size;
};

const getHTMLFragmentElement = (doc: Document, id: string | undefined): Element | null => {
  if (!id) return null;
  return doc.getElementById(id) ?? doc.querySelector(`[name="${CSS.escape(id)}"]`);
};

export const buildSectionFragments = (
  section: SectionItem,
  fragments: TOCItem[],
  base: TOCItem | null,
  content: string,
  doc: Document,
  splitHref: (href: string) => Array<string | number>,
): SectionFragment[] => {
  const out: SectionFragment[] = [];
  const positionOf = makeFragmentPositionCache(content);
  for (let i = 0; i < fragments.length; i++) {
    const fragment = fragments[i]!;
    const [, rawFragmentId] = splitHref(fragment.href) as [string | undefined, string | undefined];
    const fragmentId = rawFragmentId;

    const prev = i > 0 ? fragments[i - 1] : base;
    const [, rawPrevFragmentId] = prev
      ? (splitHref(prev.href) as [string | undefined, string | undefined])
      : [undefined, undefined];
    const prevFragmentId = rawPrevFragmentId;

    const element = getHTMLFragmentElement(doc, fragmentId);
    const cfi = buildElementCfi(section.cfi, element);
    const size = calculateFragmentSize(content, fragmentId, prevFragmentId, positionOf);

    out.push({
      id: fragment.href,
      href: fragment.href,
      cfi,
      size,
      linear: section.linear,
    });
  }
  return out;
};
