import { BookMetadata } from '@/libs/document';
import { TTSHighlightOptions } from '@/services/tts/types';
import { TTSHighlightGranularity } from '@/services/tts/types';
import { TTSMediaMetadataMode } from '@/services/tts/types';
import { TTSPlayerStyle } from '@/services/tts/types';
import { AnnotationToolType } from './annotator';

export type BookFormat =
  | 'EPUB'
  | 'PDF'
  | 'MOBI'
  | 'AZW'
  | 'AZW3'
  | 'CBZ'
  | 'FB2'
  | 'FBZ'
  | 'TXT'
  | 'MD';
export type BookNoteType = 'bookmark' | 'annotation' | 'excerpt';
export type ReadingStatus = 'unread' | 'reading' | 'finished' | 'abandoned';
export type HighlightStyle = 'highlight' | 'underline' | 'squiggly';
// Predefined highlight colors, can be extended with custom hex colors
export type HighlightColor = 'red' | 'yellow' | 'green' | 'blue' | 'violet' | string;
export const DEFAULT_HIGHLIGHT_COLORS = ['red', 'yellow', 'green', 'blue', 'violet'] as const;
export type DefaultHighlightColor = (typeof DEFAULT_HIGHLIGHT_COLORS)[number];
// A user-added highlight color with optional label
export interface UserHighlightColor {
  hex: string;
  label?: string;
}
export type ReadingRulerColor = 'transparent' | 'yellow' | 'green' | 'blue' | 'rose';

export interface ParagraphModeConfig {
  enabled: boolean;
}

export const FIXED_LAYOUT_FORMATS: Set<BookFormat> = new Set(['PDF', 'CBZ']);

/**
 * Lookup tables built from a Book[] for O(1) hash and metaHash queries during
 * batch import. Mutated in place by importBook so subsequent files in the
 * same batch see books added by earlier files. Defined here (rather than in
 * services/bookService) so the AppService interface in types/system can
 * reference it without an inline `import(...)` type.
 */
export interface BookLookupIndex {
  byHash: Map<string, Book>;
  byMetaKey: Map<string, Book[]>; // key = `${metaHash}:${format}`
  // Maps normalized absolute source path -> Book for in-place imports.
  // Lets the importer recognize "I already have this exact file" without
  // having to open, parse, and hash it again. Only books with a non-empty
  // `filePath` and `!deletedAt` are indexed. The key is produced by
  // `normalizeFilePathForIndex` so callers must use the same helper to
  // probe; importBook handles that internally.
  byFilePath: Map<string, Book>;
  // Maps `${normalized title}|${format}` -> Book[] for cross-version matching
  // (importing a re-downloaded / re-edited release of a book already in the
  // library). A book is indexed once per comparable title (`title` and
  // `sourceTitle`), so a library rename doesn't hide it. Keys come from
  // `getBookVersionIndexKey`; probing must re-check with `isSameBookVersion`
  // because the author is not part of the key (an unknown author on either
  // side matches on title alone). Tombstoned books are not indexed.
  byVersionKey: Map<string, Book[]>;
}

/**
 * User-facing options for AppService.importBook. The bookService implementation
 * extends this with required callbacks (saveBookConfig / generateCoverImageUrl)
 * that are bound by the AppService instance.
 */
