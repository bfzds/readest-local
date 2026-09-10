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
