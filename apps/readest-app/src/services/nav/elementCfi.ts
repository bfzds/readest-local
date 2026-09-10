import { CFI } from '@/libs/document';

type CFIModule = {
  joinIndir: (...xs: string[]) => string;
  fromElements: (elements: Element[]) => string[];
};

// foliate-js's `fromElements` walks `parentNode` chain via repeated calls to
// `nodeToParts(parentNode)`. The termination check (epubcfi.js line 281) is
// "stop when current node's parentNode === documentElement", which means
// recursion stops AT `<body>` (parent is `<html>`/documentElement) but NOT at
// `<html>` itself (parent is the Document, which !== documentElement, so it
// recurses one more level into the Document, then tries indexChildNodes on
// Document.parentNode === null → "null is not an object (evaluating
// 'node.childNodes')").
//
// Concretely it blows up when:
//   - element is `documentElement` itself,
//   - element is `<body>` itself (recursion starts at `<html>` and overshoots),
//   - element is detached / parentNode === null,
//   - element lives outside <body> (e.g. ids on <head>) — even when it
//     wouldn't crash, the CFI it would produce is meaningless for our use.
//
// Reject these up-front so we silently fall back to the section CFI instead
// of throwing + spamming console.warn for every fragment.
export const isCfiAddressable = (element: Element): boolean => {
  const doc = element.ownerDocument;
  if (!doc) return false;
  if (element === doc.documentElement) return false;
  const body = doc.body;
  if (!body) return false;
  // Must be a STRICT descendant of <body>. Body itself overshoots the
  // foliate-js termination check (see comment above).
  if (element === body) return false;
  if (!body.contains(element)) return false;
  // Defensive: parentNode chain must reach <body> without hitting null first.
  // Covers detached subtrees and weird DOMs where contains() lies.
  let cursor: Node | null = element.parentNode;
  while (cursor && cursor !== body) {
    cursor = cursor.parentNode;
  }
  return cursor === body;
};

export const buildElementCfi = (sectionCfi: string, element: Element | null): string => {
  const cfiLib = CFI as unknown as CFIModule;
  if (!element || !isCfiAddressable(element)) {
    return sectionCfi;
  }
  try {
    const rel = cfiLib.fromElements([element])[0] ?? '';
    return cfiLib.joinIndir(sectionCfi, rel);
  } catch (e) {
    console.warn('Failed to build CFI for fragment, falling back to section CFI:', e);
    return sectionCfi;
  }
};
