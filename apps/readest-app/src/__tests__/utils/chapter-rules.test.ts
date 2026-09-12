import { describe, expect, it } from 'vitest';
import {
  CHAPTER_CANDIDATE_TITLE_RX,
  buildChapterRegexps,
  matchChapterTitle,
  validateChapterPattern,
} from '@/utils/chapterRules';

describe('chapterRules 共享引擎', () => {
  it('内置 zh 规则可整行匹配“第X章”样式标题', () => {
    const regexps = buildChapterRegexps('zh');
    expect(matchChapterTitle('第12章 大战之前', regexps)).toBeTruthy();
    expect(matchChapterTitle('这是普通正文段落', regexps)).toBeNull();
  });

  it('用户规则优先于内置规则', () => {
    const regexps = buildChapterRegexps('zh', ['【[一二三四五六七八九十]+】[^\\n]{0,20}']);
    expect(matchChapterTitle('【一】开端', regexps)).toBe('【一】开端');
  });

  // R43：缓存键原本用 join('')，['ab','c'] 与 ['a','bc'] 塌缩成同一个键 →
  // 第二次 build 命中缓存、拿到第一份规则集，两套 patterns 互相串台。
  // parseChapterPatterns 按行切分、正则源不含换行，join('\n') 无碰撞面。
  it('不同 patterns 数组产生不同规则集，不因缓存键塌缩而互串', () => {
    const first = buildChapterRegexps('zh', ['ab', 'c']);
    const second = buildChapterRegexps('zh', ['a', 'bc']);
    // 'bctest' 只该被第二套的第二条规则（bc）命中；若缓存互串，拿到的是第一套
    // 规则（ab / c），对 'bctest' 返回 null。
    expect(matchChapterTitle('bctest', second)).toBe('bc');
    // 反向钉住：第一套规则集未被后续调用污染。
    expect(matchChapterTitle('ab x', first)).toBe('ab');
    expect(matchChapterTitle('c d', first)).toBe('c');
  });

  // 缓存契约：chapterRegexpCache 存的是规则源（{ source, flags } 数据），命中
  // 缓存时逐条 new RegExp 重建，而非存取 RegExp 实例——RegExp 带 lastIndex 的
  // 有状态对象，实例被多 segment / 多实例共享会因 .test()/exec 的顺序依赖互相
  // 污染（见 chapterRules.ts 缓存定义处注释）。缓存 Map 是模块私有，这里用行为
  // 断言钉住契约：命中缓存重建出的规则与首建逐字段同源，但实例状态干净归零。
  it('缓存存规则源而非 RegExp 实例：命中缓存重建同源规则、状态归零', () => {
    const first = buildChapterRegexps('zh', ['第\\d+章']);
    // 把首建实例的状态弄脏：g 标志正则手动推进 lastIndex
    first.forEach((rx) => {
      if (rx.global) rx.lastIndex = 42;
    });
    const second = buildChapterRegexps('zh', ['第\\d+章']);
    expect(second).toHaveLength(first.length);
    first.forEach((rx, i) => {
      // 规则源逐字段同源：缓存保留的是 { source, flags } 数据，能完整重建
      expect(second[i]!.source).toBe(rx.source);
      expect(second[i]!.flags).toBe(rx.flags);
      // 实例全新：首建实例的脏 lastIndex 没有跟着缓存走
      expect(second[i]!.lastIndex).toBe(0);
    });
  });

  it('同一入参连续两次 build 返回不同 RegExp 实例（不共享 lastIndex）', () => {
    const first = buildChapterRegexps('zh');
    const second = buildChapterRegexps('zh');
    expect(second).toHaveLength(first.length);
    first.forEach((rx, i) => {
      expect(second[i]).not.toBe(rx);
    });
    // 直证：first 的 g 正则 exec 推进 lastIndex 之后，second 的同位规则仍能从
    // 头匹配同一文本——若两次 build 共享同一实例，这条会因 lastIndex 已停在
    // 上次匹配末尾而返回 null。
    expect(first[0]!.exec('第12章 大战')).toBeTruthy();
    expect(second[0]!.exec('第12章 大战')).toBeTruthy();
  });

  it('ReDoS 病态正则被安全忽略', () => {
    expect(validateChapterPattern('(a+)+b').length).toBeGreaterThan(0);
    const regexps = buildChapterRegexps('zh', ['(a+)+b']);
    expect(() => matchChapterTitle('第1章', regexps)).not.toThrow();
  });

  it('候选行正则仍以标题引导字开头判定', () => {
    expect(CHAPTER_CANDIDATE_TITLE_RX.test('【一】开端')).toBe(true);
    expect(CHAPTER_CANDIDATE_TITLE_RX.test('本章说：感谢打赏')).toBe(false);
  });
});
