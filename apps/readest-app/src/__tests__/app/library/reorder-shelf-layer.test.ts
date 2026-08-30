import { describe, expect, it } from 'vitest';

import {
  assignEmptyGroupAnchors,
  createGroupSorter,
  rebaseLayerAfterGroupMerge,
  relabelAnchorMap,
  reassignToGroup,
  reorderShelfLayer,
  swapShelfUnits,
} from '@/app/library/utils/libraryUtils';
import type { Book, BooksGroup } from '@/types/book';
import { LibrarySortByType } from '@/types/settings';

const book = (hash: string, shelfIndex?: number): Book =>
  ({
    hash,
    format: 'EPUB',
    title: hash,
    shelfIndex,
  }) as Book;

const group = (name: string, ...books: Book[]): BooksGroup =>
  ({
    id: name,
    name,
    displayName: name,
    books,
    updatedAt: 0,
  }) as BooksGroup;

const byIndex = (updated: Book[]): string[] =>
  updated
    .slice()
    .sort((x, y) => (x.shelfIndex ?? 0) - (y.shelfIndex ?? 0))
    .map((b) => b.hash);

describe('reorderShelfLayer — manual-sort drag within the same layer', () => {
  it('moves a book after another book', () => {
    const items = [book('a', 0), book('b', 1), book('c', 2)];
    const { updated, changed } = reorderShelfLayer(items, 'a', 'c', false);
    expect(changed).toBe(true);
    const byHash = new Map(updated.map((b) => [b.hash, b.shelfIndex]));
    expect(byHash.get('a')).toBe(2);
    expect(byHash.get('b')).toBe(0);
    expect(byHash.get('c')).toBe(1);
  });

  it('moves a book before another book', () => {
    const items = [book('a', 0), book('b', 1), book('c', 2)];
    const { updated, changed } = reorderShelfLayer(items, 'c', 'a', true);
    expect(changed).toBe(true);
    const order = updated
      .sort((x, y) => (x.shelfIndex ?? 0) - (y.shelfIndex ?? 0))
      .map((b) => b.hash);
    expect(order).toEqual(['c', 'a', 'b']);
  });

  it('moves a whole group block before a target group, keeping inner order', () => {
    const items = [
      group('A', book('a1', 0), book('a2', 1)),
      group('B', book('b1', 2)),
      group('C', book('c1', 3)),
    ];
    const { updated, changed } = reorderShelfLayer(items, 'A', 'B', false);
    expect(changed).toBe(true);
    const order = updated
      .sort((x, y) => (x.shelfIndex ?? 0) - (y.shelfIndex ?? 0))
      .map((b) => b.hash);
    // A joins right after B, its members stay adjacent in original order.
    expect(order).toEqual(['b1', 'a1', 'a2', 'c1']);
  });

  it('swaps adjacent units when dropping already sits right before the target (drag 1 onto top of 2)', () => {
    const items = [
      book('1', 0),
      book('2', 1),
      book('3', 2),
      book('4', 3),
      book('5', 4),
      book('6', 5),
    ];
    const { updated, changed } = reorderShelfLayer(items, '1', '2', true);
    expect(changed).toBe(true);
    expect(byIndex(updated)).toEqual(['2', '1', '3', '4', '5', '6']);
  });

  it('swaps adjacent units when dropping already sits right after the target', () => {
    const items = [book('a', 0), book('b', 1), book('c', 2)];
    const { updated, changed } = reorderShelfLayer(items, 'c', 'b', false);
    expect(changed).toBe(true);
    expect(byIndex(updated)).toEqual(['a', 'c', 'b']);
  });

  it('keeps books of the source and target groups in their relative order after the move', () => {
    const items = [group('A', book('a1', 0), book('a3', 2)), group('B', book('b1', 1))];
    const { updated } = reorderShelfLayer(items, 'A', 'B', false);
    const underA = updated
      .filter((b) => b.hash.startsWith('a'))
      .sort((x, y) => (x.shelfIndex ?? 0) - (y.shelfIndex ?? 0));
    expect(underA.map((b) => b.hash)).toEqual(['a1', 'a3']);
  });

  it('reorders a book-less empty group as a unit against another group', () => {
    const items = [group('A'), group('B', book('b1', 0)), group('C', book('c1', 1))];
    const { updated, changed } = reorderShelfLayer(items, 'A', 'C', true);
    expect(changed).toBe(true);
    const order = updated
      .sort((x, y) => (x.shelfIndex ?? 0) - (y.shelfIndex ?? 0))
      .map((b) => b.hash);
    // A (no books) now sits right before C; the visible unit order is B, A, C.
    expect(order).toEqual(['b1', 'c1']);
  });

  it('swapping the first two books keeps the rest in place (regression: 1↔2)', () => {
    const items = [1, 2, 3, 4, 5, 6].map((n) => book(String(n), n - 1));
    const displayOrder = (updated: Book[]) =>
      updated
        .slice()
        .sort((x, y) => (x.shelfIndex ?? 0) - (y.shelfIndex ?? 0))
        .map((b) => b.hash);
    // Drag 1 onto 2's lower half (after).
    expect(displayOrder(reorderShelfLayer(items, '1', '2', false).updated)).toEqual([
      '2',
      '1',
      '3',
      '4',
      '5',
      '6',
    ]);
    // Drag 2 onto 1's upper half (before).
    expect(displayOrder(reorderShelfLayer(items, '2', '1', true).updated)).toEqual([
      '2',
      '1',
      '3',
      '4',
      '5',
      '6',
    ]);
  });
});

