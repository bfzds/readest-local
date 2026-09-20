import { BookMetadata, CalibreCustomColumn, EXTS } from '@/libs/document';
import {
  Book,
  BOOK_CONFIG_SCHEMA_VERSION,
  BookConfig,
  BookFormat,
  BookProgress,
  WritingMode,
} from '@/types/book';
import { SUPPORTED_LANGS } from '@/services/constants';
import { getLocale, getUserLang, makeSafeFilename } from './misc';
import { getDirFromLanguage } from './rtl';
import { code6392to6391, isValidLang, normalizedLangCode } from './lang';
import { md5 } from './md5';

export const getDir = (book: Book) => {
  return `${book.hash}`;
};

/**
 * The `<hash>` dir a Books/-relative path lives in, or undefined for a
 * root-level file (library metadata). Accepts host separators, so a Windows
 * `readDirectory` path (`hash\cover.png`) resolves the same as a POSIX one.
 */
export const getBookDirOfPath = (path: string) => {
  const normalized = path.replace(/\\/g, '/');
  const slashIdx = normalized.indexOf('/');
  return slashIdx < 0 ? undefined : normalized.slice(0, slashIdx);
};

/**
 * TXT 先查重后转换：按原始 TXT 的 partialMD5 匹配已入库的 TXT 转换产物。
 * soft-deleted 条目不参与匹配——重导应走完整路径复活并重建文件。
 */
export const findTxtDedupMatch = (books: Book[], txtSourceHash: string): Book | undefined =>
  books.find((b) => !b.deletedAt && b.sourceHash === txtSourceHash);
export const getLibraryFilename = () => {
  return 'library.json';
};
export const getLibraryBackupFilename = () => {
  return 'library_backup.json';
};
export const getLocalBookFilename = (book: Book) => {
  return `${book.hash}/${makeSafeFilename(book.sourceTitle || book.title)}.${EXTS[book.format]}`;
};
export const getCoverFilename = (book: Book) => {
  return `${book.hash}/cover.png`;
};
export const getConfigFilename = (book: Book) => {
  return `${book.hash}/config.json`;
};
export const getBookNavFilename = (book: Book) => {
  return `${book.hash}/nav.json`;
};
export const isBookFile = (filename: string) => {
  return Object.values(EXTS).includes(filename.split('.').pop()!);
};

export const INIT_BOOK_CONFIG: BookConfig = {
  schemaVersion: BOOK_CONFIG_SCHEMA_VERSION,
  updatedAt: 0,
};

export interface LanguageMap {
  [key: string]: string;
}

export interface Identifier {
  scheme: string;
  value: string;
}

export interface Contributor {
  name: LanguageMap;
}

export interface Collection {
  name: string;
  position?: string;
  total?: string;
}

const formatLanguageMap = (x: string | LanguageMap, defaultLang = false): string => {
  const userLang = getUserLang();
  if (!x) return '';
  if (typeof x === 'string') return x;
  const keys = Object.keys(x);
  return defaultLang ? x[keys[0]!]! : x[userLang] || x[keys[0]!]!;
};

export const listFormater = (narrow = false, lang = '') => {
  lang = lang ? lang : getUserLang();
  if (narrow) {
    return new Intl.ListFormat('en', { style: 'narrow', type: 'unit' });
  } else {
    return new Intl.ListFormat(lang, { style: 'long', type: 'conjunction' });
  }
};

export const getBookLangCode = (lang: string | string[] | undefined) => {
  try {
    const bookLang = typeof lang === 'string' ? lang : lang?.[0];
    return bookLang ? bookLang.split('-')[0]! : '';
  } catch {
    return '';
  }
};

export const flattenContributors = (
  contributors: string | string[] | Contributor | Contributor[],
) => {
  if (!contributors) return '';
  return Array.isArray(contributors)
    ? contributors
        .map((contributor) =>
          typeof contributor === 'string' ? contributor : formatLanguageMap(contributor?.name),
        )
        .join(', ')
    : typeof contributors === 'string'
      ? contributors
      : formatLanguageMap(contributors?.name);
};

export const getContributorNames = (
  contributors: string | string[] | Contributor | Contributor[] | undefined,
): string[] => {
  if (!contributors) return [];
  const values = Array.isArray(contributors) ? contributors : [contributors];
  return [...new Set(values.map((value) => flattenContributors(value).trim()).filter(Boolean))];
};