export interface ImportBookOptions {
  /** Whether to copy the file into the Books directory. Defaults to true. */
  saveBook?: boolean;
  /** Whether to extract and save a cover image. Defaults to true. */
  saveCover?: boolean;
  /** Whether to overwrite an existing file at the same path. Defaults to false. */
  overwrite?: boolean;
  /** Whether the import is transient (not stored long-term). Defaults to false. */
  transient?: boolean;
  /**
   * If true, do NOT copy the source file into Books/<hash>/. Instead, persist
   * an absolute filePath on the Book and let isBookAvailable / loadBookContent
   * fall back to it. The caller is responsible for verifying the source is
   * already inside the user's chosen library root (customRootDir) so that the
   * file remains stable across launches. Sidecar files (cover.png, config.json,
   * nav.json) are still written to Books/<hash>/ as usual. Defaults to false.
   */
  inPlace?: boolean;
  /** Pre-built lookup index for O(1) dedup during batch imports. */
  lookupIndex?: BookLookupIndex;
  /**
   * 用户自定义章节标题正则（方向③）。仅对 TXT 导入生效，透传至
   * TxtToEpubConverter，帮助目录识别不完善的多本合集/自制 TXT。
   */
  chapterPatterns?: string[];
  /**
   * TXT 导入时内置/自定义规则一条标题都没匹配上、章节由段落兜底切出
   * （usedFallback）时触发，参数是尚未转换的原始 TXT File。调用方可据此
   * 弹出「目录识别失败」引导，让用户勾选标题行重切；不设则静默保留兜底结果。
   */
  onTxtChapterFallback?: (file: File) => void;
  /**
   * 发现书库里可能已有这本书的旧版本（同书号、换源重下、同名同作者）时触发：
   * 新文件已按自己的 hash 落盘成独立记录，库里那条原封不动，是否合并由用户
   * 在弹窗里决定。
   *
   * 导入器自身不折叠、不删除任何既有记录（不变量 1），所以没注册回调的静默
   * 路径最多"晚点问"，绝不会"不问就删"。调用方可用 `replaceBookVersion()`
   * 替换、或 `discardImportedBook()` 撤销这次导入。
   */
  onVersionConflict?: (info: BookVersionConflictInfo) => void;
  /**
   * 同一个文件重复导入命中既有记录时上报（存活 / 已删待复活）。导入器本身
   * 不改任何东西，调用方据此区分"已在书库中"与"已从书库恢复"两种提示。
   */
  onDedupHit?: (kind: 'already-in-library' | 'revived') => void;
}

/**
 * 判定依据：为什么认为"导入的这本和库里那本是同一本书"。四种取值对应弹窗里
 * 并列展示的两边书号，用户据此判断到底该不该替换。
 */
export type BookVersionConflictReason =
  // 书号相同（metaHash 完全一致；PDF 的"书号"是文件名字盐，即同名 PDF）。
  | 'same-identifier'
  // 书号不同：新文件带显式身份，但与库里那条不一致（换源重下）。
  | 'identifier-differs'
  // 导入的文件根本没有书号，只能靠同名同作者判定。
  | 'incoming-without-identifier'
  // 兜底：同名同作者，库里那条没有可比的书号。
  | 'same-title-author';

/**
 * 导入时顺带取得的"新文件"事实，供弹窗零成本取用（不变量 3：弹窗打开时不解析
 * 任何文件）。这些值不写回记录——旧侧的字数取 `Book.textLength`，章节数取
 * nav.json 缓存。
 */
export interface IncomingVersionFacts {
  sizeBytes: number;
  /** 源文件的修改时间（ms）。取不到时为 undefined。 */
  mtime?: number;
  textLength?: number;
  /** 自带目录的条目数（Rust 解析器顺带统计）。 */
  sectionCount?: number;
  /** 自带目录的标签与层级，供确认框并排展示新版的章节目录。 */
  toc?: VersionTocEntry[];
}

/** 目录里的一条：标签 + 层级（0 为顶层）。 */
export interface VersionTocEntry {
  label: string;
  depth: number;
}

/**
 * 一次「导入的书可能是库里某本书的新版本」的上报。`incoming` 是本次导入新建的
 * 记录，`candidates` 是书库里判定为同一本的存活记录（按阅读进度降序，`[0]` 是
 * 替换目标）。同 hash 命中的重导不进候选——那条路径只提示「已在书库中」。
 */
export interface BookVersionConflictInfo {
  incoming: Book;
  candidates: Book[];
  reason: BookVersionConflictReason;
  incomingFacts?: IncomingVersionFacts;
}

/** 确认框里用户对单条冲突的选择。 */
export type BookVersionConflictChoice = 'replace' | 'keep' | 'discard';

