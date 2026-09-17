import { describe, it, expect } from 'vitest';
import { getProgressFraction, isResolvableLocation } from '@/app/reader/components/FoliateViewer';
import type { FoliateView } from '@/types/view';

const fakeView = (resolve: () => { index: number }): FoliateView =>
  ({ resolveCFI: resolve }) as unknown as FoliateView;

describe('isResolvableLocation', () => {
  it('accepts a CFI that resolves to a spine item in the current file', () => {
    expect(
      isResolvableLocation(
        fakeView(() => ({ index: 4 })),
        'epubcfi(/6/14!/4/2/2[c05]/1:0)',
      ),
    ).toBe(true);
  });

  // The case a replaced release creates: the CFI still parses but addresses a
  // spine item that no longer exists, and foliate reports index -1.
  it('rejects a CFI that resolves to no spine item', () => {
    expect(
      isResolvableLocation(
        fakeView(() => ({ index: -1 })),
        'epubcfi(/6/90!/4)',
      ),
    ).toBe(false);
  });

  it('rejects a CFI the parser throws on', () => {
    expect(
      isResolvableLocation(
        fakeView(() => {
          throw new Error('invalid CFI');
        }),
        'epubcfi(/6/90!)',
      ),
    ).toBe(false);
  });

  it('leaves non-CFI targets to the view', () => {
    const throwingView = fakeView(() => {
      throw new Error('should not be probed');
    });
    expect(isResolvableLocation(throwingView, 'OEBPS/chapter1.xhtml')).toBe(true);
  });
});

describe('getProgressFraction', () => {
  it('converts the stored page progress to a fraction', () => {
    expect(getProgressFraction([40, 200])).toBeCloseTo(0.2);
  });

  it('clamps and degrades gracefully on missing or bogus values', () => {
    expect(getProgressFraction(undefined)).toBe(0);
    expect(getProgressFraction([0, 0])).toBe(0);
    expect(getProgressFraction([300, 200])).toBe(1);
    expect(getProgressFraction([0, 200])).toBe(0);
  });
});
