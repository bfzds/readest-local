import { describe, expect, it } from 'vitest';

import { getContextMenuPosition } from '@/app/library/components/BookContextMenuPopup';

/**
 * The context menu is anchored at the pointer, flipping to the other side of
 * the pointer when it would run off the right/bottom edge and clamping to
 * `bounds` as a last resort (matches native context-menu behaviour).
 */
describe('getContextMenuPosition', () => {
  const bounds = { left: 0, top: 0, right: 800, bottom: 600 };

  it('places the menu top-left at the pointer when it fits', () => {
    expect(getContextMenuPosition({ x: 100, y: 100 }, { width: 200, height: 300 }, bounds)).toEqual(
      { left: 100, top: 100 },
    );
  });

  it('flips to the left when it would overflow the right edge', () => {
    expect(getContextMenuPosition({ x: 700, y: 100 }, { width: 200, height: 300 }, bounds)).toEqual(
      { left: 500, top: 100 },
    );
  });

  it('flips above when it would overflow the bottom edge', () => {
    expect(getContextMenuPosition({ x: 100, y: 500 }, { width: 200, height: 300 }, bounds)).toEqual(
      { left: 100, top: 200 },
    );
  });

  it('clamps to the bounds as a last resort', () => {
    expect(getContextMenuPosition({ x: 800, y: 600 }, { width: 200, height: 300 }, bounds)).toEqual(
      { left: 600, top: 300 },
    );
  });
});