export interface Book {
  // if Book is a remote book we just lazy load the book content via url
  url?: string;
  // if Book is a transient local book we can load the book content via filePath
  filePath?: string;
  // Other on-disk paths that resolved to this same book — a watched folder
  // holding the same file twice under different names, or a copy left behind
  // after a rename. Only `filePath` is ever read from; these are remembered so
  // the auto-import scan doesn't treat a known duplicate as a new file on every
  // pass. Device-local like `filePath`: never published to peers.
  altFilePaths?: string[];
  // Partial md5 hash of the book file, used as the unique identifier
  hash: string;
  // Metadata md5 hash, used to aggregate different versions of the same book
  metaHash?: string;
  // Partial MD5 of the *original* TXT source file, recorded only for TXT
  // imports whose stored book file is the converted EPUB. Lets a re-import
  // hash the cheap source first and skip the whole TXT→EPUB conversion on a
  // dedup hit instead of converting again just to discover "already exists".
  sourceHash?: string;
  format: BookFormat;
  title: string; // editable title from metadata
  sourceTitle?: string; // parsed when the book is imported and used to locate the file
  author: string;
  group?: string; // deprecated in favor of groupId and groupName
  groupId?: string;
  groupName?: string;
  tags?: string[];
  coverImageUrl?: string | null;
  // Partial MD5 of the local cover.png. Content-addressed cover-change signal:
  // a peer re-downloads the cover iff its synced value differs from the local
  // one (issue #4544). Invariant: coverHash === partialMD5(cover.png).
  coverHash?: string | null;

  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;

  uploadedAt?: number | null;
  downloadedAt?: number | null;
  coverDownloadedAt?: number | null;
  // Field-level LWW timestamp for the cover, so a page-turn that wins whole-row
  // LWW on updatedAt cannot clobber a cover edit (mirrors readingStatusUpdatedAt).
  coverUpdatedAt?: number | null;
  syncedAt?: number | null;

  lastUpdated?: number; // deprecated in favor of updatedAt
  progress?: [number, number]; // Add progress field: [current, total], 1-based page number
  readingStatus?: ReadingStatus;
  readingStatusUpdatedAt?: number; // ms; bumped only when readingStatus changes
  // Manual sort position on the shelf (undefined until the user drags the
  // book to reorder it; the Manual sort dimension groups unset books last).
  shelfIndex?: number;
  primaryLanguage?: string;
  // The book carries its own recorded narration (EPUB 3 Media Overlays), so the
  // library can badge it without opening the file. Derived from the file on
  // every import, like `format` — not user data, so it needs no LWW timestamp.
  hasNarration?: boolean;
  // 正文字数（非空白字符数），导入时由原生解析器或 TXT 转换器顺带算出。
  // 派生字段，同 hasNarration：不是用户数据、不需要 LWW 时钟。用于版本对比弹窗
  // 在"目录退化"时改比正文规模——两侧都不能为此现场解析文件。
  // 历史记录没有这个字段时按"未记录"显示，下次刷新元数据补上。
  textLength?: number;
  // 用户在版本冲突弹窗里对这本选了「撤销导入」的时刻。派生标记：只表示"本机用户
  // 拒绝过这次导入"，不是用户数据、不参与 LWW。带它的记录再导入同一个文件时不走
  // "静默复活"的短路，而是当新记录处理（按需补回书文件、重新提问）；用户重新接受
  // 后清除。书库里的普通删除不写这个标记——那不是"拒绝这次导入"。
  importRejectedAt?: number;

  metadata?: BookMetadata;
  // Field-level LWW timestamp for the metadata group (title, author, tags,
  // metadata), so a page-turn that wins whole-row LWW on updatedAt cannot
  // clobber a metadata edit (mirrors readingStatusUpdatedAt / coverUpdatedAt).
  metadataUpdatedAt?: number | null;
}

export interface BookGroupType {
  id: string;
  name: string;
}

export interface PageInfo {
  current: number;
  next?: number;
  total: number;
}

// Remaining time of the book in minutes
export interface TimeInfo {
  section: number;
  total: number;
}

