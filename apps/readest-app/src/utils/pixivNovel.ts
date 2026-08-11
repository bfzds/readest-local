export interface PixivNovelMetadata {
  title: string;
  author?: string;
  novelId?: string;
  seriesId?: string;
}

const PIXIV_SHOW_URL_RE = /https:\/\/www\.pixiv\.net\/novel\/show\.php\?id=(\d+)/;
const PIXIV_SERIES_URL_RE = /https:\/\/www\.pixiv\.net\/novel\/series\/(\d+)/;
const PIXIV_ID_RE = /^\d{7,10}$/;
const DATE_TOKEN = '(?:19|20)\\d{2}[-/.]\\d{1,2}[-/.]\\d{1,2}';
const TRAILING_TOKEN_RE = new RegExp(
  `(?:[-_ ](?:p\\d+|第\\d+[话話]|part\\d+|#\\d+|${DATE_TOKEN}|\\d{7,10}|\\d+字|\\d+收藏|AI|R-?18G?|r18g?|小说|novel))+$`,
  'i',
);
const KNOWN_BRACKET_RE = new RegExp(
  `^(?:\\d{7,10}|${DATE_TOKEN}|AI|R-?18G?|r18g?|小说|novel)$`,
  'i',
);

const CHAPTER_OR_VOLUME_SUFFIX_RE =
  /^(?:第\s*[0-9一二三四五六七八九十百千万零]*\s*[章话回節卷部]|[上下中]册|[上下中]部|Chapter\s*\d+)$/i;

const isReasonableName = (name: string): boolean =>
  name.length > 0 && name.length <= 200 && !name.includes('https://');

const cleanTitle = (title: string): string => {
  let result = title.trim();
  result = result.replace(
    /\s*(?:\(|（|\[|【)([^)）\]】]+)(?:\)|）|\]|】)\s*$/g,
    (all, inner: string) => (KNOWN_BRACKET_RE.test(inner.trim()) ? '' : all),
  );
  result = result.replace(TRAILING_TOKEN_RE, '');
  result = result.replace(/^[-_ ]+|[-_ ]+$/g, '').trim();
  return result && result !== title.trim() ? result : title.trim();
};

export const parsePixivNovelMetaHeader = (text: string): PixivNovelMetadata | null => {
  if (!text) return null;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);

  const showIndex = lines.findIndex((line) => PIXIV_SHOW_URL_RE.test(line));
  if (showIndex >= 2) {
    const title = lines[showIndex - 2] ?? '';
    const author = lines[showIndex - 1] ?? '';
    if (isReasonableName(title) && isReasonableName(author)) {
      return {
        title,
        author,
        novelId: lines[showIndex]!.match(PIXIV_SHOW_URL_RE)![1]!,
      };
    }
  }

  const seriesIndex = lines.findIndex((line) => PIXIV_SERIES_URL_RE.test(line));
  if (seriesIndex >= 2) {
    const title = lines[seriesIndex - 2] ?? '';
    const author = (lines[seriesIndex - 1] ?? '').replace(/^作者\s*[:：]\s*/i, '');
    if (isReasonableName(title) && isReasonableName(author)) {
      return {
        title,
        author,
        seriesId: lines[seriesIndex]!.match(PIXIV_SERIES_URL_RE)![1]!,
      };
    }
  }

  return null;
};

const parseDefaultLayout = (path: string): PixivNovelMetadata | null => {
  // pixiv/<user>-<user_id>/<id>-<title>.<ext>
  const match = path.match(/(?:^|\/)([^/]+)-(\d{7,10})\/(\d{7,10})-(.+)\.(?:txt|epub)$/i);
  if (!match) return null;
  const [, user, , novelId, titleRaw] = match;
  if (!user || !novelId || !titleRaw) return null;
  const title = cleanTitle(titleRaw);
  if (!title || !isReasonableName(title)) return null;
  return { title, author: user, novelId };
};

