import * as CFI from 'foliate-js/epubcfi.js';

/**
 * Batched section-local CFI resolver for search results.
 *
 * `CFI.fromRange` costs ~1ms per call in a real webview because it re-indexes
 * every ancestor's child list on each invocation (see `nodeToParts` in
 * foliate-js/epubcfi.js). A common-character search in a CJK book can yield
 * tens of thousands of matches, most of which share the SAME start/end text
 * node — and two ranges sharing both endpoints produce CFIs that differ only
 * in the two terminal character offsets.
 *
 * The resolver therefore caches, per (startNode, endNode) pair — identified by
 * the text-walker's node indices — the CFI string pieces that don't depend on
 * the offsets (the shared parent path plus the terminal node steps), taken
 * from one real `CFI.fromRange` call on the pair's first match. Every further
 * match in that pair is then a pure string assembly. Pairs whose template
 * doesn't fit the `epubcfi(parent,start,end)` shape (collapsed, or assertion
 * bearing CFIs) fall back to per-match `CFI.fromRange`.
 */

export interface BatchedCfiPrepared {
  /** Full concatenated section text (same as prepareSearchSection's text). */
  text: string;
  /** Cumulative offsets of each text node, as in prepareSearchSection. */
  cumulative: number[];
  /** makeRange from prepareSearchSection: (nodeIndex, offset, nodeIndex, offset) → Range. */
  makeRange: (indexA: number, offsetA: number, indexB: number, offsetB: number) => Range;
}

/** `epubcfi(parent,start,end)` pieces that are independent of the offsets. */
interface OffsetTemplate {
  parent: string;
  startPrefix: string;
  endPrefix: string;
}

export const createBatchedSectionCfiResolver = (
  prepared: BatchedCfiPrepared,
  baseCFI: string,
): ((start: number, end: number) => string | null) => {
  const { text, cumulative, makeRange } = prepared;
  // Batch-scoped memoization of the CFI child-list computation. The node-pair
  // template cache below degrades on flat DOMs (thousands of distinct node
  // pairs), letting through a full CFI.fromRange per match — whose cost is
  // dominated by rebuilding every ancestor's CFI child list. This cache makes
  // those repeats O(1) lookups; scoped to this resolver (one section's resolve
  // loop), so a restructured document can never serve stale lists.
  const indexCache = CFI.createIndexCache();
  // One entry per (startNodeIndex, endNodeIndex) pair. null marks a pair whose
  // CFI doesn't fit the offset-substitutable shape — always fall back for it.
  const templates = new Map<string, OffsetTemplate | null>();
  const findNodeOffset = (
    offset: number,
    bias: 'left' | 'right',
  ): { index: number; offset: number } => {
    let low = 0;
    let high = cumulative.length - 2;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (cumulative[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    if (bias === 'left') {
      while (low > 0 && cumulative[low] === offset) low--;
    }
    return { index: low, offset: offset - cumulative[low]! };
  };

  const templateFor = (indexA: number, offsetA: number, indexB: number, offsetB: number) => {
    const key = `${indexA}:${indexB}`;
    let template = templates.get(key);
    if (template === undefined) {
      const range = makeRange(indexA, offsetA, indexB, offsetB);
      template = null;
      // fromRange wraps collapsed/point CFIs without the 3-part range shape,
      // and any future CFI feature (assertions, spatial/temporal) would break
      // offset substitution — the 3-segment check guards all of those.
      const inner = CFI.fromRange(range, undefined, indexCache)
        .replace(/^epubcfi\(/, '')
        .replace(/\)$/, '');
      const segments = inner.split(',');
      if (segments.length === 3) {
        const [parent, startTerm, endTerm] = segments;
        const startColon = startTerm!.lastIndexOf(':');
        const endColon = endTerm!.lastIndexOf(':');
        if (startColon > 0 && endColon > 0) {
          template = {
            parent: parent!,
            startPrefix: startTerm!.slice(0, startColon),
            endPrefix: endTerm!.slice(0, endColon),
          };
        }
      }
      templates.set(key, template);
    }
    return template;
  };

  return (start: number, end: number): string | null => {
    if (end > text.length || start >= end) return null;
    const from = findNodeOffset(start, 'right');
    const to = findNodeOffset(end, 'left');
    const template = templateFor(from.index, from.offset, to.index, to.offset);
    if (!template) {
      const range = makeRange(from.index, from.offset, to.index, to.offset);
      return CFI.joinIndir(baseCFI, CFI.fromRange(range, undefined, indexCache));
    }
    // The offsets in a range CFI are node-relative character positions —
    // exactly what findNodeOffset produced.
    return CFI.joinIndir(
      baseCFI,
      `epubcfi(${template.parent},${template.startPrefix}:${from.offset},${template.endPrefix}:${to.offset})`,
    );
  };
};