export interface BookNote {
  bookHash?: string;
  metaHash?: string;
  id: string;
  type: BookNoteType;
  cfi: string; // Canonicalized CFI for the note location
  xpointer0?: string; // Start XPointer for the note location
  xpointer1?: string; // End XPointer for the note location
  page?: number;
  text?: string;
  style?: HighlightStyle;
  color?: HighlightColor;
  note: string;
  /**
   * If true, this annotation should be applied to every occurrence of `text`
   * within the same section (chapter/spine item), in addition to the original
   * range identified by `cfi`. Defaults to false / undefined (single-range).
   * Only meaningful for annotations that have a `text` value; ignored for
   * bookmarks and excerpts, and for fixed-layout formats (e.g. PDF).
   */
  global?: boolean;

  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
}

export interface BooknoteGroup {
  id: number;
  href: string;
  label: string;
  booknotes: BookNote[];
}

export type WritingMode = 'auto' | 'horizontal-tb' | 'horizontal-rl' | 'vertical-rl';

export interface BookLayout {
  marginTopPx: number;
  marginBottomPx: number;
  marginLeftPx: number;
  marginRightPx: number;
  marginPx?: number; // deprecated
  compactMarginTopPx: number;
  compactMarginBottomPx: number;
  compactMarginLeftPx: number;
  compactMarginRightPx: number;
  compactMarginPx?: number; // deprecated
  gapPercent: number;
  scrolled: boolean;
  scrolledDirection: 'vertical' | 'horizontal';
  webtoonMode: boolean;
  noContinuousScroll: boolean;
  disableClick: boolean;
  disableSwipe: boolean;
  fullscreenClickArea: boolean;
  swapClickArea: boolean;
  disableDoubleClick: boolean;
  volumeKeysToFlip: boolean;
  maxColumnCount: number;
  maxInlineSize: number;
  maxBlockSize: number;
  writingMode: WritingMode;
  vertical: boolean;
  rtl: boolean;
  scrollingOverlap: number;
  hideScrollbar: boolean;
  /* Auto Scroll (#4998) speed as a percentage; 100 = AUTO_SCROLL_BASE_PX_PER_SEC. */
  autoScrollSpeed: number;
}

export interface BookStyle {
  zoomLevel: number;
  paragraphMargin: number;
  lineHeight: number;
  wordSpacing: number;
  letterSpacing: number;
  textIndent: number;
  fullJustification: boolean;
  hyphenation: boolean;
  theme: string;
  backgroundTextureId: string;
  backgroundOpacity: number;
  backgroundSize: string;
  highlightOpacity: number;
  codeHighlighting: boolean;
  codeLanguage: string;
  userStylesheet: string;
  userUIStylesheet: string;

  overrideFont: boolean;
  overrideLayout: boolean;
  overrideColor: boolean;
  useBookLayout: boolean;

  // fixed-layout specific
  zoomMode: 'fit-page' | 'fit-width' | 'original-size' | 'custom';
  spreadMode: 'auto' | 'none';
  keepCoverSpread: boolean;
  invertImgColorInDark: boolean;
  applyThemeToPDF: boolean;
  contrast: number;
}

export interface BookFont {
  serifFont: string;
  sansSerifFont: string;
  monospaceFont: string;
  defaultFont: string;
  defaultCJKFont: string;
  /**
   * The configured reading font size — the zoom anchor. Never changed by the
   * Ctrl+wheel zoom; it stays as the user's "default" so zoom is bounded to
   * [minimumFontSize, defaultFontSize]. When the user edits it (settings
   * panel / footer slider), effectiveFontSize resets and the live size snaps
   * back to it.
   */
  defaultFontSize: number;
  /** Smallest the rendered text may ever be (a floor, see --min-font-size). */
  minimumFontSize: number;
  /**
   * The live font size adjusted by Ctrl+wheel zoom, clamped into
   * [minimumFontSize, defaultFontSize]. Absent (never zoomed) => rendered size
   * is defaultFontSize. Persisted separately so zooming never drifts the
   * configured default.
   */
  effectiveFontSize?: number;
  fontWeight: number;
}

