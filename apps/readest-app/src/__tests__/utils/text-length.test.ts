import { describe, expect, it } from 'vitest';
import { countNonWhitespaceText } from '@/utils/textLength';

/**
 * 正文字数是版本对比弹窗里"哪边更新"最可靠的弱信号，两侧口径必须一致：
 * TXT 侧走这个函数，EPUB 侧走 Rust 的 `count_non_whitespace_text`，实现逐条对齐。
 */
describe('countNonWhitespaceText', () => {
  it('counts text and skips markup', () => {
    // Hello(5) + 世界(2) = 7；<p>/</p> 与换行都不算。
    expect(countNonWhitespaceText('<p>Hello 世界</p>')).toBe(7);
  });

  it('skips comments', () => {
    expect(countNonWhitespaceText('<!-- 注释里的字不算 -->正文')).toBe(2);
  });

  it('skips script, style and head content', () => {
    expect(countNonWhitespaceText('<head><title>书名</title></head>正文')).toBe(2);
    expect(countNonWhitespaceText('<style>p{color:red}</style>正文')).toBe(2);
    expect(countNonWhitespaceText('<script>var x = 1;</script>正文')).toBe(2);
  });

  // `<header>` 与 `<head` 前缀相同：按标签名比对，否则会从 `<header>` 一路跳到
  // `</head`，把夹在中间的真实正文吞掉。此处 甲 与 乙 都该计入、只跳过 head。
  it('does not mistake <header> for <head>', () => {
    expect(countNonWhitespaceText('<header>甲</header><head><title>T</title></head>乙')).toBe(2);
  });

  it('counts an entity reference as one character', () => {
    // "&" (1) + 世界(2)
    expect(countNonWhitespaceText('<p>&amp;世界</p>')).toBe(3);
    expect(countNonWhitespaceText('<p>&#20013;文</p>')).toBe(2);
  });

  // 属性值里的 '>' 不是标签结束——按引号状态跳过的实现必须认出来。
  it('handles a quoted angle bracket inside an attribute', () => {
    expect(countNonWhitespaceText('<img alt="a > b" src="x.png"/>ab')).toBe(2);
  });

  // 章节标题在 <body> 里，占版面，与 Rust 侧一样计入正文。
  it('counts body headings as body text', () => {
    expect(countNonWhitespaceText('<h2>第一章 开始</h2><p>正文甲乙丙丁</p>')).toBe(11);
  });

  it('ignores whitespace layout entirely', () => {
    const compact = '<h2>第一章</h2><p>甲乙丙丁</p>';
    const pretty = '<h2>\n  第一章\n</h2>\n\n<p>\n  甲乙\n  丙丁\n</p>\n';
    expect(countNonWhitespaceText(pretty)).toBe(countNonWhitespaceText(compact));
  });

  it('returns 0 for empty or whitespace-only input', () => {
    expect(countNonWhitespaceText('')).toBe(0);
    expect(countNonWhitespaceText('  \n\t ')).toBe(0);
  });
});