describe('assignEmptyGroupAnchors — empty groups interleave with book groups', () => {
  it('places an empty group mid-gap between the neighbouring book groups', () => {
    const ordered: (Book | BooksGroup)[] = [
      group('BooksA', book('a1', 0)),
      group('Empty'),
      group('BooksB', book('b1', 5)),
    ];
    const anchors = assignEmptyGroupAnchors(ordered);
    expect(anchors.get('Empty')).toBe(2.5);
  });

  it('keeps an empty group in front of everything when it leads the layer', () => {
    const ordered = [group('Empty'), group('BooksA', book('a1', 0))];
    const anchors = assignEmptyGroupAnchors(ordered);
    expect(anchors.get('Empty')).toBe(-1);
  });

  it('sends an empty group after the last book group when it trails', () => {
    const ordered = [group('BooksA', book('a1', 0)), group('Empty')];
    const anchors = assignEmptyGroupAnchors(ordered);
    expect(anchors.get('Empty')).toBe(0.5);
  });

  it('splits one gap evenly across a run of empty groups', () => {
    const ordered = [
      group('BooksA', book('a1', 0)),
      group('EmptyX'),
      group('EmptyY'),
      group('BooksB', book('b1', 7)),
    ];
    const anchors = assignEmptyGroupAnchors(ordered);
    expect(anchors.get('EmptyX')).toBeCloseTo(7 / 3);
    expect(anchors.get('EmptyY')).toBeCloseTo((7 * 2) / 3);
  });

  it('treats loose books as anchored keys too', () => {
    const ordered: (Book | BooksGroup)[] = [
      book('free', 3),
      group('Empty'),
      group('BooksA', book('a1', 6)),
    ];
    const anchors = assignEmptyGroupAnchors(ordered);
    expect(anchors.get('Empty')).toBe(4.5); // halfway between loose(3) and group min(6)
  });

  it('manual sort then places the empty group in the gap it was assigned', () => {
    const sorter = createGroupSorter(LibrarySortByType.Manual, 'en');
    const groups: BooksGroup[] = [
      group('BooksA', book('a1', 0)),
      (() => {
        const g = group('Empty');
        g.manualOrder = 2.5;
        return g;
      })(),
      group('BooksB', book('b1', 5)),
    ];
    expect(groups.sort(sorter).map((g) => g.name)).toEqual(['BooksA', 'Empty', 'BooksB']);
  });

  it('uses the rebased indices for anchor gaps, not the stale book shelfIndex', () => {
    // A(book 0), EmptyY, B(book 2), C(book 5). Drag C just after A.
    const items: (Book | BooksGroup)[] = [
      group('A', book('a', 0)),
      group('EmptyY'),
      group('B', book('b', 2)),
      group('C', book('c', 5)),
    ];
    const { updated, ordered } = reorderShelfLayer(items, 'C', 'A', false);
    expect(ordered.map((i) => ('format' in i ? (i as Book).hash : (i as BooksGroup).name))).toEqual(
      ['A', 'C', 'EmptyY', 'B'],
    );
    const indices = new Map(updated.map((b) => [b.hash, b.shelfIndex ?? -1]));
    // Rebasing puts C at index 1, so the gap EmptyY sits in is (1, 2) → 1.5.
    expect(assignEmptyGroupAnchors(ordered, indices).get('EmptyY')).toBe(1.5);
    // With the stale shelfIndex (C=5, B=2) the gap math would yield 0.5 and
    // the displayed order would drift from the dragged order.
  });

  it('keeps an all-empty layer in the order it was dragged into', () => {
    const items: (Book | BooksGroup)[] = [group('1'), group('2'), group('3'), group('4')];
    const { ordered } = reorderShelfLayer(items, '1', '4', false);
    // 1 dropped right after 4 → dragged order 2,3,4,1.
    expect(ordered.map((i) => (i as BooksGroup).name)).toEqual(['2', '3', '4', '1']);
    const anchors = assignEmptyGroupAnchors(ordered);
    // With no book keys to reference, anchors fall back to the dragged order.
    expect(anchors.get('2')).toBe(0);
    expect(anchors.get('3')).toBe(1);
    expect(anchors.get('4')).toBe(2);
    expect(anchors.get('1')).toBe(3);
  });
});