export type ConvertChineseVariant =
  | 'none'
  | 's2t'
  | 't2s'
  | 's2tw'
  | 's2hk'
  | 's2twp'
  | 'tw2s'
  | 'hk2s'
  | 'tw2sp';

export interface BookLanguage {
  replaceQuotationMarks: boolean;
  convertChineseVariant: ConvertChineseVariant;
}

// 'push' slides the whole strip; 'slide' and 'curl' layer the outgoing page
// over the still incoming page (Apple Books style, needs View Transitions).
export type PageTurnStyle = 'push' | 'slide' | 'curl';
export interface ViewConfig {
  sideBarTab: string;
  uiLanguage: string;
  sortedTOC: boolean;

  doubleBorder: boolean;
  borderColor: string;

  showHeader: boolean;
  showFooter: boolean;
  showRemainingTime: boolean;
  showRemainingPages: boolean;
  showProgressInfo: boolean;
  showCurrentTime: boolean;
  use24HourClock: boolean;
  showCurrentBatteryStatus: boolean;
  showBatteryPercentage: boolean;
  showPaginationButtons: boolean;
  showNotebookButton: boolean;
  showBookmarkButton: boolean;
  showPageNavigationButtons: boolean;
  showChapterNavigationButtons: boolean;
  showSideBar: boolean;
  showGoToLibraryButton: boolean;
  showAnnotationQuickActionButton: boolean;
  progressStyle: 'percentage' | 'fraction' | 'reference';
  referencePageCount: number;

  animated: boolean;
  pageTurnStyle: PageTurnStyle;
  isEink: boolean;
  isColorEink: boolean;

  paragraphMode: ParagraphModeConfig;

  readingRulerEnabled: boolean;
  readingRulerLines: number;
  readingRulerPosition: number;
  readingRulerOpacity: number;
  readingRulerColor: ReadingRulerColor;
}

export interface TTSConfig {
  ttsRate: number;
  ttsSentenceGap: number;
  ttsParagraphGap: number;
  ttsVoice: string;
  // Prefer the book's own recorded narration (EPUB 3 Media Overlays) over
  // synthesized speech. Defaults on, so a read-along book is read by its
  // narrator; picking a synthetic voice while that book is open clears it.
  // Distinct from ttsVoice because ttsVoice inherits the global default and so
  // cannot tell "never chose" from "chose a synthetic voice for this book".
  ttsUseNarration: boolean;
  ttsLocation: string;
  ttsHighlightOptions: TTSHighlightOptions;
  ttsHighlightGranularity: TTSHighlightGranularity;
  ttsMediaMetadata: TTSMediaMetadataMode;
  ttsPlayerStyle: TTSPlayerStyle;
}

export interface TranslatorConfig {
  translationEnabled: boolean;
  translationProvider: string;
  translateTargetLang: string;
  showTranslateSource: boolean;
  ttsReadAloudText: string;
}

// Markdown and plain text render the note template; JSON emits the
// machine-readable file that Readest itself can import back (#5400).
export type NoteExportFormat = 'markdown' | 'text' | 'json';

export interface NoteExportConfig {
  includeTitle: boolean;
  includeAuthor: boolean;
  includeDate: boolean;
  // Include a public cover image link; requires publishing the cover to the
  // public bucket (sign-in) unless the book already has a public cover URL.
  includeCoverImage: boolean;
  includeChapterTitles: boolean;
  includeQuotes: boolean;
  includeNotes: boolean;
  includePageNumber: boolean;
  includeTimestamp: boolean;
  includeChapterSeparator: boolean;
  noteSeparator: string;
  useCustomTemplate: boolean;
  customTemplate: string;
  // Superseded by `exportFormat`; kept so configs written before the JSON
  // option existed still pick the right format on load.
  exportAsPlainText: boolean;
  exportFormat: NoteExportFormat;
  // Highlight colors/styles to omit from the export. Empty arrays export
  // everything; storing exclusions keeps colors/styles added later included
  // by default (#4801).
  excludedColors: HighlightColor[];
  excludedStyles: HighlightStyle[];
}

