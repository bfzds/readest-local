import { beforeAll } from 'vitest';
import { appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import { Overlayer } from 'foliate-js/overlayer.js';

// 性能评估：搜索匹配遮罩（Overlayer.highlight）对比原红色方框（Overlayer.outline）
// 的 SVG 元素构造耗时。rect 数 = 匹配文本的 getClientRects 片段数（匹配数×行数）。
// 结果写入临时文件（vitest 静默 console.log）。
const OUT = join(tmpdir(), 'search-highlight-perf.txt');
const line = (text: string) => appendFileSync(OUT, `${text}\n`);

const makeRects = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    left: 10,
    top: i * 20,
    right: 110,
    bottom: i * 20 + 18,
    width: 100,
    height: 18,
  }));

const measureMedian = (fn: () => void, rounds = 50) => {
  fn(); // warmup
  const times: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
};

describe('搜索遮罩性能评估（highlight vs outline）', () => {
  beforeAll(() => rmSync(OUT, { force: true }));

  it.each([10, 100, 1000, 5000, 10000])('构造 %i 个 rect 的耗时对比', (n) => {
    const rounds = n > 1000 ? 8 : 50;
    const rects = makeRects(n);
    const highlightMs = measureMedian(() => Overlayer.highlight(rects, { color: 'red' }), rounds);
    const outlineMs = measureMedian(() => Overlayer.outline(rects, { color: 'red' }), rounds);
    line(
      `N=${n} rect | highlight(遮罩) ${highlightMs.toFixed(3)}ms | outline(方框) ${outlineMs.toFixed(3)}ms | 差值 ${(highlightMs - outlineMs).toFixed(3)}ms`,
    );
  }, 60000);
});
