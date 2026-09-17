import { describe, it, expect } from 'vitest';
import { Book, BookFormat } from '@/types/book';
import {
  findBookVersionCandidates,
  getBookVersionIdentities,
  getBookVersionIndexKey,
  isSameBookVersion,
  normalizeVersionAuthor,
  normalizeVersionPart,
} from '@/utils/book';

const FORMAT: BookFormat = 'EPUB';

function makeBook(overrides: Partial<Book> = {}): Book {
  return {
    hash: 'hash-1',
    format: FORMAT,
    title: '三体',
    author: '刘慈欣',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('normalizeVersionPart', () => {
  it('strips wrapping brackets and quotes so 《三体》 matches 三体', () => {
    expect(normalizeVersionPart('《三体》')).toBe('三体');
    expect(normalizeVersionPart('【三体】')).toBe('三体');
    expect(normalizeVersionPart('「三体」')).toBe('三体');
    expect(normalizeVersionPart('(三体)')).toBe('三体');
    expect(normalizeVersionPart('《【三体】》')).toBe('三体');
  });

  it('normalizes Unicode form, whitespace and case', () => {
    expect(normalizeVersionPart('  The  Great   Gatsby ')).toBe('thegreatgatsby');
    // NFC folding: "é" as e + combining accent must equal the precomposed form.
    expect(normalizeVersionPart('Cafe\u0301')).toBe(normalizeVersionPart('Café'));
  });

  it('keeps interior punctuation so different volumes stay distinct', () => {
    expect(normalizeVersionPart('三体II')).not.toBe(normalizeVersionPart('三体'));
    expect(normalizeVersionPart('斗破苍穹·第一部')).not.toBe(
      normalizeVersionPart('斗破苍穹·第二部'),
    );
  });

  // 只剥"成对"的包裹符：单独剥两端会把「三体（重命名）」啃成「三体（重命名」。
  it('does not mangle a title with unbalanced brackets', () => {
    expect(normalizeVersionPart('三体（重命名）')).toBe('三体（重命名）');
    expect(normalizeVersionPart('三体》')).toBe('三体》');
  });

  it('returns an empty string for missing text', () => {
    expect(normalizeVersionPart(undefined)).toBe('');
    expect(normalizeVersionPart('   ')).toBe('');
  });
});

describe('normalizeVersionAuthor', () => {
  it('keeps only the first author of a formatted list', () => {
    expect(normalizeVersionAuthor('刘慈欣, 张三')).toBe('刘慈欣');
    expect(normalizeVersionAuthor('刘慈欣、张三')).toBe('刘慈欣');
    expect(normalizeVersionAuthor('刘慈欣; 张三')).toBe('刘慈欣');
  });

  it('returns an empty string when the author is unknown', () => {
    expect(normalizeVersionAuthor('')).toBe('');
    expect(normalizeVersionAuthor(undefined)).toBe('');
  });
});

describe('getBookVersionIdentities', () => {
  it('indexes both the editable title and the import-time title', () => {
    const identities = getBookVersionIdentities({
      title: '三体（重命名）',
      sourceTitle: '三体',
      author: '刘慈欣',
      format: FORMAT,
    });
    expect(identities).toHaveLength(2);
    expect(identities.map((identity) => identity.titleKey)).toEqual(['三体（重命名）', '三体']);
  });

  it('drops a book without any usable title', () => {
    expect(getBookVersionIdentities({ title: '', author: 'x', format: FORMAT })).toEqual([]);
  });

  it('builds a probe key from title and format only', () => {
    const [identity] = getBookVersionIdentities(makeBook());
    expect(getBookVersionIndexKey(identity!)).toBe('三体|EPUB');
  });
});

describe('isSameBookVersion', () => {
  const identity = (overrides: Partial<Book> = {}) =>
    getBookVersionIdentities({ ...makeBook(), ...overrides })[0]!;

  it('matches on equal title and author', () => {
    expect(isSameBookVersion(identity(), identity({ hash: 'hash-2' }))).toBe(true);
  });

  it('matches on title alone when either side has no author', () => {
    expect(isSameBookVersion(identity(), identity({ author: '' }))).toBe(true);
    expect(isSameBookVersion(identity({ author: '' }), identity())).toBe(true);
  });

  it('rejects differing authors, titles and formats', () => {
    expect(isSameBookVersion(identity(), identity({ author: '张三' }))).toBe(false);
    expect(isSameBookVersion(identity(), identity({ title: '三体II' }))).toBe(false);
    expect(isSameBookVersion(identity(), identity({ format: 'PDF' as BookFormat }))).toBe(false);
  });
});

describe('findBookVersionCandidates', () => {
  it('finds another release of the same book and skips tombstones', () => {
    const books = [
      makeBook({ hash: 'old' }),
      makeBook({ hash: 'deleted', deletedAt: Date.now() }),
      makeBook({ hash: 'other', title: '球状闪电' }),
    ];
    const candidates = findBookVersionCandidates(books, {
      title: '《三体》',
      author: '刘慈欣',
      format: FORMAT,
      hash: 'new',
    });
    expect(candidates.map((book) => book.hash)).toEqual(['old']);
  });

  it('never returns the incoming file itself', () => {
    const books = [makeBook({ hash: 'same' })];
    expect(
      findBookVersionCandidates(books, {
        title: '三体',
        author: '刘慈欣',
        format: FORMAT,
        hash: 'same',
      }),
    ).toEqual([]);
  });
});
