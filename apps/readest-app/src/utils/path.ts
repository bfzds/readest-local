import { join } from '@tauri-apps/api/path';
import type { WatchedFolderRule } from '@/types/settings';
import { isContentURI, isFileURI, isValidURL } from './misc';

export const getFilename = (fileOrUri: string) => {
  if (isValidURL(fileOrUri) || isContentURI(fileOrUri) || isFileURI(fileOrUri)) {
    fileOrUri = decodeURI(fileOrUri);
  }
  const normalizedPath = fileOrUri.replace(/\\/g, '/');
  const parts = normalizedPath.split('/');
  const lastPart = parts.pop()!;
  return lastPart.split('?')[0]!;
};

export const getBaseFilename = (filename: string) => {
  const normalizedPath = filename.replace(/\\/g, '/');
  const name = normalizedPath.split('/').pop() || '';

  const parts = name.split('.');
  if (parts.length <= 1) {
    return name;
  }

  return parts.slice(0, -1).join('.');
};

export const getDirPath = (filePath: string) => {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const parts = normalizedPath.split('/');
  parts.pop();
  return parts.join('/');
};

/**
 * Group name a book imported from a folder belongs to: its directory made
 * relative to the *parent* of `basePath`, so the imported folder itself
 * becomes the top-level group ("Books") and every subfolder nests under it
 * ("Books/SciFi"). Books sitting loose in `basePath` get the folder's own
 * group. Backslashes are normalized, so Windows paths derive the same names.
 *
 * `rule` selects a different grouping for a watched folder:
 *   - omitted / `mirror`: the behaviour above, unchanged.
 *   - `flat`: no group at all (`''`), the shape "Import all into library" wants.
 *   - `author`: the watched folder plus its first directory level that is not a
 *     download date, dropping anything deeper. `<root>/Pixiv/<date>/<author>/<book>`
 *     and `<root>/Pixiv/<author>/<date>/<book>` both become `Pixiv/<author>`;
 *     a folder with no author level (or one sitting directly in the root) is
 *     just `Pixiv`.
 *
 * A `filePath` that does not live under `basePath` falls back to the mirrored
 * name — the input is wrong, but a wrong-but-harmless group beats throwing
 * during an import.
 */
export const getFolderImportGroupName = (
  filePath: string,
  basePath: string,
  rule?: WatchedFolderRule,
) => {
  if (rule?.mode === 'flat') return '';
  const rootPath = getDirPath(basePath);
  const mirrored = getDirPath(filePath).replace(rootPath, '').replace(/^\//, '');
  if (rule?.mode !== 'author') return mirrored;

  const base = normalizePathSeparators(basePath, { stripTrailing: true });
  const dir = getDirPath(filePath);
  if (dir !== base && !dir.startsWith(`${base}/`)) return mirrored;
  const folderName = getLastPathSegment(base);
  const authorSegment =
    dir === base
      ? undefined
      : dir
          .slice(base.length + 1)
          .split('/')
          .find((s) => s && !isDateLikeSegment(s));
  return authorSegment && folderName ? `${folderName}/${authorSegment}` : folderName || mirrored;
};

/** Backslashes to slashes, optionally dropping trailing separators. */
const normalizePathSeparators = (path: string, opts: { stripTrailing?: boolean } = {}) => {
  const slashed = path.replace(/\\/g, '/');
  return opts.stripTrailing ? slashed.replace(/\/+$/, '') : slashed;
};

const getLastPathSegment = (path: string) =>
  normalizePathSeparators(path).split('/').filter(Boolean).pop() ?? '';

/**
 * Directory names that are download dates rather than author names — the level
 * a Pixiv-style download produces once per day. Recognized: `YYYY-MM-DD`,
 * `YYYY.MM.DD`, `YYYY_MM_DD`, `YYYYMMDD` and `YYYY年M月D日`.
 *
 * The check is deliberately strict about the year, because Pixiv's numeric user
 * ids are 7–10 digits long and one of them (`20250101`, say) can look exactly
 * like a date. An id whose leading four digits are not 19xx/20xx never matches,
 * and the compact form additionally requires a valid month (01–12) and day
 * (01–31) so `20251301` stays an author name. A bare year or year-month
 * (`2025`, `2025-01`) is not a date here either: only the level below the
 * watched folder is inspected, and treating a year-only bucket as a date would
 * silently swallow a genuine author folder named after one.
 */
export const isDateLikeSegment = (segment: string): boolean => {
  // A trailing Windows-style dedup suffix ("2025-01-01 (2)") is a copy of the
  // same day's folder, not a different author, so it counts as a date too.
  // Free-form suffixes (`2025-01-01_backup`) stay unrecognized on purpose: the
  // pattern cannot tell them apart from a genuinely date-shaped author name, and
  // guessing wrong silently buries a whole author level.
  const trimmed = segment.trim().replace(/\s*\(\d+\)$/, '');
  if (!trimmed) return false;
  return DATE_LIKE_PATTERNS.some((pattern) => pattern.test(trimmed));
};

const DATE_LIKE_PATTERNS = [
  /^(?:19|20)\d{2}[-._]\d{1,2}[-._]\d{1,2}$/,
  /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/,
  /^(?:19|20)\d{2}年\d{1,2}月\d{1,2}日$/,
];

export const joinPaths = async (...paths: string[]) => {
  return await join(...paths);
};

/**
 * Join a folder root with a relative path returned by a directory scan, using
 * the root's own separator style. Equivalent to {@link joinPaths} for these
 * inputs (native-form root from the folder picker, host-separator relative
 * path from the scan) but pure string work — no IPC round-trip. That matters
 * when the watched-folder scan joins hundreds of paths on every window focus
 * (issue #5494).
 */
export const joinScannedPath = (root: string, relativePath: string) => {
  const sep = root.includes('\\') ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + sep + relativePath;
};