export interface AnnotatorConfig {
  enableAnnotationQuickActions: boolean;
  annotationQuickAction: AnnotationToolType | null;
  annotationToolbarItems: AnnotationToolType[];
  copyToNotebook: boolean;
  noteExportConfig: NoteExportConfig;
}

export interface WordLensConfig {
  wordLensEnabled: boolean;
  /** Difficulty slider, 1 (fewest hints) .. 5 (most hints). */
  wordLensLevel: number;
  /** Hint (target) language; '' = auto (app UI language). */
  wordLensHintLang: string;
  /** Gloss (<rt>) font size relative to the word, in em (default 0.5). */
  wordLensGlossFontSize: number;
  /** Gloss (<rt>) color as a hex string; '' = default (muted, theme-adaptive). */
  wordLensGlossColor: string;
}

export interface ScreenConfig {
  screenOrientation: 'auto' | 'portrait' | 'landscape';
}

export type ProofreadScope = 'selection' | 'book' | 'library';

export interface ProofreadRule {
  id: string;
  scope: ProofreadScope;
  pattern: string;
  replacement: string;
  cfi?: string;
  sectionHref?: string;
  enabled: boolean;
  isRegex: boolean;
  order: number; // Lower numbers apply first
  wholeWord?: boolean; // Match whole words only (uses \b word boundaries)
  caseSensitive?: boolean; // Case-sensitive matching (default true)
  onlyForTTS?: boolean; // Only replace text for TTS, not in the book display (only for book/library scope)
  // CRDT sync fields (book/selection scope rides the book-config sync). `updatedAt`
  // is the last-write-wins key for the per-id merge; `deletedAt` is a tombstone so a
  // deletion survives the merge instead of being resurrected by the peer's copy.
  // Library-scope rules sync via the settings replica (whole-field LWW) and don't
  // need a tombstone, so these stay optional for back-compat with older configs.
  updatedAt?: number;
  deletedAt?: number | null;
}

export interface ProofreadRulesConfig {
  proofreadRules?: ProofreadRule[];
}

export interface ViewSettingsConfig {
  isGlobal: boolean;
}

export interface ViewSettings
  extends BookLayout,
    BookStyle,
    BookFont,
    BookLanguage,
    ViewConfig,
    TTSConfig,
    TranslatorConfig,
    ScreenConfig,
    ProofreadRulesConfig,
    AnnotatorConfig,
    WordLensConfig,
    ViewSettingsConfig {}

export interface BookProgress {
  location: string;
  sectionHref: string;
  sectionLabel: string;
  section: PageInfo;
  pageinfo: PageInfo;
  pageItem?: { label?: string; href?: string } | null;
  timeinfo: TimeInfo;
  // Overall reading position in foliate's size-domain (0..1), matching the
  // domain used by the sticky progress bar's chapter ticks.
  fraction: number;
  index: number;
  range: Range;
  page: number;
}

export type SearchMode = 'contains' | 'whole-words' | 'regex' | 'nearby-words';

export interface BookSearchConfig {
  scope: 'book' | 'section';
  mode: SearchMode;
  matchCase: boolean;
  matchDiacritics: boolean;
  // nearby-words: maximum number of words separating the matched words
  nearbyWords?: number;
  /** @deprecated since schema v3 — mirrors `mode === 'whole-words'`; kept for sync wire back-compat. */
  matchWholeWords?: boolean;
  index?: number;
  query?: string;
  acceptNode?: (node: Node) => number;

  // pre-cached search results
  results?: BookSearchResult[] | BookSearchMatch[] | null;
}

export type LibrarySearchConfig = Omit<BookSearchConfig, 'mode'> & {
  mode: SearchMode | 'fuzzy';
};

export type LibrarySearchTarget = 'books' | 'text';

