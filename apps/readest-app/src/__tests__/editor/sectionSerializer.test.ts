import { describe, expect, it } from 'vitest';

import { serializeEditedSection } from '@/app/reader/editor/sectionSerializer';

const original = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Chapter</title></head>
  <body>
    <p>Hello <a href="note.html#1">note</a> world.</p>
    <p>Second paragraph with <sup class="fn">1</sup>.</p>
    <img src="cover.jpg" alt="cover"/>
  </body>
</html>`;

describe('serializeEditedSection', () => {
  it('accepts text changes and paragraph-level edits', () => {
    const edited = original.replace('Hello', 'Edited text');
    const result = serializeEditedSection(original, edited);
    expect(result).toContain('Edited text');
  });

  it('rejects inserting a protected element such as an image', () => {
    const edited = original.replace('</body>', '<img src="x.jpg"/></body>');
    expect(() => serializeEditedSection(original, edited)).toThrow('Only text edits are supported');
  });

  it('rejects deleting a link structure', () => {
    const edited = original.replace('<a href="note.html#1">note</a>', 'note');
    expect(() => serializeEditedSection(original, edited)).toThrow('Only text edits are supported');
  });

  it('rejects reordering protected elements such as moving an image paragraph', () => {
    // 把两个 <p> 段落整体交换：受保护元素（A、SUP、IMG）的文档序序列会从
    // [A, SUP, IMG] 变成 [SUP, A, IMG]，即使所有元素本身都仍然存在也必须拒绝。
    const edited = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Chapter</title></head>
  <body>
    <p>Second paragraph with <sup class="fn">1</sup>.</p>
    <p>Hello <a href="note.html#1">note</a> world.</p>
    <img src="cover.jpg" alt="cover"/>
  </body>
</html>`;
    expect(() => serializeEditedSection(original, edited)).toThrow('Only text edits are supported');
  });
});