const parseSeriesLayout = (path: string, base: string): PixivNovelMetadata | null => {
  if (!/novel series\//i.test(path)) return null;
  const parts = base.split('-');
  const idIndex = parts.findIndex((part) => PIXIV_ID_RE.test(part));
  if (idIndex <= 0 || idIndex >= parts.length - 1) return null;
  const seriesTitle = parts.slice(0, idIndex).join('-');
  const author = parts[idIndex + 1] ?? '';
  if (!isReasonableName(seriesTitle) || !isReasonableName(author)) return null;
  return { title: seriesTitle, author, seriesId: parts[idIndex]! };
};

const parseTwoIdLayout = (base: string): PixivNovelMetadata | null => {
  // {date}-{user_id}-{id}-{title}
  const dateAndIds = base.match(
    new RegExp(`^${DATE_TOKEN}[-_ ]+(\\d{7,10})[-_ ]+(\\d{7,10})[-_ ]+(.+)$`),
  );
  if (dateAndIds) {
    const [, , novelId, titleRaw] = dateAndIds;
    if (!novelId || !titleRaw) return null;
    const title = cleanTitle(titleRaw);
    if (title && isReasonableName(title)) return { title, novelId };
  }

  // {user}-{user_id}-{id}-{title}
  const match = base.match(/^(.+)-(\d{7,10})-(\d{7,10})-(.+)$/);
  if (!match) return null;
  const [, first, , novelId, titleRaw] = match;
  if (!first || !novelId || !titleRaw) return null;
  const title = cleanTitle(titleRaw);
  if (!title || !isReasonableName(title)) return null;
  return {
    title,
    ...(isReasonableName(first) && !PIXIV_ID_RE.test(first) ? { author: first } : {}),
    novelId,
  };
};

const parseSingleIdLayout = (base: string): PixivNovelMetadata | null => {
  // {title}-{id}-{user}
  // 下载器命名规则为 {title}-{id}-{user}-{tags}，标签用 , # ^ & _ 等分隔，
  // 且标签本身可能含连字符，所以只取 ID 后的第一段作为作者。
  const match = base.match(/^(.+)-(\d{7,10})-([^-]+)(?:-.+)?$/);
  if (!match) return null;
  const [, titleRaw, id, author] = match;
  if (!titleRaw || !id || !author) return null;
  if (author.length > 40 || /^\d+$/.test(author) || CHAPTER_OR_VOLUME_SUFFIX_RE.test(author)) {
    return null;
  }
  const title = cleanTitle(titleRaw);
  if (!title || !isReasonableName(title)) return null;
  return { title, author, novelId: id };
};

const looksLikePixivPath = (path: string, base: string): boolean =>
  /pixiv\/|novel series\//i.test(path) ||
  /^\d{7,10}-/.test(base) ||
  /\d{7,10}-\d{7,10}-/.test(base) ||
  // 无 pixiv 目录时，{title}-{id}-{user} 也进入解析，避免普通书名被误判
  /\d{7,10}-(?:[^-]+(?:-.+)?)$/.test(base) ||
  /\/[^/]*-?\d{7,10}\//.test(path);

export const parsePixivNovelFilename = (filenameOrPath: string): PixivNovelMetadata | null => {
  if (!filenameOrPath) return null;
  const normalized = filenameOrPath.replace(/\\/g, '/');
  const base = (normalized.split('/').pop() ?? '').replace(/\.(?:txt|epub)$/i, '');
  if (!base || !looksLikePixivPath(normalized, base)) return null;

  const defaultLayout = parseDefaultLayout(normalized);
  if (defaultLayout) return defaultLayout;

  const seriesLayout = parseSeriesLayout(normalized, base);
  if (seriesLayout) return seriesLayout;

  const twoIdLayout = parseTwoIdLayout(base);
  if (twoIdLayout) return twoIdLayout;

  const singleIdLayout = parseSingleIdLayout(base);
  if (singleIdLayout) return singleIdLayout;

  return null;
};