// biome-ignore format: keep the language codes compact on a single line
const LASTNAME_AUTHOR_SORT_LANGS = [ 'ar', 'bo', 'de', 'en', 'es', 'fr', 'hi', 'it', 'nl', 'pl', 'pt', 'ru', 'th', 'tr', 'uk' ];

const formatAuthorName = (name: string, lastNameFirst: boolean) => {
  if (!name) return '';
  const parts = name.split(' ');
  if (lastNameFirst && parts.length > 1) {
    return `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(' ')}`;
  }
  return name;
};

export const formatAuthors = (
  contributors: string | string[] | Contributor | Contributor[],
  bookLang?: string | string[],
  sortAs?: boolean,
) => {
  const langCode = getBookLangCode(bookLang) || 'en';
  const lastNameFirst = !!sortAs && LASTNAME_AUTHOR_SORT_LANGS.includes(langCode);
  return Array.isArray(contributors)
    ? listFormater(langCode === 'zh', langCode).format(
        contributors.map((contributor) =>
          typeof contributor === 'string'
            ? formatAuthorName(contributor, lastNameFirst)
            : formatAuthorName(formatLanguageMap(contributor?.name), lastNameFirst),
        ),
      )
    : typeof contributors === 'string'
      ? formatAuthorName(contributors, lastNameFirst)
      : formatAuthorName(formatLanguageMap(contributors?.name), lastNameFirst);
};

export const formatTitle = (title: string | LanguageMap) => {
  return typeof title === 'string' ? title : formatLanguageMap(title);
};

export const formatDescription = (description?: string | LanguageMap) => {
  if (!description) return '';
  const text = typeof description === 'string' ? description : formatLanguageMap(description);
  return text
    .replace(/<\/?[^>]+(>|$)/g, '')
    .replace(/&#\d+;/g, '')
    .trim();
};

export const formatSeries = (series?: string, seriesIndex?: number) => {
  const name = series?.trim();
  if (!name) return '';
  const hasIndex =
    typeof seriesIndex === 'number' && Number.isFinite(seriesIndex) && seriesIndex > 0;
  return hasIndex ? `${name} #${seriesIndex}` : name;
};

export const formatPublisher = (publisher: string | LanguageMap) => {
  return typeof publisher === 'string' ? publisher : formatLanguageMap(publisher);
};

const langCodeToLangName = (langCode: string) => {
  return SUPPORTED_LANGS[langCode] || langCode.toUpperCase();
};

export const formatLanguage = (lang: string | string[] | undefined): string => {
  return Array.isArray(lang)
    ? lang.map(langCodeToLangName).join(', ')
    : langCodeToLangName(lang || '');
};

// Should return valid ISO-639-1 language code, fallback to 'en' if not valid
export const getPrimaryLanguage = (lang: string | string[] | undefined) => {
  const primaryLang = Array.isArray(lang) ? lang[0] : lang;
  if (isValidLang(primaryLang)) {
    const normalizedLang = normalizedLangCode(primaryLang);
    return code6392to6391(normalizedLang) || normalizedLang;
  }
  return 'en';
};

// Immutably apply edited metadata to a book, returning a NEW book object.
// Callers must not mutate the existing book in place: <BookCover> is memoized
// and compares fields off the book, so an in-place mutation makes the memo's
// previous snapshot point to the same object and skips re-rendering the cover.
export const getBookWithUpdatedMetadata = (
  book: Book,
  metadata: BookMetadata,
  tags?: string[],
): Book => {
  const now = Date.now();
  const updatedBook: Book = {
    ...book,
    metadata,
    ...(tags ? { tags: [...tags] } : {}),
    title: formatTitle(metadata.title),
    author: formatAuthors(metadata.author),
    primaryLanguage: getPrimaryLanguage(metadata.language),
    updatedAt: now,
    // The metadata group merges on its own clock so a page turn elsewhere
    // (which dominates updatedAt) cannot clobber this edit (issue #5438).
    metadataUpdatedAt: now,
  };
  const newCoverImageUrl = metadata.coverImageBlobUrl || metadata.coverImageUrl;
  if (newCoverImageUrl) {
    updatedBook.coverImageUrl = newCoverImageUrl;
  }
  return updatedBook;
};

export const formatDate = (date: string | number | Date | null | undefined, isUTC = false) => {
  if (!date) return;
  const userLang = getUserLang();
  try {
    return new Date(date).toLocaleDateString(userLang, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: isUTC ? 'UTC' : undefined,
    });
  } catch {
    return;
  }
};

