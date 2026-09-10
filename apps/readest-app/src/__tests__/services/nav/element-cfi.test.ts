// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildElementCfi, isCfiAddressable } from '@/services/nav/elementCfi';

const SECTION_CFI = 'epubcfi(/6/4)';

describe('elementCfi', () => {
  it('body 的严格后代可寻址，元素 CFI 以 section CFI 为前缀', () => {
    const doc = new DOMParser().parseFromString(
      '<html><body><p id="a">第一章</p></body></html>',
      'text/html',
    );
    const p = doc.getElementById('a')!;
    expect(isCfiAddressable(p)).toBe(true);
    const cfi = buildElementCfi(SECTION_CFI, p);
    expect(cfi.startsWith('epubcfi(/6/4!')).toBe(true);
    expect(cfi).not.toBe(SECTION_CFI);
  });

  it('body 本身与脱离 body 的元素回退 section CFI', () => {
    const doc = new DOMParser().parseFromString('<html><body><p>x</p></body></html>', 'text/html');
    expect(isCfiAddressable(doc.body!)).toBe(false);
    expect(buildElementCfi(SECTION_CFI, doc.body!)).toBe(SECTION_CFI);
    const detached = doc.createElement('p');
    expect(isCfiAddressable(detached)).toBe(false);
  });
});
