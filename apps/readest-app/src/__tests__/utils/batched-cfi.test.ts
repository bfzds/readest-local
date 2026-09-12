import { describe, test, expect } from 'vitest';
import * as CFI from 'foliate-js/epubcfi.js';
import { createBatchedSectionCfiResolver, BatchedCfiPrepared } from '@/utils/batchedCfi';

/**
 * Differential regression test for the batched search-result CFI resolver:
 * for every match the resolver's output must be byte-identical to the naive
 * `CFI.joinIndir(baseCFI, CFI.fromRange(range))` path it replaced. The naive
 * path costs ~1ms/match in a real webview (26k matches ≈ 30s) because
 * CFI.fromRange re-indexes every ancestor's children per call; the resolver
 * caches per-text-node-pair templates and assembles offsets by string.
 */

// Minimal text-walker equivalent: one Range factory over a flat document,
// mirroring prepareSearchSection's { text, cumulative, makeRange } contract.
const makePrepared = (markup: string): BatchedCfiPrepared & { doc: Document } => {
  const doc = new DOMParser().parseFromString(markup, 'application/xml');
  const strings: string[] = [];
  const walkerNodes: Node[] = [];
  const collect = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === child.TEXT_NODE) {
        strings.push(child.nodeValue ?? '');
        walkerNodes.push(child);
      } else if (child.nodeType === child.ELEMENT_NODE) {
        collect(child);
      }
    }
  };
  collect(doc.documentElement);
  const text = strings.join('');
  const cumulative = [0];
  for (const value of strings) cumulative.push(cumulative.at(-1)! + value.length);
  const makeRange = (indexA: number, offsetA: number, indexB: number, offsetB: number) => {
    const range = doc.createRange();
    range.setStart(walkerNodes[indexA]!, offsetA);
    range.setEnd(walkerNodes[indexB]!, offsetB);
    return range;
  };
  return { doc, text, cumulative, makeRange };
};

describe('createBatchedSectionCfiResolver', () => {
  const markup =
    '<book><chapter><p id="p1">甲乙丙丁戊己庚辛壬癸甲乙丙丁戊己庚辛壬癸</p>' +
    '<p>第二段落文字，甲乙出现一次。</p><em>斜体甲乙与后文</em>' +
    '<p id="p3">跨节点甲<em>乙</em>与更多甲乙内容填充甲乙占位</p></chapter></book>';
  const prepared = makePrepared(markup);
  const baseCFI = 'epubcfi(/6/14!/4)';
  const resolver = createBatchedSectionCfiResolver(prepared, baseCFI);

  const naive = (start: number, end: number): string | null => {
    if (end > prepared.text.length || start >= end) return null;
    const find = (offset: number, bias: 'left' | 'right') => {
      const { cumulative } = prepared;
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
    const from = find(start, 'right');
    const to = find(end, 'left');
    const range = prepared.makeRange(from.index, from.offset, to.index, to.offset);
    return CFI.joinIndir(baseCFI, CFI.fromRange(range));
  };

  test('produces output identical to per-match CFI.fromRange (same text node)', () => {
    const text = prepared.text;
    const occurrences: Array<[number, number]> = [];
    let idx = text.indexOf('甲乙');
    while (idx >= 0) {
      occurrences.push([idx, idx + 2]);
      idx = text.indexOf('甲乙', idx + 1);
    }
    expect(occurrences.length).toBeGreaterThan(2);
    for (const [start, end] of occurrences) {
      expect(resolver(start, end)).toBe(naive(start, end));
    }
  });

  test('matches the naive path for single-character matches (CJK common char)', () => {
    const text = prepared.text;
    const positions: number[] = [];
    for (let i = text.indexOf('甲'); i >= 0; i = text.indexOf('甲', i + 1)) positions.push(i);
    expect(positions.length).toBeGreaterThan(3);
    for (const start of positions) {
      expect(resolver(start, start + 1)).toBe(naive(start, start + 1));
    }
  });

  test('matches the naive path for cross-element ranges', () => {
    const text = prepared.text;
    // "跨节点甲" ends right before an <em> boundary; build ranges that span
    // from before the boundary to inside the next node.
    const start = text.indexOf('跨节点甲');
    expect(start).toBeGreaterThan(0);
    const end = start + '跨节点甲乙'.length;
    expect(resolver(start, end)).toBe(naive(start, end));
  });

  test('falls back to naive for out-of-range or degenerate spans', () => {
    expect(resolver(5, 5)).toBeNull();
    expect(resolver(10, 5)).toBeNull();
    expect(resolver(prepared.text.length - 1, prepared.text.length + 10)).toBeNull();
  });
});