export const formatCalibreColumnValue = (column: CalibreCustomColumn): string => {
  const { datatype, value, extra } = column;
  if (Array.isArray(value)) return value.join(', ');
  switch (datatype) {
    case 'rating': {
      // 0-10 in half stars, like calibre's own rendering
      const rating = typeof value === 'number' ? value : 0;
      return '★'.repeat(Math.floor(rating / 2)) + (rating % 2 ? '½' : '');
    }
    case 'series':
      return extra != null ? `${value} [${extra}]` : String(value);
    case 'datetime':
      return formatDate(String(value), true) || '';
    case 'comments':
      return String(value)
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    case 'bool':
      return value ? '✓' : '✗';
    default:
      return String(value);
  }
};

export const formatLocaleDateTime = (date: number | Date) => {
  const userLang = getLocale();
  return new Date(date).toLocaleString(userLang);
};

export const formatBytes = (bytes?: number | null, locale = 'en-US') => {
  if (!bytes) return '';
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  const formatter = new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: units[i],
    unitDisplay: 'short',
    maximumFractionDigits: 2,
  });
  return formatter.format(value);
};

export const getCurrentPage = (book: Book, progress: BookProgress) => {
  const bookFormat = book.format;
  const { section, pageinfo } = progress;
  return bookFormat === 'PDF'
    ? section
      ? section.current + 1
      : 0
    : pageinfo
      ? pageinfo.current + 1
      : 0;
};

/**
 * A book is "currently reading" iff it has real reading progress and has not
 * been parked. Importing a book sets timestamps but never `progress` (only
 * opening it does), so the progress gate drops freshly-added-but-unopened
 * books; the status gate drops finished, abandoned (on hold) and
 * manually-marked-unread books. A book actively being read has `readingStatus`
 * either `undefined` (cleared from 'unread' on first open) or `'reading'`, both
 * of which pass. Shared by the library's recently-read shelf and the
 * home-screen reading widget so the two surfaces stay in sync.
 */
export const isCurrentlyReadingBook = (book: Book): boolean =>
  !book.deletedAt &&
  book.progress != null &&
  book.readingStatus !== 'finished' &&
  book.readingStatus !== 'abandoned' &&
  book.readingStatus !== 'unread';

export const getBookDirFromWritingMode = (writingMode: WritingMode) => {
  switch (writingMode) {
    case 'horizontal-tb':
      return 'ltr';
    case 'horizontal-rl':
    case 'vertical-rl':
      return 'rtl';
    default:
      return 'auto';
  }
};

export const getBookDirFromLanguage = (language: string | string[] | undefined) => {
  const lang = getPrimaryLanguage(language) || '';
  return getDirFromLanguage(lang);
};

const getTitleForHash = (title: string | LanguageMap) => {
  return typeof title === 'string' ? title : formatLanguageMap(title, true);
};

const getAuthorsList = (contributors: string | string[] | Contributor | Contributor[]) => {
  if (!contributors) return [];
  return Array.isArray(contributors)
    ? contributors
        .map((contributor) =>
          typeof contributor === 'string'
            ? contributor
            : formatLanguageMap(contributor?.name, true),
        )
        .filter(Boolean)
    : [
        typeof contributors === 'string'
          ? contributors
          : formatLanguageMap(contributors?.name, true),
      ];
};

const normalizeIdentifier = (identifier: string) => {
  try {
    if (identifier.includes('urn:')) {
      // Slice after the last ':'
      return identifier.match(/[^:]+$/)?.[0] || '';
    } else if (identifier.includes(':')) {
      // Slice after the first ':'
      return identifier.match(/^[^:]+:(.+)$/)?.[1] || '';
    }
  } catch {
    return identifier;
  }
  return identifier;
};

const getPreferredIdentifier = (identifiers: string[] | Identifier[]) => {
  for (const scheme of ['uuid', 'calibre', 'isbn']) {
    const found = identifiers.find((identifier) =>
      typeof identifier === 'string'
        ? identifier.toLowerCase().includes(scheme)
        : identifier.scheme.toLowerCase() === scheme,
    );
    if (found) {
      return typeof found === 'string' ? normalizeIdentifier(found) : found.value;
    }
  }
  return;
};

