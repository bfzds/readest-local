import { describe, it, expect } from 'vitest';

import { getFolderImportGroupName, isDateLikeSegment } from '@/utils/path';

const PIXIV = 'C:\\Downloads\\Pixiv';

/**
 * Issue: a Pixiv-style download tree is `<root>/<date>/<author>/<book>`, so
 * mirroring it produces a group per download day instead of one per author.
 * The `author` mode keeps the watched folder plus the first level that is not a
 * date, wherever that level sits.
 */
describe('getFolderImportGroupName — author mode', () => {
  const author = (filePath: string, basePath = PIXIV) =>
    getFolderImportGroupName(filePath, basePath, { mode: 'author' });

  it('skips a leading download-date level', () => {
    expect(author(`${PIXIV}\\2025-01-01\\AuthorA\\novel.txt`)).toBe('Pixiv/AuthorA');
  });

  it('skips a date level sitting below the author', () => {
    expect(author(`${PIXIV}\\AuthorA\\2025-01-01\\novel.txt`)).toBe('Pixiv/AuthorA');
  });

  it('falls back to the folder itself when there is no author level', () => {
    expect(author(`${PIXIV}\\2025-01-01\\novel.txt`)).toBe('Pixiv');
    expect(author(`${PIXIV}\\novel.txt`)).toBe('Pixiv');
  });

  it('drops anything deeper than the author level', () => {
    expect(author(`${PIXIV}\\AuthorA\\Series\\novel.txt`)).toBe('Pixiv/AuthorA');
    expect(author(`${PIXIV}\\2025-01-01\\AuthorA\\Series\\novel.txt`)).toBe('Pixiv/AuthorA');
  });

  it('produces the same names from POSIX paths', () => {
    expect(
      getFolderImportGroupName('/lib/Pixiv/2025-01-01/AuthorA/novel.txt', '/lib/Pixiv', {
        mode: 'author',
      }),
    ).toBe('Pixiv/AuthorA');
  });

  it('keeps a numeric author id that is not a date', () => {
    expect(author(`${PIXIV}\\2025-01-01\\12345678\\novel.txt`)).toBe('Pixiv/12345678');
  });

  it('falls back to the mirrored name for a file outside the watched folder', () => {
    // Wrong input rather than a real case: a wrong-but-harmless group beats
    // throwing in the middle of an import.
    expect(author('/elsewhere/AuthorA/novel.txt', '/lib/Pixiv')).toBe('elsewhere/AuthorA');
  });
});

describe('getFolderImportGroupName — mirror and flat modes', () => {
  it('mirrors exactly like the two-argument form', () => {
    const filePath = `${PIXIV}\\2025-01-01\\AuthorA\\novel.txt`;

    expect(getFolderImportGroupName(filePath, PIXIV, { mode: 'mirror' })).toBe(
      getFolderImportGroupName(filePath, PIXIV),
    );
    expect(getFolderImportGroupName(filePath, PIXIV)).toBe('Pixiv/2025-01-01/AuthorA');
  });

  it('returns no group at all when flattened', () => {
    expect(getFolderImportGroupName(`${PIXIV}\\AuthorA\\novel.txt`, PIXIV, { mode: 'flat' })).toBe(
      '',
    );
  });

  it('gives a book loose in the watched folder its own group', () => {
    expect(getFolderImportGroupName(`${PIXIV}\\novel.txt`, PIXIV)).toBe('Pixiv');
  });
});

describe('getFolderImportGroupName — watched root is itself the author folder', () => {
  const AUTHOR_ROOT = 'C:\\Downloads\\AuthorA';
  const author = (filePath: string, basePath = AUTHOR_ROOT) =>
    getFolderImportGroupName(filePath, basePath, { mode: 'author' });

  it('names the group after the watched folder when the only level below is a date', () => {
    expect(author(`${AUTHOR_ROOT}\\2025-01-01\\novel.epub`)).toBe('AuthorA');
  });

  it('names the group after the watched folder for a file sitting directly in it', () => {
    expect(author(`${AUTHOR_ROOT}\\novel.epub`)).toBe('AuthorA');
  });

  it('keeps single-segment and drive-letter roots free of leading slashes and empty segments', () => {
    expect(getFolderImportGroupName('/lib/AuthorA/novel.epub', '/lib', { mode: 'author' })).toBe(
      'lib/AuthorA',
    );
    // The drive itself becomes the top-level group: no leading slash, no
    // empty segment between the drive and the author.
    expect(getFolderImportGroupName('C:\\AuthorA\\novel.epub', 'C:\\', { mode: 'author' })).toBe(
      'C:/AuthorA',
    );
  });
});

describe('isDateLikeSegment — suffixed date folders', () => {
  // Windows appends " (2)" when a download re-creates an existing date folder;
  // that is the same day's folder, not an author, so it counts as a date.
  it.each([
    '2025-01-01 (2)',
    '2025-01-01 (10)',
    '20250101 (2)',
    '2025年1月1日 (2)',
  ])('recognizes the dedup-suffixed date %s', (segment) => {
    expect(isDateLikeSegment(segment)).toBe(true);
  });

  // Free-form suffixes stay unrecognized on purpose: nothing tells
  // "2025-01-01_backup" apart from an author folder that merely starts with a
  // date, and getting it wrong buries a whole author level.
  it.each([
    '2025-01-01_backup',
    '20250101_backup',
    '2025-01-01(2)extra',
  ])('does not recognize %s', (segment) => {
    expect(isDateLikeSegment(segment)).toBe(false);
  });
});

describe('isDateLikeSegment', () => {
  it.each([
    '2025-01-01',
    '2025-1-1',
    '2025.01.01',
    '2025_01_01',
    '20250101',
    '1999-12-31',
    '2025年1月1日',
    '2025年12月31日',
    '2026-09-18',
  ])('recognizes %s', (segment) => {
    expect(isDateLikeSegment(segment)).toBe(true);
  });

  it.each([
    // Pixiv user ids: 7–10 digits, and an 8-digit one can look like YYYYMMDD.
    '12345678',
    '1234567',
    '123456789',
    '1234567890',
    // A year or year-month bucket is not a download date.
    '2025',
    '2025-01',
    '202501',
    // The compact form still has to be a real month and day.
    '20251301',
    '20250001',
    '20250132',
    '2025010112',
    // Anything that is not date-shaped at all.
    'Pixiv',
    'AuthorA',
    '',
    '  ',
  ])('rejects %s', (segment) => {
    expect(isDateLikeSegment(segment)).toBe(false);
  });

  it('tolerates surrounding whitespace', () => {
    expect(isDateLikeSegment(' 2025-01-01 ')).toBe(true);
  });
});