export interface SearchExcerpt {
  pre: string;
  match: string;
  post: string;
  // nearby-words: the cluster window split into matched (emphasized) words and gaps
  segments?: { text: string; emphasized: boolean }[];
}

export interface BookSearchMatch {
  cfi: string;
  // nearby-words: per-word CFIs to highlight (>= 2); absent for single-span matches
  cfis?: string[];
  excerpt: SearchExcerpt;
}

// Text-offset locator into a section's extracted text. Library search results
// carry locators instead of CFIs; the CFI is resolved lazily on click so
// searching never needs live DOM Ranges (see librarySearchService).
export interface SearchResultLocator {
  section: number;
  start: number;
  end: number;
  // fuzzy/nearby: matched sub-spans within [start, end)
  runs?: { start: number; end: number }[];
}

export interface LibrarySearchMatch {
  locator: SearchResultLocator;
  excerpt: SearchExcerpt;
}

export interface LibrarySearchSectionResult {
  index: number;
  label: string;
  subitems: LibrarySearchMatch[];
}

export interface BookSearchResult {
  index?: number;
  label: string;
  subitems: BookSearchMatch[];
  progress?: number;
}

export interface VirtualTocEntry {
  label: string;
  /** epubcfi(...) 字符串；侧栏 goTo 原生支持 CFI 目标（view.js resolveNavigation）。 */
  cfi: string;
  source: 'pattern' | 'section';
  generatedAt: number;
  /** 近似 location（与 SectionItem.location 同口径：字节 / SIZE_PER_LOC）。
   *  扫描时按「section 前累计字节 + 命中处文本占比 × section 字节」估算，供页码
   *  显示与 sortedTOC 排序使用。旧 config 里的条目无此字段——行为同现状，
   *  重新生成即升级，不做迁移。 */
  location?: { current: number; next: number; total: number };
}

export const BOOK_CONFIG_SCHEMA_VERSION = 3;

export interface BookConfig {
  schemaVersion?: number;
  bookHash?: string;
  metaHash?: string;
  progress?: [number, number]; // [current pagenum, total pagenum], 1-based page number
  location?: string; // CFI of the current location
  xpointer?: string; // XPointer of the current location (for Koreader interoperability)
  booknotes?: BookNote[];
  rsvpPosition?: { cfi: string; wordText: string };
  searchConfig?: Partial<BookSearchConfig>;
  /** 用户生成的虚拟目录（EPUB 目录元数据缺失/退化时）。用户数据，存 config.json
   *    而非 nav.json（后者随 BOOK_NAV_VERSION 重建）。 */
  virtualToc?: VirtualTocEntry[];
  viewSettings?: Partial<ViewSettings>;

  lastSyncedAtConfig?: number;
  lastSyncedAtNotes?: number;
  lastPushedAtConfig?: number;
  lastPushedAtNotes?: number;
  foliateImportedAt?: number;

  updatedAt: number;
}

export interface BookDataRecord {
  id: string;
  book_hash: string;
  meta_hash?: string;
  user_id: string;
  updated_at: number | null;
  deleted_at: number | null;
  // Server-assigned incremental-pull cursor, decoupled from updated_at (the
  // client event time / sort key). Present on books rows from a server that
  // ran migration 016; absent (fall back to updated_at) on older servers and
  // on config/note records. Carried over the wire as an ISO-8601 string.
  // See issue #4678.
  synced_at?: string | null;
  // Only book records carry an upload state: a book is indexed in the cloud
  // as soon as its metadata syncs, but is unavailable to peers until its file
  // blob is uploaded. Absent on config/note records.
  uploaded_at?: string | null;
}

export interface BooksGroup {
  id: string;
  name: string;
  displayName: string;
  books: Book[];

  updatedAt: number;
  /**
   * Manual-sort key for groups that carry no books (empty persisted groups):
   * their position can't come from a member book's `shelfIndex`, so the bookshelf
   * stamps the group's order in its persistent-name list here. Absent for groups
   * derived from books.
   */
  manualOrder?: number;
}
export interface BookContent {
  book: Book;
  file: File;
}