const getIdentifiersList = (
  identifiers: undefined | string | string[] | Identifier | Identifier[],
) => {
  if (!identifiers) return [];
  if (Array.isArray(identifiers)) {
    const preferred = getPreferredIdentifier(identifiers);
    if (preferred) {
      return [preferred];
    }
  }
  return Array.isArray(identifiers)
    ? identifiers
        .map((identifier) =>
          typeof identifier === 'string' ? normalizeIdentifier(identifier) : identifier.value,
        )
        .filter(Boolean)
    : typeof identifiers === 'string'
      ? [normalizeIdentifier(identifiers)]
      : [identifiers.value];
};

export interface MetadataHashInfo {
  title: string;
  authors: string[];
  identifiers: string[];
  hashSource: string;
  metaHash: string;
  /**
   * Whether `hashSource` contains something that identifies the PUBLICATION
   * rather than just describing it: a real identifier (UUID / ISBN / calibre /
   * PalmDB UID) or a caller-supplied filename salt.
   *
   * A title+authors-only digest is not an identity — two different books by the
   * same author sharing a title collide on it, and folding on such a key
   * silently deletes one of them. Callers that would fold records (importBook's
   * aggregation) must require this flag. The filename salt counts because it is
   * this project's established way of giving an explicit identity to formats
   * whose metadata has none: PDF (issue #5411), MD imports (utils/md.ts), and
   * MOBI's PalmDB UID (utils/tauriMobiBridge.ts).
   */
  hasExplicitIdentity: boolean;
}

export const getMetadataHashInfo = (
  metadata: BookMetadata,
  filename?: string,
): MetadataHashInfo | undefined => {
  if (!metadata) return;
  try {
    const title = getTitleForHash(metadata.title);
    const authors = getAuthorsList(metadata.author);
    const identifiers = getIdentifiersList(metadata.altIdentifier || metadata.identifier);
    let hashSource = `${title}|${authors.join(',')}|${identifiers.join(',')}`;
    if (filename) hashSource += `|${filename}`;
    const metaHash = md5(hashSource.normalize('NFC'));
    return {
      title,
      authors,
      identifiers,
      hashSource,
      metaHash,
      hasExplicitIdentity: identifiers.length > 0 || !!filename,
    };
  } catch (error) {
    console.error('Error generating metadata hash:', error);
  }
  return;
};

export const getMetadataHash = (metadata: BookMetadata, filename?: string) => {
  return getMetadataHashInfo(metadata, filename)?.metaHash;
};

// --- Book version identity ---

/**
 * Wrapping pairs stripped from a title/author before comparing two releases of
 * the same book. Only *matched* pairs are removed (see normalizeVersionPart):
 * a title is comparable whether the source wrapped it in 《》 or not, but
 * interior punctuation must survive — folding it would merge genuinely
 * different books ("三体" vs "三体II" / "第一部" vs "第二部"), and stripping
 * each end independently would corrupt a title like `三体（重命名）`.
 */
const VERSION_WRAP_PAIRS: Array<[string, string]> = [
  ['《', '》'],
  ['〈', '〉'],
  ['【', '】'],
  ['「', '」'],
  ['『', '』'],
  ['［', '］'],
  ['[', ']'],
  ['（', '）'],
  ['(', ')'],
  ['“', '”'],
  ['‘', '’'],
  ['"', '"'],
  ["'", "'"],
];

/**
 * Fold one identity component (title or author) down to its comparable form:
 * NFC, matched wrapping pairs removed, all whitespace removed, lowercased. Used
 * only for cross-version matching — never for display or persistence.
 */
export const normalizeVersionPart = (text: string | undefined): string => {
  if (!text) return '';
  let s = text.normalize('NFC').trim();
  for (let stripping = true; stripping; ) {
    stripping = false;
    for (const [open, close] of VERSION_WRAP_PAIRS) {
      if (s.length > open.length + close.length && s.startsWith(open) && s.endsWith(close)) {
        s = s.slice(open.length, -close.length);
        stripping = true;
        break;
      }
    }
  }
  return s.replace(/\s+/g, '').toLowerCase();
};

/**
 * Separators `formatAuthors` uses to join a contributor list (zh joins with
 * '、', other languages with ', ' and friends). A book with several authors is
 * matched by its first one only — the ordering is stable for a given source,
 * and requiring the whole list to match would defeat the loose match.
 */