describe('swapShelfUnits — drag model is a swap', () => {
  it('swaps two empty-group units across the layer, keeping the middle order', () => {
    const items: (Book | BooksGroup)[] = [group('1'), group('2'), group('3'), group('4')];
    const { updated, changed, ordered } = swapShelfUnits(items, '1', '4');
    expect(changed).toBe(true);
    // 1,2,3,4 → drag 1 onto 4 → 4,2,3,1, exactly the user's expected swap.
    expect(ordered.map((g) => (g as BooksGroup).name)).toEqual(['4', '2', '3', '1']);
    expect(updated).toEqual([]); // empty groups carry no books to rebase
    const anchors = assignEmptyGroupAnchors(ordered);
    expect([...anchors.values()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('swaps two book units', () => {
    const items = [book('a', 0), book('b', 1), book('c', 2)];
    const { updated, changed } = swapShelfUnits(items, 'a', 'c');
    expect(changed).toBe(true);
    expect(byIndex(updated)).toEqual(['c', 'b', 'a']);
  });

  it('re-anchors an empty group when it swaps with a book-backed group', () => {
    const items: (Book | BooksGroup)[] = [
      group('1'),
      group('2', book('b2', 1)),
      group('3'),
      group('4'),
    ];
    const { updated, changed, ordered } = swapShelfUnits(items, '1', '2');
    expect(changed).toBe(true);
    expect(ordered.map((g) => (g as BooksGroup).name)).toEqual(['2', '1', '3', '4']);
    const indices = new Map(updated.map((b) => [b.hash, b.shelfIndex ?? -1]));
    const anchors = assignEmptyGroupAnchors(ordered, indices);
    // Group 2's book rebases to 0; the three empty groups trail it in gap slots.
    expect(anchors.get('1')).toBe(0.5);
    expect(anchors.get('3')).toBe(1);
    expect(anchors.get('4')).toBe(1.5);
  });

  it('is a no-op for the same unit or an unknown one', () => {
    const items = [book('a', 0), book('b', 1)];
    expect(swapShelfUnits(items, 'a', 'a').changed).toBe(false);
    expect(swapShelfUnits(items, 'a', 'zzz').changed).toBe(false);
  });
});

describe('rebaseLayerAfterGroupMerge — remaining groups keep their pre-merge order', () => {
  const mk = (n: number): Book =>
    ({
      hash: `b${n}`,
      format: 'EPUB',
      title: `b${n}`,
      groupName: `${n}`,
      shelfIndex: n - 1,
      createdAt: 0,
      updatedAt: 0,
    }) as Book;

  // Top-level grouping: a book's immediate child segment is its top-level group
  // (mirrors generateBookshelfItems with an empty parent).
  const topLevelGroups = (bs: Book[]): BooksGroup[] => {
    const map = new Map<string, BooksGroup>();
    for (const b of bs) {
      const rel = b.groupName ?? '';
      const child = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : rel;
      const g = map.get(child) ?? {
        id: child,
        name: child,
        displayName: child,
        books: [],
        updatedAt: 0,
      };
      g.books.push(b);
      map.set(child, g);
    }
    return [...map.values()];
  };

  it('end-to-end: merging book group 1 into 5 keeps 2,3,4,5,6 order', () => {
    const books = [1, 2, 3, 4, 5, 6].map(mk);
    const merged = reassignToGroup(books, { kind: 'group', groupName: '1' }, '5').updated;
    const remainingItems = topLevelGroups(books).filter((g) => g.name !== '1');
    const { books: rebased } = rebaseLayerAfterGroupMerge(remainingItems, merged, '5/1');
    const idx = new Map(rebased.map((b) => [b.hash, b.shelfIndex ?? 0]));
    const groups = topLevelGroups(merged).map((g) => ({
      ...g,
      books: g.books.map((b) => ({ ...b, shelfIndex: idx.get(b.hash) ?? b.shelfIndex })),
    }));
    const sorter = createGroupSorter(LibrarySortByType.Manual, 'en');
    expect(groups.sort(sorter).map((g) => g.name)).toEqual(['2', '3', '4', '5', '6']);
  });

  it('keeps an empty-shell target group (no direct books) in place', () => {
    const sub = { hash: 'sub', groupName: '1/x', shelfIndex: 0 } as Book;
    const b2 = { hash: 'b2', groupName: '1/2', shelfIndex: 1 } as Book;
    const b3 = { hash: 'b3', groupName: '3', shelfIndex: 2 } as Book;
    const merged = [sub, b2, b3] as Book[];
    const remaining: (Book | BooksGroup)[] = [group('1', sub), group('3', b3)];
    const { books } = rebaseLayerAfterGroupMerge(remaining, merged, '1/2');
    const idx = new Map(books.map((b) => [b.hash, b.shelfIndex ?? 0]));
    // The merged b2 lands inside group 1's slot (after sub) — not at layer end.
    expect(idx.get('b2')!).toBeGreaterThan(idx.get('sub')!);
    expect(idx.get('b2')!).toBeLessThan(idx.get('b3')!);
  });

  it('re-anchors empty groups so the rest keep their order', () => {
    const groups: BooksGroup[] = [1, 2, 3, 4, 5, 6].map((n) => group(String(n)));
    const remaining = groups.filter((g) => g.name !== '1');
    const { books, anchors } = rebaseLayerAfterGroupMerge(remaining, [], '5/1');
    expect(books).toEqual([]);
    const sorted = remaining
      .map((g) => g.name)
      .sort((a, b) => (anchors.get(a) ?? 0) - (anchors.get(b) ?? 0));
    expect(sorted).toEqual(['2', '3', '4', '5', '6']);
  });
});

describe('relabelAnchorMap — anchors follow renamed group paths', () => {
  it('moves an old-path anchor to the new name', () => {
    const out = relabelAnchorMap({ '粉/收藏': 2, 白: 5 }, new Map([['粉/收藏', '收藏']]));
    expect(out).toEqual({ 收藏: 2, 白: 5 });
  });

  it('returns null when no anchor matches a relabeled path', () => {
    expect(relabelAnchorMap({ 白: 5 }, new Map([['粉/收藏', '收藏']]))).toBeNull();
    expect(relabelAnchorMap(undefined, new Map([['粉/收藏', '收藏']]))).toBeNull();
  });
});
