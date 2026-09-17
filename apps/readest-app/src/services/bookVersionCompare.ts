import type { Book, VersionTocEntry } from '@/types/book';
import type { AppService } from '@/types/system';
import { isBookNavCacheCurrent, type BookNav } from '@/services/nav';
import type { SystemSettings } from '@/types/settings';
import { filterWholeBookTocItems, virtualTocToItems } from '@/services/virtualToc/apply';

/**
 * 版本对比：把"导入的这本"和"书库里那本"并排列出来，让用户自己判断该不该替换。
 *
 * 不变量 3：**弹窗打开时不解析任何文件**。两侧的每一项都来自已经在手的数据——
 * 记录字段、`nav.json` 缓存、`config.json` 里的虚拟目录，或导入时顺带算出的
 * incomingFacts。任何一项取不到就显示"未记录"，绝不为此去解压一本书。
 */

/** 一侧的展示事实。`new` 是刚导入的，`old` 是书库里那条。 */
export interface VersionSideFacts {
  label: 'new' | 'old';
  title: string;
  author: string;
  /** 书号前 8 位，取不到时为 undefined（PDF 之外没有标识符的手工书常见）。 */
  identifier?: string;
  format: string;
  sizeBytes?: number;
  mtime?: number;
  textLength?: number;
  /** 章节条目。null/undefined = 这一侧没有可用的目录数据。 */
  toc?: VersionTocEntry[] | null;
  /** 目录数据的来源，决定"收起章节区"时怎么向用户解释。 */
  tocSource: 'native' | 'nav-cache' | 'virtual' | 'unknown';
  sectionCount?: number;
}

export interface VersionCompareRow {
  key: string;
  label: string;
  old: string;
  new: string;
  /** 只对可比的数值字段有值：新版相对旧版的变化方向。 */
  direction?: 'up' | 'down' | 'same';
}

export interface VersionComparison {
  /** 两栏表：字段并列。 */
  rows: VersionCompareRow[];
  /** 差异摘要（"正文字数 +12%"这类），空数组＝没发现可比的差异。 */
  summary: string[];
  /**
   * 章节区是否可用。任一侧没有可靠目录数据时为 false——那时改看正文规模，
   * 并给出 `sectionNote` 说明原因，而不是并排两个不可比的数字让人误判。
   */
  sectionComparable: boolean;
  sectionNote?: string;
  /** 两侧目录的条目（供章节区并排渲染），按 depth 缩进。 */
  oldToc?: VersionTocEntry[];
  newToc?: VersionTocEntry[];
}

const UNKNOWN = '未记录';

