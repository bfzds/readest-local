import { describe, it, expect } from 'vitest';
import { buildAnnotationAppUrl, parseAnnotationDeepLink } from '../../utils/deeplink';

describe('buildAnnotationAppUrl', () => {
  const link = { bookHash: 'abc', noteId: 'n1', cfi: '/6/4!/4/2' };

  it('builds the custom-scheme app URL', () => {
    const url = buildAnnotationAppUrl(link);
    expect(url.startsWith('readest://book/abc/annotation/n1')).toBe(true);
  });

  it('preserves the cfi query', () => {
    const encoded = encodeURIComponent(link.cfi);
    expect(buildAnnotationAppUrl(link)).toContain(`cfi=${encoded}`);
  });

  it('omits the cfi query when no cfi is provided', () => {
    expect(buildAnnotationAppUrl({ bookHash: 'abc', noteId: 'n1' })).toBe(
      'readest://book/abc/annotation/n1',
    );
  });
});

describe('parseAnnotationDeepLink', () => {
  it('parses readest:// links and rejects web links', () => {
    expect(parseAnnotationDeepLink('readest://book/abc/annotation/n1')).toEqual({
      bookHash: 'abc',
      noteId: 'n1',
    });
    expect(parseAnnotationDeepLink('https://web.readest.com/o/book/abc/annotation/n1')).toBeNull();
  });
});