const VERSION_AUTHOR_SEPARATORS = /[,、;；&/]+/;

export const normalizeVersionAuthor = (author: string | undefined): string => {
  if (!author) return '';
  return author.split(VERSION_AUTHOR_SEPARATORS).map(normalizeVersionPart).find(Boolean) ?? '';
};

export interface BookVersionIdentity {
  /** `normalizeVersionPart(title)`, empty when the book has no usable title. */
  titleKey: string;
  /** `normalizeVersionAuthor(author)`, empty when unknown. */
  authorKey: string;
  format: BookFormat;
}

export type VersionIdentitySource = {
  title?: string;
  sourceTitle?: string;
  author?: string;
  format: BookFormat;
};

/**
 * Every identity a book can be matched by: one per title worth comparing. A
 * stored book carries both the user-editable `title` and the import-time
 * `sourceTitle`; indexing both keeps a library rename from hiding the book
 * from version matching. Identical keys collapse to one entry.
 */
export const getBookVersionIdentities = (book: VersionIdentitySource): BookVersionIdentity[] => {
  const authorKey = normalizeVersionAuthor(book.author);
  const identities: BookVersionIdentity[] = [];
  const seen = new Set<string>();
  for (const raw of [book.title, book.sourceTitle]) {
    const titleKey = normalizeVersionPart(raw);
    if (!titleKey || seen.has(titleKey)) continue;
    seen.add(titleKey);
    identities.push({ titleKey, authorKey, format: book.format });
  }
  return identities;
};

/** Probe key for `BookLookupIndex.byVersionKey`; only the title part is indexed. */
export const getBookVersionIndexKey = (identity: BookVersionIdentity): string =>
  `${identity.titleKey}|${identity.format}`;

/**
 * Whether two identities describe the same book across releases: same format,
 * same normalized title, and matching authors — except that an UNKNOWN author
 * on either side falls back to title-only matching. The loosened case is
 * deliberate: hand-made EPUBs frequently omit the author entirely, and a
 * missed match costs a duplicate entry while a wrong one is caught by the
 * confirmation dialog.
 */
export const isSameBookVersion = (a: BookVersionIdentity, b: BookVersionIdentity): boolean => {
  if (a.format !== b.format) return false;
  if (!a.titleKey || !b.titleKey || a.titleKey !== b.titleKey) return false;
  if (!a.authorKey || !b.authorKey) return true;
  return a.authorKey === b.authorKey;
};

/**
 * Whether a STORED record's `metaHash` carries an explicit identity rather than
 * a title+authors digest — i.e. whether it is a "书号" two releases of the same
 * publication would share.
 *
 * `Book.metadata` can answer this for most formats, but PDF's salt is the
 * *import filename* (#5411) and is deliberately not persisted: recomputing from
 * metadata would report "no identity" for a record whose hash is in fact
 * filename-derived. PDF always gets that salt, so the format alone settles it.
 */
export const hasStoredExplicitIdentity = (book: {
  format: BookFormat;
  metaHash?: string;
  metadata?: BookMetadata;
}): boolean => {
  if (!book.metaHash) return false;
  if (book.format === 'PDF') return true;
  if (!book.metadata) return false;
  return !!getMetadataHashInfo(book.metadata)?.hasExplicitIdentity;
};

/**
 * Library books that could be an earlier release of `incoming` (same title,
 * compatible author, same format). Pure; tombstoned books and any hash in
 * `excludeHashes` (typically the incoming file's own hash) are never
 * candidates. The caller decides what to do with the hit — this function is
 * only the match test, deliberately loose.
 */
export const findBookVersionCandidates = (
  books: Book[],
  incoming: VersionIdentitySource & { hash?: string },
  excludeHashes?: Iterable<string>,
): Book[] => {
  const incomingIdentities = getBookVersionIdentities(incoming);
  if (incomingIdentities.length === 0) return [];
  const excluded = new Set(excludeHashes ?? []);
  if (incoming.hash) excluded.add(incoming.hash);
  return books.filter((book) => {
    if (book.deletedAt || excluded.has(book.hash)) return false;
    return getBookVersionIdentities(book).some((identity) =>
      incomingIdentities.some((incomingIdentity) => isSameBookVersion(identity, incomingIdentity)),
    );
  });
};
