/**
 * 章节结构净化：校验编辑前后文档的受保护结构完全一致，仅允许文本变化
 * 与 P/DIV/BR 块级元素的增删。任何其它元素（A、IMG、SPAN、SUP、H1-H6、
 * LI 等）的标签与属性集合、以及它们在文档中的相对顺序都必须与原文一致，
 * 否则抛错拒绝。
 */

// 允许增删的块级元素；其余元素标签+属性必须与原文完全一致
const EDITABLE_BLOCK_LEVEL = new Set(['P', 'DIV', 'BR']);

// jsdom 以 application/xhtml+xml 解析时 tagName 保留源码大小写（小写 p），
// 而 XHTML 惯例一律小写，故块级判断按大写归一；签名则保留原始 tagName，
// 使受保护元素仍保持 XML 大小写敏感。
const isEditableBlock = (el: Element): boolean =>
  EDITABLE_BLOCK_LEVEL.has(el.tagName.toUpperCase());

const elementSignature = (el: Element): string =>
  `${el.tagName}:${[...el.attributes]
    .map((a) => `${a.name}=${a.value}`)
    .sort()
    .join('|')}`;

const collectProtectedElements = (body: HTMLElement): Element[] =>
  [...body.querySelectorAll('*')].filter((el) => !isEditableBlock(el));

const parseXhtml = (html: string): Document => {
  const doc = new DOMParser().parseFromString(html, 'application/xhtml+xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XHTML');
  return doc;
};

export const serializeEditedSection = (originalHtml: string, editedHtml: string): string => {
  const original = parseXhtml(originalHtml);
  const edited = parseXhtml(editedHtml);
  // 校验：可编辑块级元素之外的受保护元素，其【按文档序的序列】必须与原文完全一致
  // （既保证存在性/属性不变，也保证相对顺序不变——顺序也是不可变结构）
  const originalSeq = collectProtectedElements(original.body).map(elementSignature);
  const editedSeq = collectProtectedElements(edited.body).map(elementSignature);
  if (
    originalSeq.length !== editedSeq.length ||
    originalSeq.some((sig, i) => sig !== editedSeq[i])
  ) {
    throw new Error('Only text edits are supported');
  }
  return new XMLSerializer().serializeToString(edited);
};
