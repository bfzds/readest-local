import { describe, test, expect } from 'vitest';
import { Overlayer } from 'foliate-js/overlayer.js';

describe('Overlayer.highlight', () => {
  test('merges all line rects into a single path (no per-line elements)', () => {
    const rects = [
      { left: 10, top: 20, height: 18, width: 100 },
      { left: 10, top: 38, height: 18, width: 80 },
      { left: 10, top: 56, height: 18, width: 120 },
    ];
    const g = Overlayer.highlight(rects, { color: 'red' });
    expect(g.querySelectorAll('rect').length).toBe(0);
    expect(g.querySelectorAll('path').length).toBe(1);
    const d = g.querySelector('path')!.getAttribute('d')!;
    expect((d.match(/Z/g) ?? []).length).toBe(3);
  });

  test('rounded first/last lines are merged into one path too', () => {
    const rects = [
      { left: 10, top: 20, height: 18, width: 100 },
      { left: 10, top: 38, height: 18, width: 100 },
    ];
    const g = Overlayer.highlight(rects, { color: 'red', radius: 4, radiusPadding: 2 });
    const paths = g.querySelectorAll('path');
    expect(paths.length).toBe(1);
    const d = paths[0]!.getAttribute('d')!;
    expect((d.match(/Z/g) ?? []).length).toBe(2);
  });

  test('empty rects produce an empty group', () => {
    const g = Overlayer.highlight([], { color: 'red' });
    expect(g.querySelectorAll('path').length).toBe(0);
    expect(g.querySelectorAll('rect').length).toBe(0);
  });
});