const formatBytes = (bytes: number | undefined): string => {
  if (bytes === undefined) return UNKNOWN;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatTime = (ms: number | undefined): string => {
  if (ms === undefined) return UNKNOWN;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const formatCount = (value: number | undefined): string =>
  value === undefined ? UNKNOWN : value.toLocaleString();

/** 章节条目数：有目录就用目录，否则退回记录里的章节数（TXT 用转换器的切章数）。 */
export const countSideChapters = (side: VersionSideFacts): number | undefined => {
  if (side.toc && side.toc.length > 0) return side.toc.length;
  return side.sectionCount;
};

const directionOf = (oldValue?: number, newValue?: number): 'up' | 'down' | 'same' | undefined => {
  if (oldValue === undefined || newValue === undefined) return undefined;
  if (newValue > oldValue) return 'up';
  if (newValue < oldValue) return 'down';
  return 'same';
};

const describeCountChange = (label: string, oldValue?: number, newValue?: number): string[] => {
  const direction = directionOf(oldValue, newValue);
  if (!direction) return [`${label}：只有一侧有记录，无法比较`];
  if (direction === 'same') return [`${label}相同（${formatCount(newValue)}）`];
  const delta = newValue! - oldValue!;
  const sign = delta > 0 ? '+' : '−';
  return [`${label}${delta > 0 ? '增多' : '减少'} ${sign}${Math.abs(delta).toLocaleString()}`];
};

const MIN_USABLE_CHAPTERS = 2;

/**
 * 组装两栏对比。纯函数：调用方负责把两侧事实取齐（见 `loadVersionSideFacts`），
 * 这里只做呈现决策，没有 I/O，因此分支可以逐个单测。
 */
export const buildVersionComparison = (
  oldSide: VersionSideFacts,
  newSide: VersionSideFacts,
): VersionComparison => {
  const rows: VersionCompareRow[] = [
    { key: 'title', label: '书名', old: oldSide.title, new: newSide.title },
    {
      key: 'author',
      label: '作者',
      old: oldSide.author || UNKNOWN,
      new: newSide.author || UNKNOWN,
    },
    {
      key: 'identifier',
      label: '书号',
      old: oldSide.identifier ?? UNKNOWN,
      new: newSide.identifier ?? UNKNOWN,
    },
    { key: 'format', label: '格式', old: oldSide.format, new: newSide.format },
    {
      key: 'size',
      label: '文件大小',
      old: formatBytes(oldSide.sizeBytes),
      new: formatBytes(newSide.sizeBytes),
      direction: directionOf(oldSide.sizeBytes, newSide.sizeBytes),
    },
    {
      key: 'mtime',
      label: '修改时间',
      old: formatTime(oldSide.mtime),
      new: formatTime(newSide.mtime),
    },
    {
      key: 'textLength',
      label: '正文字数',
      old: formatCount(oldSide.textLength),
      new: formatCount(newSide.textLength),
      direction: directionOf(oldSide.textLength, newSide.textLength),
    },
  ];

  const oldChapters = countSideChapters(oldSide);
  const newChapters = countSideChapters(newSide);
  rows.push({
    key: 'chapters',
    label: '章节数',
    old: formatCount(oldChapters),
    new: formatCount(newChapters),
    direction: directionOf(oldChapters, newChapters),
  });

  const summary: string[] = [];
  if (oldSide.textLength !== undefined && newSide.textLength !== undefined) {
    summary.push(...describeCountChange('正文字数', oldSide.textLength, newSide.textLength));
  }
  if (oldChapters !== undefined && newChapters !== undefined) {
    summary.push(...describeCountChange('章节数', oldChapters, newChapters));
  }
  if (oldSide.textLength === undefined || newSide.textLength === undefined) {
    summary.push('字数只有一侧有记录（老记录是加入这个字段之前导入的），再导入一次同一本即可补上');
  }

  // 章节区只在两侧都有像样的目录数据时才并排：一侧缺数据时"章节数 34 / 未记录"
  // 已经由上面的表说清，再并排一份空列表只会让人以为新版少了章节。
  const oldToc = oldSide.toc ?? undefined;
  const newToc = newSide.toc ?? undefined;
  const sectionComparable =
    (oldToc?.length ?? 0) >= MIN_USABLE_CHAPTERS && (newToc?.length ?? 0) >= MIN_USABLE_CHAPTERS;
  let sectionNote: string | undefined;
  if (!sectionComparable) {
    const missing: string[] = [];
    if ((oldToc?.length ?? 0) < MIN_USABLE_CHAPTERS) {
      missing.push(
        oldSide.tocSource === 'unknown'
          ? '书库里的这本还没有目录缓存（打开一次这本书即可生成）'
          : '书库里的这本目录不完整',
      );
    }
    if ((newToc?.length ?? 0) < MIN_USABLE_CHAPTERS) {
      missing.push('导入的这本自带目录不完整');
    }
    sectionNote = `${missing.join('；')}，因此这里只对比正文规模（字数、文件大小）。`;
  }

  return {
    rows,
    summary,
    sectionComparable,
    ...(sectionNote ? { sectionNote } : {}),
    ...(sectionComparable ? { oldToc, newToc } : {}),
  };
};

/** 书号只并列前 8 位：判断"是不是同一个来源"够用了，也不需要展示整串哈希。 */
const shortIdentifier = (metaHash?: string): string | undefined =>
  metaHash ? metaHash.slice(0, 8) : undefined;

const toTocEntries = (
  items: Array<{ label?: string; subitems?: unknown[] }>,
): VersionTocEntry[] => {
  const entries: VersionTocEntry[] = [];
  const walk = (list: Array<{ label?: string; subitems?: unknown[] }>, depth: number) => {
    for (const item of list) {
      const label = item.label?.trim();
      if (label) entries.push({ label, depth });
      if (Array.isArray(item.subitems)) {
        walk(item.subitems as Array<{ label?: string; subitems?: unknown[] }>, depth + 1);
      }
    }
  };
  walk(items, 0);
  return entries;
};

/**
 * 书库那一侧的展示事实。取数顺序有意固定：
 *   1. `nav.json` —— 阅读器打开这本书时算出的目录（要过 `isBookNavCacheCurrent`，
 *      否则历史缓存的口径与现在不同，会造出假差异）；
 *   2. `config.json` 的 `virtualToc` —— 用户自己生成的目录（标注来源）；
 *   3. 都没有 → 章节区收起。
 * 正文字数与文件大小来自记录与一次 `stats`，不打开书文件。
 */
export const loadOldVersionFacts = async (
  appService: AppService,
  book: Book,
  settings: SystemSettings,
): Promise<VersionSideFacts> => {
  const facts: VersionSideFacts = {
    label: 'old',
    title: book.title,
    author: book.author,
    identifier: shortIdentifier(book.metaHash),
    format: book.format,
    textLength: book.textLength,
    toc: null,
    tocSource: 'unknown',
  };

  try {
    const nav: BookNav | null = await appService.loadBookNav(book);
    if (nav && isBookNavCacheCurrent(nav)) {
      const items = filterWholeBookTocItems(nav.toc ?? []);
      if (items.length >= MIN_USABLE_CHAPTERS) {
        facts.toc = toTocEntries(items);
        facts.tocSource = 'nav-cache';
      }
    }
  } catch {
    // 缓存读不出来（文件坏了、权限不足）不是错误：往下试虚拟目录。
  }

  if (!facts.toc) {
    try {
      const config = await appService.loadBookConfig(book, settings);
      const virtual = (config.virtualToc ?? []).filter((entry) => entry.label);
      if (virtual.length >= MIN_USABLE_CHAPTERS) {
        facts.toc = toTocEntries(virtualTocToItems(virtual));
        facts.tocSource = 'virtual';
      }
    } catch {
      // 没有 config 或读不动：章节区收起，正文规模对比照旧可用。
    }
  }

  // 章节数：目录拿不到时记录里也没有可用的章节数（章节数不是持久化字段），
  // 因此留空由弹窗按"未记录"显示。
  if (facts.toc) facts.sectionCount = facts.toc.length;

  try {
    const size = await appService.getBookFileSize(book);
    if (size !== null) facts.sizeBytes = size;
  } catch {
    // 书文件不在盘上（用户移走了）——大小栏显示"未记录"。
  }

  return facts;
};

/** 新导入那一侧的展示事实，全部来自上报的 `incomingFacts`。 */
export const buildNewVersionFacts = (
  incoming: Book,
  facts:
    | {
        sizeBytes?: number;
        mtime?: number;
        textLength?: number;
        sectionCount?: number;
        toc?: VersionTocEntry[];
      }
    | undefined,
): VersionSideFacts => ({
  label: 'new',
  title: incoming.title,
  author: incoming.author,
  identifier: shortIdentifier(incoming.metaHash),
  format: incoming.format,
  sizeBytes: facts?.sizeBytes,
  mtime: facts?.mtime,
  textLength: facts?.textLength ?? incoming.textLength,
  sectionCount: facts?.sectionCount,
  toc: facts?.toc ?? null,
  tocSource: facts?.toc?.length ? 'native' : 'unknown',
});

/** 书号截断规则单独导出，单测直接锁它（弹窗并列两边书号时用它）。 */
export const shortMetaHash = shortIdentifier;
