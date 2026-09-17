/**
 * 正文字数：一段标记文本里的**非空白字符**数。
 *
 * 与 Rust 侧 `epub_parser.rs::count_non_whitespace_text` 逐条对齐——两侧的数字会
 * 并排出现在"导入的是不是旧版本"确认框里，口径必须一致，否则同一本书换个导入
 * 方式（直接导 EPUB vs 导 TXT 后转换成 EPUB）就会比出假差异。
 *
 * 规则：
 *  - 跳过注释、标签本身，以及 `<script>` / `<style>` / `<head>` 的内容；
 *  - `<head>` 一起跳过是为了 `<title>`：书名是元数据，算进正文会让两侧都凭空
 *    多出书名那几十个字；
 *  - 实体引用（`&amp;` 这类）算一个字符，不做解码表；
 *  - `<body>` 里的标题（`<h2>第一章</h2>`）**算**正文：章节标题确实占版面，
 *    Rust 侧也这么数。
 */
export const countNonWhitespaceText = (html: string): number => {
  const chars = [...html];
  let count = 0;
  let i = 0;
  while (i < chars.length) {
    const c = chars[i]!;
    if (c === '<') {
      if (chars.slice(i, i + 4).join('') === '<!--') {
        let j = i + 4;
        while (
          j + 2 < chars.length &&
          !(chars[j] === '-' && chars[j + 1] === '-' && chars[j + 2] === '>')
        ) {
          j += 1;
        }
        i = Math.min(j + 3, chars.length);
        continue;
      }
      // 取标签名本身再比对，别用前缀匹配：`<header>` 也会被 `<head` 前缀命中，
      // 那时后面的 `</head` 查找会把正文整段吞掉。
      const tagName = (() => {
        let name = '';
        for (let k = i + 1; k < chars.length; k += 1) {
          const ch = chars[k]!;
          if (!/[A-Za-z0-9]/.test(ch)) break;
          name += ch.toLowerCase();
        }
        return name;
      })();
      const skipTo =
        tagName === 'script'
          ? '</script'
          : tagName === 'style'
            ? '</style'
            : tagName === 'head'
              ? '</head'
              : undefined;
      // 标签可能带属性，属性值里也可能出现 '>'，按引号状态找真正的结束。
      let j = i + 1;
      let quote: string | undefined;
      while (j < chars.length) {
        const ch = chars[j]!;
        if (quote) {
          if (ch === quote) quote = undefined;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === '>') {
          break;
        }
        j += 1;
      }
      i = Math.min(j + 1, chars.length);
      if (skipTo) {
        const pos = findAsciiCaseInsensitive(chars, i, skipTo);
        if (pos !== undefined) i = pos;
      }
      continue;
    }
    if (c === '&') {
      // 实体引用算一个字符；找不到 ';' 或超出合理长度就当普通的 '&'。
      let j = i + 1;
      let terminated = false;
      while (j < chars.length && j - i <= 32) {
        const ch = chars[j]!;
        if (ch === ';') {
          terminated = true;
          break;
        }
        if (/\s/.test(ch) || ch === '<' || ch === '&') break;
        j += 1;
      }
      if (terminated) {
        count += 1;
        i = j + 1;
        continue;
      }
    }
    if (!/\s/.test(c)) count += 1;
    i += 1;
  }
  return count;
};

/** 大小写无关查找（不分配字符串：整章可能上百 KB，逐次小写化副本不划算）。 */
export const findAsciiCaseInsensitive = (
  chars: string[],
  from: number,
  needle: string,
): number | undefined => {
  const target = [...needle];
  if (target.length === 0 || chars.length < target.length) return undefined;
  const lastStart = chars.length - target.length;
  for (let i = from; i <= lastStart; i += 1) {
    let matched = true;
    for (let k = 0; k < target.length; k += 1) {
      if (chars[i + k]!.toLowerCase() !== target[k]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return undefined;
};
