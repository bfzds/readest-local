import { partialMD5 } from './md5';
import { getBaseFilename } from './path';
import { detectLanguage } from './lang';
import { configureZip } from './zip';
import { parsePixivNovelFilename, parsePixivNovelMetaHeader } from './pixivNovel';

// ---------------------------------------------------------------------------
// 章节标题规则表（方向②：规则数据化，便于扩展新语言 / 新格式）。
// 每种语言是一组 chapter 正则（按顺序构成 fallback 链，第一条"切得合格"即胜出）。
// 没有专门规则的语言回退到 '*'（通用英文规则），行为与旧"非 zh 走英文"一致。
// 'source' 为完整 RegExp source（含行首锚点与捕获组），'flags' 为标志位。
// ---------------------------------------------------------------------------
type ChapterRule = { source: string; flags: string };

const ZH_NUMBER = '第[ 　零〇一二三四五六七八九十0-9][ 　零〇一二三四五六七八九十百千万0-9]*';
const ZH_CHAPTER_UNIT = String.raw`[章节回讲篇话](?:[：:、 　\(\)0-9]*[^\n-]{0,36})`;
const ZH_VOLUME_UNIT = String.raw`[卷本册部封](?:[：:、 　\(\)][：:、 　\(\)0-9]*[^\n-]{0,36})?`;

const EN_NUMBER = String.raw`(?:\d+|(?:[IVXLCDM]{2,}|V|X|L|C|D|M)\b)`;
const EN_DOT_NUMBER = String.raw`\.\d{1,4}`;
const EN_TITLE = String.raw`[^\n]{0,50}`;
const EN_NORMAL = ['Chapter', 'Part', 'Section', 'Book', 'Volume', 'Act']
  .map((k) => String.raw`${k}\s*(?:${EN_NUMBER}|${EN_DOT_NUMBER})(?:[:.\-–—]?\s*${EN_TITLE})?`)
  .join('|');
const EN_PREFACE = ['Prologue', 'Epilogue', 'Introduction', 'Foreword', 'Preface', 'Afterword']
  .map((k) => String.raw`${k}(?:[:.\-–—]?\s*${EN_TITLE})?`)
  .join('|');

const EN_RULES: ChapterRule[] = [
  {
    source: String.raw`(?:^|\n)(${EN_NORMAL}|${EN_PREFACE})(?=\s|$)`,
    flags: 'gi',
  },
  {
    // 裸编号标题：1.1The Elements / 1Building Data（单数字要求标题紧跟，避开脚注）
    source: String.raw`(?:^|\n)(\d+\.\d+(?:\.\d+)* ?[A-Z][^\n]{0,80}|\d+[A-Z][^\n]{0,80})`,
    flags: 'g',
  },
];

const CHAPTER_RULES: Record<string, ChapterRule[]> = {
  zh: [
    {
      // 第N章/节/回/讲/篇/话 + 第N卷/本/册/部/封 + 前言类 + 英文式 chapter N。
      // 卷/册等单位要求标题由分隔符或行尾引入，避免"第一本书"被误当标题（#4658）。
      // 标题前允许可选【】包裹（【...】），避免带方括号的章节被整条漏掉。
      source:
        String.raw`(?:^|\n)\s*(?:【)?(` +
        [
          String.raw`${ZH_NUMBER}(?:${ZH_CHAPTER_UNIT}|${ZH_VOLUME_UNIT})(?!\S)`,
          String.raw`(?:楔子|前言|简介|引言|序言|序章|总论|概论|后记|番外篇|番外|外传)(?:[：: 　][^\n-]{0,36})?(?:】)?(?!\S)`,
          String.raw`chapter[\s.]*[0-9]+(?:[：:. 　]+[^\n-]{0,50})?(?!\S)`,
        ].join('|') +
        ')',
      flags: 'gui',
    },
    {
      // 第二级：中文序数词开头行，或纯数字编号行（同样容忍【】前缀）。
      // 注意必须只保留外层一个捕获组：String.split 会为每个捕获组各插入
      // 一个元素，多余嵌套组会使 extractChaptersFromSegment 的 j += 2 配对
      // 全面错位（标题重复进正文、正文行变标题）。
      source:
        String.raw`(?:^|\n)\s*(?:【)?(` +
        [
          String.raw`[一二三四五六七八九十][零〇一二三四五六七八九十百千万]?[：:、 　][^\n-]{0,36}(?=\n|$)`,
          String.raw`[0-9]+[^\n]{0,16}(?=\n|$)`,
        ].join('|') +
        ')',
      flags: 'gu',
    },
  ],
  ja: [
    {
      // 第X話/章/巻/編/節 + 序章/前/后言
      source: String.raw`(?:^|\n)\s*(第[０-９0-9一二三四五六七八九十百千]+(?:話|章|巻|編|節)(?:[：:、 　][^\n-]{0,40})?(?!\S)|(?:序章|プロローグ|エピローグ|あとがき))`,
      flags: 'u',
    },
    EN_RULES[1]!,
  ],
  ko: [
    {
      // 제X장/권/편/막 + 서장/프롤로그/에필로그
      source: String.raw`(?:^|\n)\s*(제\s*[0-9一二三四五六七八九十百]+(?:장|권|편|막)(?:[：:、 　][^\n-]{0,40})?(?!\S)|(?:서장|프롤로그|에필로그))`,
      flags: 'u',
    },
    EN_RULES[1]!,
  ],
  en: EN_RULES,
  '*': EN_RULES,
};

// ---------------------------------------------------------------------------
// 方向③用户自定义章节正则：解析 + 安全校验。
// ---------------------------------------------------------------------------
// 每行一条规则。用户正则里 ',' 是高频合法字符（量词 {1,3}、字符类等），
// 故只按换行切分，绝不把逗号当分隔符，避免 "第[0-9]{1,3}章" 被误拆。
export const parseChapterPatterns = (input: string): string[] =>
  input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

// ---------------------------------------------------------------------------
// 引导式章节识别："候选标题行"提取 + 勾选行 → 识别规则生成。
// createChapterRegexps 会把生成的 pattern 再包行锚/捕获组并置于内置规则之前，
// 所以这里返回的 pattern 只需匹配"标题行内容"。
// ---------------------------------------------------------------------------
// 候选标题行特征：行首必须是标题引导字，且整行不跨行长（行长过滤由上方
// s.length>40 处理）。曾用 `|章|回|更|卷|部|話` 的任意位置单字分支，会把
// "本章说：感谢打赏""更新说明：作者有话说""下部预告"这类正文行误作标题——
// 短正文行密集的书里 40 个候选名额会被正文占满。
const CHAPTER_CANDIDATE_TITLE_RX = /^[第卷回楔序【後记终扉][^\n]{0,40}$/;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isNumChar = (ch: string): boolean =>
  ch.length > 0 && /[0-9零〇一二三四五六七八九十百千万]/.test(ch);

const NUM_WILDCARD = '[0-9零〇一二三四五六七八九十百千万]+';

export const buildChapterPatternFromSamples = (samples: string[]): string | null => {
  const trimmed = samples.map((s) => s.trim()).filter((s) => s.length > 0);
  if (trimmed.length === 0) return null;

  const first = trimmed[0]!;
  let out = '';
  let i = 0;
  // 贪心对齐公共前缀：字符一致则保留（数字区段统一通配化，覆盖"第X章"里
  // 递增的数字）；首个字符即非数字分歧 → 放弃对齐，退化为字面量 alternation。
  while (i < first.length) {
    const ch = first[i]!;
    const allSame = trimmed.every((s) => s[i] === ch);
    if (allSame) {
      if (isNumChar(ch)) {
        out += NUM_WILDCARD;
        while (i < first.length && trimmed.every((s) => isNumChar(s[i] ?? ''))) i++;
        continue;
      }
      out += escapeRegExp(ch);
      i++;
    } else if (trimmed.every((s) => isNumChar(s[i] ?? ''))) {
      out += NUM_WILDCARD;
      while (i < first.length && trimmed.every((s) => isNumChar(s[i] ?? ''))) i++;
    } else {
      break;
    }
  }

  // 尾段通配给长度上限：无界 [^\n]* 会把"数字+点"开头的超长正文行整句吞成
  // 章节标题。60 足以覆盖典型章节标题长度，同时收窄误伤面。
  if (out.length >= 2) return `${out}[^\\n]{0,60}`;
  if (trimmed.length <= 40) return trimmed.map((s) => escapeRegExp(s)).join('|');
  return null;
};

// 轻量编码探测（与类内 detectEncodingFromFile 同源思路，聚焦中文 TXT 常见
// 编码）：utf-8 严格校验 → utf-16 BOM → 高字节比例判 GBK/GB18030。此前候选
// 提取只试 utf-8→gb18030 两档，UTF-16 文件被当 gb18030 解出 mojibake、候选
// 为空，导致引导功能对 UTF-16 TXT 失效。
const detectTxtEncodingFromFile = async (file: File): Promise<string> => {
  const headSampleSize = Math.min(file.size, ENCODING_HEAD_SAMPLE_BYTES);
  const headSample = new Uint8Array(await file.slice(0, headSampleSize).arrayBuffer());
  if (headSample.length >= 2 && headSample[0] === 0xff && headSample[1] === 0xfe) return 'utf-16le';
  if (headSample.length >= 2 && headSample[0] === 0xfe && headSample[1] === 0xff) return 'utf-16be';
  if (
    headSample.length >= 3 &&
    headSample[0] === 0xef &&
    headSample[1] === 0xbb &&
    headSample[2] === 0xbf
  ) {
    return 'utf-8';
  }
  const sample = headSample.slice(0, Math.min(8192, headSample.length));
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return 'utf-8';
  } catch {
    let highByteCount = 0;
    for (let i = 0; i < sample.length; i++) {
      if (sample[i]! >= 0x80) highByteCount++;
    }
    return sample.length > 0 && highByteCount / sample.length > 0.05 ? 'gb18030' : 'utf-8';
  }
};

export const extractTxtChapterCandidates = async (file: File, max = 40): Promise<string[]> => {
  const encoding = await detectTxtEncodingFromFile(file);
  const seen = new Set<string>();
  const out: string[] = [];
  const consider = (rawLine: string): boolean => {
    const s = rawLine.trim();
    if (!s || s.length > 40) return false;
    if (!CHAPTER_CANDIDATE_TITLE_RX.test(s)) return false;
    if (seen.has(s)) return false;
    seen.add(s);
    out.push(s);
    return out.length >= max;
  };

  const decoder = new TextDecoder(encoding);
  let buffer = '';
  try {
    for await (const chunk of file.stream()) {
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const nl = buffer.search(/\r?\n/);
        if (nl === -1) break;
        const step = buffer[nl] === '\r' ? 2 : 1;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + step);
        if (consider(line)) return out;
      }
    }
  } catch {
    // 流读取/解码异常（少见）：放弃逐块解码，剩余缓冲仍可兜底处理，不阻断引导
  }
  if (buffer) consider(buffer.slice(0, 400));
  return out;
};

// 用户输入进构造正则的路径，`new RegExp` 只捕语法错误、不防灾难性回溯
// （catastrophic backtracking）：病态正则如 (a+)+ 在长文本上是指数回溯。
// 这里做启发式守门（宁可放过不明显病态、也不误伤正常规则），超限的规则
// 拒用并返回原因。返回空数组=可安全使用。
const REDOS_PATTERN_LENGTH_LIMIT = 512;
const REDOS_PATTERN_MAX_DEPTH = 4;

export const validateChapterPattern = (pattern: string): string[] => {
  const problems: string[] = [];
  if (pattern.length > REDOS_PATTERN_LENGTH_LIMIT) {
    problems.push(`超过长度上限 ${REDOS_PATTERN_LENGTH_LIMIT} 字符`);
    return problems;
  }
  // 分组嵌套深度（跳过转义与字符类内的括号）。
  let depth = 0;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') {
      while (i < pattern.length && pattern[i] !== ']') i++;
      i++;
      continue;
    }
    if (c === '(') {
      depth++;
      if (depth > REDOS_PATTERN_MAX_DEPTH) {
        problems.push(`分组嵌套过深（>${REDOS_PATTERN_MAX_DEPTH} 层）`);
        break;
      }
    } else if (c === ')') {
      depth = Math.max(0, depth - 1);
    }
    i++;
  }
  if (problems.length > 0) return problems;
  // 嵌套量词链：一对不含嵌套括号的组内含量词、且闭组后又跟量词，是灾难性
  // 回溯的高发形态（(a+)+、(?:\\d+|x)* 等）。量词含区间形态 {n,m}——只认
  // 单字符量词会漏掉 (a+){20}、（?:\d+）{10} 这类炸弹，须一并拦截。
  if (/\([^()]*[+*?][^()]*\)(?:[+*?]|\{\d+(?:,\d+)?\})/.test(pattern)) {
    problems.push('检测到可能灾难性回溯的嵌套量词');
  }
  return problems;
};

interface Metadata {
  bookTitle: string;
  author: string;
  language: string;
  identifier: string;
}

// Pull a title and (optionally) an author out of a TXT filename. Recognized
// patterns center on Chinese conventions where books are named with the title
// in 《》 and an author tacked on, e.g. 《书名》作者：张三.txt, 《书名》[张三].txt,
// 《书名》张三.txt. Falls back to the base filename as the title when no
// 《》 are present.
export const extractTxtFilenameMetadata = (
  filename: string,
  sourcePath?: string,
): { title: string; author?: string } => {
  const base = getBaseFilename(filename);
  const pixivMeta = parsePixivNovelFilename(sourcePath || filename);
  if (pixivMeta) {
    return {
      title: pixivMeta.title,
      ...(pixivMeta.author ? { author: pixivMeta.author } : {}),
    };
  }
  const cjkMatch = base.match(/《([^》]+)》(.*)/);
  if (!cjkMatch) {
    // No 《》 wrapper: keep the whole filename as the title (web-novel files use
    // 【】 brackets for the title and tack the author on, e.g.
    // 【书名】1-129 作者：起落.txt). Only the labeled "作者：X" form is safe to pull
    // here — a bracketed/bare fallback would mistake a leading 【title】 for the
    // author. See issue #4390.
    const author = parseLabeledAuthor(base);
    return author ? { title: base, author } : { title: base };
  }
  const title = cjkMatch[1]!.trim();
  const rest = (cjkMatch[2] ?? '').trim();
  const author = parseAuthorFragment(rest);
  return author ? { title, author } : { title };
};

// 作者：X / 作者:X / 作者 X — a labeled author. Returns '' when absent.
const parseLabeledAuthor = (text: string): string => {
  const labeled = text.match(/作者\s*[：:\s]\s*(.+)$/);
  return labeled ? stripWrappingPunctuation(labeled[1]!) : '';
};

const parseAuthorFragment = (text: string): string => {
  if (!text) return '';
  // 作者：X / 作者:X / 作者 X — labeled author wins
  const labeled = parseLabeledAuthor(text);
  if (labeled) return labeled;
  // [X] (X) 【X】 （X）［X］ — bracketed author
  const bracketed = text.match(/[[(（【［]\s*([^\])）】］]+?)\s*[\])）】］]/);
  if (bracketed) return stripWrappingPunctuation(bracketed[1]!);
  // bare token — strip any leading separator like " - " / "·" / "-"
  return stripWrappingPunctuation(text);
};

const stripWrappingPunctuation = (text: string): string => {
  const trimmed = text.trim();
  try {
    return trimmed.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '');
  } catch {
    return trimmed;
  }
};

// A header line like "作者：X" is meant to yield a short personal/pen name. Some
// web-novel TXT files instead carry a metadata blob there (e.g.
// "作者：2024/08/01发表于：是否首发：是 字数1023150字…") that the greedy capture would
// otherwise surface as the author. Reject values that look like such a blob —
// an embedded field separator (a second colon), a long digit run, or excessive
// length — so callers fall back to the filename's labeled author. See #4390.
const isPlausibleAuthorName = (name: string): boolean =>
  name.length > 0 && name.length <= 20 && !/[:：]/.test(name) && !/\d{4,}/.test(name);

interface Chapter {
  title: string;
  content: string;
  isVolume: boolean;
  // True when the title came from a detected chapter heading. Chapters whose
  // content was not found under a heading (paragraph fallback, or stray text
  // split off by the segment regex) are merged into the preceding detected
  // chapter instead of becoming bogus TOC entries. See issue #4063.
  detected?: boolean;
}

interface Txt2EpubOptions {
  file: File;
  author?: string;
  language?: string;
  /** Original import path; keeps Pixiv directory structure when available. */
  sourcePath?: string;
  /**
   * 用户自定义章节标题正则（方向③）。每项匹配"标题行内容"（不含行首空白），
   * 会自动包装行首锚点并置于内置规则之前、优先匹配。非法正则被安全忽略。
   */
  chapterPatterns?: string[];
}

interface ExtractChapterOptions {
  linesBetweenSegments: number;
  fallbackParagraphsPerChapter: number;
  chapterPatterns?: string[];
}

export interface ConversionResult {
  file: File;
  bookTitle: string;
  chapterCount: number;
  language: string;
}

const zipWriteOptions = {
  lastAccessDate: new Date(0),
  lastModDate: new Date(0),
};

const LARGE_TXT_THRESHOLD_BYTES = 8 * 1024 * 1024;
const HEADER_TEXT_MAX_CHARS = 1024;
const HEADER_TEXT_MAX_BYTES = 128 * 1024;
const ENCODING_HEAD_SAMPLE_BYTES = 64 * 1024;
const ENCODING_MID_SAMPLE_BYTES = 8192;

const escapeXml = (str: string) => {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
};

export class TxtToEpubConverter {
  public async convert(options: Txt2EpubOptions): Promise<ConversionResult> {
    if (options.file.size <= LARGE_TXT_THRESHOLD_BYTES) {
      return await this.convertSmallFile(options);
    }
    return await this.convertLargeFile(options);
  }

  private async convertSmallFile(options: Txt2EpubOptions): Promise<ConversionResult> {
    const { file: txtFile, author: providedAuthor, language: providedLanguage } = options;

    const fileContent = await txtFile.arrayBuffer();
    const detectedEncoding = this.detectEncoding(fileContent) || 'utf-8';
    const runtimeEncoding = this.resolveSupportedEncoding(detectedEncoding);
    // console.log(`Detected encoding: ${detectedEncoding}, runtime encoding: ${runtimeEncoding}`);
    const decoder = new TextDecoder(runtimeEncoding);
    const txtContent = decoder.decode(fileContent).trim();

    const sourcePath = options.sourcePath || txtFile.name;
    const filenameMeta = extractTxtFilenameMetadata(txtFile.name, sourcePath);
    const headerMeta = parsePixivNovelMetaHeader(txtContent);
    const bookTitle = headerMeta?.title || filenameMeta.title;
    const fileName = `${bookTitle}.epub`;

    const fileHeader = txtContent.slice(0, 1024);
    const authorMatch =
      fileHeader.match(/[【\[]?作者[】\]]?[:：\s]\s*(.+)\r?\n/) ||
      fileHeader.match(/[【\[]?\s*(.+)\s+著\s*[】\]]?\r?\n/);
    let matchedAuthor = authorMatch ? authorMatch[1]!.trim() : '';
    try {
      matchedAuthor = matchedAuthor.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
    } catch {}
    const headerAuthor = isPlausibleAuthorName(matchedAuthor) ? matchedAuthor : '';
    const author =
      headerMeta?.author || headerAuthor || filenameMeta.author || providedAuthor || '';
    const language = providedLanguage || detectLanguage(fileHeader);
    // console.log(`Detected language: ${language}`);
    const identifier = await partialMD5(txtFile);
    const metadata = { bookTitle, author, language, identifier };

    const fallbackParagraphsPerChapter = 100;
    let chapters = this.extractChapters(txtContent, metadata, {
      linesBetweenSegments: 8,
      fallbackParagraphsPerChapter,
      chapterPatterns: options.chapterPatterns,
    });

    if (chapters.length === 0) {
      throw new Error('No chapters detected.');
    }

    if (chapters.length <= 1) {
      const probeChapterCount = this.probeChapterCount(txtContent, metadata, {
        linesBetweenSegments: 7,
        fallbackParagraphsPerChapter,
        chapterPatterns: options.chapterPatterns,
      });
      chapters = this.extractChapters(txtContent, metadata, {
        linesBetweenSegments: probeChapterCount > 1 ? 7 : 6,
        fallbackParagraphsPerChapter,
        chapterPatterns: options.chapterPatterns,
      });
    }

    const blob = await this.createEpub(chapters, metadata);
    return {
      file: new File([blob], fileName),
      bookTitle,
      chapterCount: chapters.length,
      language,
    };
  }

  private async convertLargeFile(options: Txt2EpubOptions): Promise<ConversionResult> {
    const { file: txtFile, author: providedAuthor, language: providedLanguage } = options;
    const detectedEncoding = (await this.detectEncodingFromFile(txtFile)) || 'utf-8';
    const runtimeEncoding = this.resolveSupportedEncoding(detectedEncoding);
    // console.log(`Detected encoding: ${detectedEncoding}, runtime encoding: ${runtimeEncoding}`);

    const sourcePath = options.sourcePath || txtFile.name;
    const filenameMeta = extractTxtFilenameMetadata(txtFile.name, sourcePath);
    const fileHeader = await this.readHeaderTextFromFile(
      txtFile,
      runtimeEncoding,
      HEADER_TEXT_MAX_CHARS,
      HEADER_TEXT_MAX_BYTES,
    );
    const headerMeta = parsePixivNovelMetaHeader(fileHeader);
    const bookTitle = headerMeta?.title || filenameMeta.title;
    const fileName = `${bookTitle}.epub`;

    const { author, language } = this.extractAuthorAndLanguage(
      fileHeader,
      headerMeta?.author || (filenameMeta.author ?? providedAuthor),
      providedLanguage,
    );
    // console.log(`Detected language: ${language}`);
    const identifier = await partialMD5(txtFile);
    const metadata = { bookTitle, author, language, identifier };

    const fallbackParagraphsPerChapter = 100;
    let chapters = await this.extractChaptersFromFileBySegments(
      txtFile,
      runtimeEncoding,
      metadata,
      {
        linesBetweenSegments: 8,
        fallbackParagraphsPerChapter,
        chapterPatterns: options.chapterPatterns,
      },
    );

    if (chapters.length === 0) {
      throw new Error('No chapters detected.');
    }

    if (chapters.length <= 1) {
      const probeChapterCount = await this.probeChapterCountFromFileBySegments(
        txtFile,
        runtimeEncoding,
        metadata,
        {
          linesBetweenSegments: 7,
          fallbackParagraphsPerChapter,
          chapterPatterns: options.chapterPatterns,
        },
      );
      chapters = await this.extractChaptersFromFileBySegments(txtFile, runtimeEncoding, metadata, {
        linesBetweenSegments: probeChapterCount > 1 ? 7 : 6,
        fallbackParagraphsPerChapter,
        chapterPatterns: options.chapterPatterns,
      });
    }

    const blob = await this.createEpub(chapters, metadata);
    return {
      file: new File([blob], fileName),
      bookTitle,
      chapterCount: chapters.length,
      language,
    };
  }

  private extractChapters(
    txtContent: string,
    metadata: Metadata,
    option: ExtractChapterOptions,
  ): Chapter[] {
    const { linesBetweenSegments } = option;
    const segmentRegex = this.createSegmentRegex(linesBetweenSegments);
    const chapters: Chapter[] = [];
    const segments = txtContent.split(segmentRegex);
    for (const segment of segments) {
      const segmentChapters = this.extractChaptersFromSegment(
        segment,
        metadata,
        option,
        chapters.length,
      );
      this.appendSegmentChapters(chapters, segmentChapters);
    }

    return chapters;
  }

  /**
   * Append a segment's chapters to the running list. The segment regex also
   * splits on dash dividers, which authors frequently use as in-chapter scene
   * breaks; the content after such a divider has no heading of its own. When a
   * heading-less chapter follows a detected chapter, merge its content into
   * that chapter instead of emitting a separate (bogus) TOC entry. See #4063.
   */
  private appendSegmentChapters(chapters: Chapter[], segmentChapters: Chapter[]): void {
    for (const chapter of segmentChapters) {
      const previous = chapters[chapters.length - 1];
      if (!chapter.detected && previous?.detected) {
        previous.content += chapter.content.replace(/^<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/, '');
      } else {
        chapters.push(chapter);
      }
    }
  }

  private probeChapterCount(
    txtContent: string,
    metadata: Metadata,
    option: ExtractChapterOptions,
  ): number {
    const { linesBetweenSegments } = option;
    const segmentRegex = this.createSegmentRegex(linesBetweenSegments);
    let chapterCount = 0;
    const segments = txtContent.split(segmentRegex);
    for (const segment of segments) {
      chapterCount += this.probeChapterCountFromSegment(segment, metadata, option);

      if (chapterCount > 1) {
        return chapterCount;
      }
    }

    return chapterCount;
  }

  private async extractChaptersFromFileBySegments(
    txtFile: File,
    encoding: string,
    metadata: Metadata,
    option: ExtractChapterOptions,
  ): Promise<Chapter[]> {
    const chapters: Chapter[] = [];
    for await (const segment of this.iterateSegmentsFromFile(
      txtFile,
      encoding,
      option.linesBetweenSegments,
    )) {
      const segmentChapters = this.extractChaptersFromSegment(
        segment,
        metadata,
        option,
        chapters.length,
      );
      this.appendSegmentChapters(chapters, segmentChapters);
    }
    return chapters;
  }

  private async probeChapterCountFromFileBySegments(
    txtFile: File,
    encoding: string,
    metadata: Metadata,
    option: ExtractChapterOptions,
  ): Promise<number> {
    let chapterCount = 0;
    for await (const segment of this.iterateSegmentsFromFile(
      txtFile,
      encoding,
      option.linesBetweenSegments,
    )) {
      chapterCount += this.probeChapterCountFromSegment(segment, metadata, option);
      if (chapterCount > 1) {
        return chapterCount;
      }
    }
    return chapterCount;
  }

  private async detectEncodingFromFile(file: File): Promise<string | undefined> {
    const headSampleSize = Math.min(file.size, ENCODING_HEAD_SAMPLE_BYTES);
    const headBuffer = await file.slice(0, headSampleSize).arrayBuffer();
    const headSample = new Uint8Array(headBuffer);

    try {
      this.assertStrictUtf8Sample(headSample);
      if (file.size > headSampleSize * 2) {
        const midSampleSize = Math.min(ENCODING_MID_SAMPLE_BYTES, file.size - headSampleSize);
        const midSampleStart = Math.floor((file.size - midSampleSize) / 2);
        const midBuffer = await file
          .slice(midSampleStart, midSampleStart + midSampleSize)
          .arrayBuffer();
        this.assertStrictUtf8Sample(new Uint8Array(midBuffer));
      }
      return 'utf-8';
    } catch {
      let validBytes = 0;
      let checkedBytes = 0;
      const sampleSize = Math.min(headSample.length, 10000);

      for (let i = 0; i < sampleSize; i++) {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(headSample.slice(i, i + 100));
          validBytes += 100;
          checkedBytes += 100;
          i += 99;
        } catch {
          checkedBytes++;
        }
      }

      const validPercentage = checkedBytes > 0 ? (validBytes / checkedBytes) * 100 : 0;
      console.log(`UTF-8 validity: ${validPercentage.toFixed(2)}%`);
      if (validPercentage > 80) {
        console.log('Treating as UTF-8 despite some invalid sequences');
        return 'utf-8';
      }
    }

    if (headSample[0] === 0xff && headSample[1] === 0xfe) {
      return 'utf-16le';
    }

    if (headSample[0] === 0xfe && headSample[1] === 0xff) {
      return 'utf-16be';
    }

    if (headSample[0] === 0xef && headSample[1] === 0xbb && headSample[2] === 0xbf) {
      return 'utf-8';
    }

    const sample = headSample.slice(0, Math.min(1024, headSample.length));
    let highByteCount = 0;
    for (let i = 0; i < sample.length; i++) {
      if (sample[i]! >= 0x80) {
        highByteCount++;
      }
    }

    const highByteRatio = sample.length > 0 ? highByteCount / sample.length : 0;
    if (highByteRatio > 0.3) {
      return 'gbk';
    }

    if (highByteRatio > 0.1) {
      let sjisPattern = false;
      for (let i = 0; i < sample.length - 1; i++) {
        const b1 = sample[i]!;
        const b2 = sample[i + 1]!;
        if (
          ((b1 >= 0x81 && b1 <= 0x9f) || (b1 >= 0xe0 && b1 <= 0xfc)) &&
          ((b2 >= 0x40 && b2 <= 0x7e) || (b2 >= 0x80 && b2 <= 0xfc))
        ) {
          sjisPattern = true;
          break;
        }
      }

      if (sjisPattern) {
        return 'shift-jis';
      }

      return 'gb18030';
    }

    return 'utf-8';
  }

  private async readHeaderTextFromFile(
    file: File,
    encoding: string,
    maxChars: number,
    maxBytes: number,
  ): Promise<string> {
    const decoder = new TextDecoder(encoding);
    const headerBytes = await file.slice(0, Math.min(file.size, maxBytes)).arrayBuffer();
    return decoder.decode(headerBytes).slice(0, maxChars).trim();
  }

  private async *iterateSegmentsFromFile(
    file: File,
    encoding: string,
    linesBetweenSegments: number,
  ): AsyncGenerator<string> {
    const reader = file.stream().getReader();
    const decoder = new TextDecoder(encoding);
    const segmentRegex = this.createSegmentRegex(linesBetweenSegments);
    let pending = '';
    let completed = false;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          completed = true;
          break;
        }
        if (!value) continue;
        pending += decoder.decode(value, { stream: true });
        const consumed = this.consumeCompleteSegments(pending, segmentRegex);
        pending = consumed.pending;
        for (const segment of consumed.segments) {
          yield segment;
        }
      }

      pending += decoder.decode();
      const consumed = this.consumeCompleteSegments(pending, segmentRegex);
      for (const segment of consumed.segments) {
        yield segment;
      }
      if (consumed.pending) {
        yield consumed.pending;
      }
    } finally {
      if (!completed) {
        try {
          await reader.cancel();
        } catch {}
      }
      reader.releaseLock();
    }
  }

  *iterateSegmentsFromTextChunks(
    chunks: Iterable<string>,
    linesBetweenSegments: number,
  ): Generator<string> {
    const segmentRegex = this.createSegmentRegex(linesBetweenSegments);
    let pending = '';

    for (const chunk of chunks) {
      pending += chunk;
      const consumed = this.consumeCompleteSegments(pending, segmentRegex);
      pending = consumed.pending;
      for (const segment of consumed.segments) {
        yield segment;
      }
    }

    if (pending) {
      yield pending;
    }
  }

  private consumeCompleteSegments(
    pending: string,
    segmentRegex: RegExp,
  ): { segments: string[]; pending: string } {
    const segments: string[] = [];
    let match = segmentRegex.exec(pending);
    while (match) {
      segments.push(pending.slice(0, match.index));
      pending = pending.slice(match.index + match[0].length);
      segmentRegex.lastIndex = 0;
      match = segmentRegex.exec(pending);
    }
    return { segments, pending };
  }

  private extractAuthorAndLanguage(
    fileHeader: string,
    providedAuthor?: string,
    providedLanguage?: string,
  ): { author: string; language: string } {
    const authorMatch =
      fileHeader.match(/[【\[]?作者[】\]]?[:：\s]\s*(.+)\r?\n/) ||
      fileHeader.match(/[【\[]?\s*(.+)\s+著\s*[】\]]?\r?\n/);
    let matchedAuthor = authorMatch ? authorMatch[1]!.trim() : '';
    try {
      matchedAuthor = matchedAuthor.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
    } catch {}
    const headerAuthor = isPlausibleAuthorName(matchedAuthor) ? matchedAuthor : '';
    const author = headerAuthor || providedAuthor || '';
    const language = providedLanguage || detectLanguage(fileHeader);
    return { author, language };
  }

  private extractChaptersFromSegment(
    segment: string,
    metadata: Metadata,
    option: ExtractChapterOptions,
    chapterOffset: number,
  ): Chapter[] {
    const { language } = metadata;
    const { fallbackParagraphsPerChapter } = option;
    let sanitizedSegment = segment;
    let previousSegment: string;
    do {
      previousSegment = sanitizedSegment;
      sanitizedSegment = sanitizedSegment.replace(/<!--.*?-->/gs, '');
    } while (sanitizedSegment !== previousSegment);
    const trimmedSegment = sanitizedSegment.trim();
    if (!trimmedSegment) return [];

    const chapterRegexps = this.createChapterRegexps(language, option.chapterPatterns);
    const maxLength = this.computeMaxLength(trimmedSegment);
    let matches: string[] = [];
    for (const chapterRegex of chapterRegexps) {
      const tryMatches = trimmedSegment.split(chapterRegex);
      if (this.isGoodMatches(tryMatches, maxLength)) {
        matches = this.joinAroundUndefined(tryMatches);
        break;
      }
    }

    if (matches.length === 0 && fallbackParagraphsPerChapter > 0) {
      const chapters: Chapter[] = [];
      const paragraphs = trimmedSegment.split(/\n+/);
      const totalParagraphs = paragraphs.length;
      for (let i = 0; i < totalParagraphs; i += fallbackParagraphsPerChapter) {
        const chunks = paragraphs.slice(i, i + fallbackParagraphsPerChapter);
        const formattedSegment = this.formatSegment(chunks.join('\n'));
        const title = `${chapterOffset + chapters.length + 1}`;
        const content = `<h2>${title}</h2><p>${formattedSegment}</p>`;
        chapters.push({ title, content, isVolume: false, detected: false });
      }
      return chapters;
    }

    const segmentChapters: Chapter[] = [];
    for (let j = 1; j < matches.length; j += 2) {
      const title = (matches[j]?.trim() || '').replace(/】+$/, '');
      const content = matches[j + 1]?.trim() || '';

      let isVolume = false;
      if (language === 'zh') {
        isVolume = /第[零〇一二三四五六七八九十百千万0-9]+(卷|本|册|部)/.test(title);
      } else {
        isVolume = /\b(Part|Volume|Book)\b/i.test(title);
      }

      const headTitle = isVolume ? `<h1>${title}</h1>` : `<h2>${title}</h2>`;
      const formattedSegment = this.formatSegment(content);
      segmentChapters.push({
        title: escapeXml(title),
        content: `${headTitle}<p>${formattedSegment}</p>`,
        isVolume,
        detected: true,
      });
    }

    if (matches[0] && matches[0].trim()) {
      const initialContent = matches[0].trim();
      const firstLine = initialContent.split('\n')[0]!.trim();
      const segmentTitle =
        (firstLine.length > 16 ? initialContent.split(/[\n\s\p{P}]/u)[0]!.trim() : firstLine) ||
        initialContent.slice(0, 16);
      const formattedSegment = this.formatSegment(initialContent);
      segmentChapters.unshift({
        title: escapeXml(segmentTitle),
        content: `<h3></h3><p>${formattedSegment}</p>`,
        isVolume: false,
        detected: false,
      });
    }

    return segmentChapters;
  }

  private probeChapterCountFromSegment(
    segment: string,
    metadata: Metadata,
    option: ExtractChapterOptions,
  ): number {
    const { language } = metadata;
    const { fallbackParagraphsPerChapter } = option;
    let sanitizedSegment = segment;
    let previousSegment: string;
    do {
      previousSegment = sanitizedSegment;
      sanitizedSegment = sanitizedSegment.replace(/<!--.*?-->/gs, '');
    } while (sanitizedSegment !== previousSegment);
    const trimmedSegment = sanitizedSegment.trim();
    if (!trimmedSegment) return 0;

    const chapterRegexps = this.createChapterRegexps(language, option.chapterPatterns);
    const maxLength = this.computeMaxLength(trimmedSegment);
    let matches: string[] = [];
    for (const chapterRegex of chapterRegexps) {
      const tryMatches = trimmedSegment.split(chapterRegex);
      if (this.isGoodMatches(tryMatches, maxLength)) {
        matches = this.joinAroundUndefined(tryMatches);
        break;
      }
    }

    if (matches.length === 0 && fallbackParagraphsPerChapter > 0) {
      const paragraphs = trimmedSegment.split(/\n+/);
      return Math.ceil(paragraphs.length / fallbackParagraphsPerChapter);
    }

    let chapterCount = Math.floor(matches.length / 2);
    if (matches[0] && matches[0].trim()) {
      chapterCount++;
    }
    return chapterCount;
  }

  private createSegmentRegex(linesBetweenSegments: number): RegExp {
    return new RegExp(`(?:\\r?\\n){${linesBetweenSegments},}|-{8,}\r?\n`);
  }

  private formatSegment(segment: string): string {
    segment = escapeXml(segment);
    return segment
      .replace(/-{8,}|_{8,}/g, '\n')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line)
      .join('</p><p>');
  }

  private joinAroundUndefined(arr: (string | undefined)[]): string[] {
    return arr.reduce<string[]>((acc, curr, i, src) => {
      if (
        curr === undefined &&
        i > 0 &&
        i < src.length - 1 &&
        src[i - 1] !== undefined &&
        src[i + 1] !== undefined
      ) {
        acc[acc.length - 1] += src[i + 1]!;
        return acc;
      }
      if (curr !== undefined && (i === 0 || src[i - 1] !== undefined)) {
        acc.push(curr);
      }
      return acc;
    }, []);
  }

  private isGoodMatches(matches: string[], maxLength: number = 100000): boolean {
    const meaningfulParts = matches.filter((part) => part && part.trim().length > 0);
    if (meaningfulParts.length <= 1) return false;

    const hasLongParts = meaningfulParts.some((part) => part.length > maxLength);
    return !hasLongParts;
  }

  /**
   * 章节匹配质量判定的超长阈值（方向①）：常规按空行分段的小段保持 10 万字符下限；
   * 整本未分段的超大 segment 单章可能超长（如合集里 11 万字的一章），阈值随段规模
   * 等比放大，避免"一本书里恰有一章超长"导致整条正则被误弃而退回纯数字兜底。
   */
  private computeMaxLength(segment: string): number {
    return Math.max(100000, Math.floor(segment.length / 10));
  }

  private createChapterRegexps(language: string, extraPatterns?: string[]): RegExp[] {
    const chapterRegexps: RegExp[] = [];

    // ③ 用户自定义章节正则（方向③）：每项匹配"标题行内容"，自动补行首锚点，
    // 置于最前优先匹配；new RegExp 抛错（非法规则）或 validateChapterPattern
    // 判为 ReDoS 病态（灾难性回溯）时安全忽略，不影响内置规则。
    for (const pattern of extraPatterns ?? []) {
      if (!pattern) continue;
      if (validateChapterPattern(pattern).length > 0) continue;
      try {
        chapterRegexps.push(new RegExp(String.raw`(?:^|\n)\s*(${pattern})`, 'u'));
      } catch {
        // 非法用户规则忽略
      }
    }

    // ② 语言规则表（方向②）：zh/ja/ko/en 各有专门规则，其余语言回退到通用规则。
    const rules = CHAPTER_RULES[language] ?? CHAPTER_RULES['*'] ?? [];
    for (const { source, flags } of rules) {
      chapterRegexps.push(new RegExp(source, flags));
    }

    return chapterRegexps;
  }

  private async createEpub(chapters: Chapter[], metadata: Metadata): Promise<Blob> {
    await configureZip();
    const { BlobWriter, TextReader, ZipWriter } = await import('@zip.js/zip.js');
    const { bookTitle, author, language, identifier } = metadata;

    const zipWriter = new ZipWriter(new BlobWriter('application/epub+zip'), {
      extendedTimestamp: false,
    });
    await zipWriter.add('mimetype', new TextReader('application/epub+zip'), zipWriteOptions);

    // Add META-INF/container.xml
    const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
      <rootfiles>
        <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
      </rootfiles>
    </container>`.trim();

    await zipWriter.add('META-INF/container.xml', new TextReader(containerXml), zipWriteOptions);

    // Create navigation points for TOC
    let isNested = false;
    let navPoints = ``;
    for (let i = 0; i < chapters.length; i++) {
      const id = `chapter${i + 1}`;
      const playOrder = i + 1;
      if (chapters[i]!.isVolume && isNested) {
        navPoints += `</navPoint>\n`;
        isNested = !isNested;
      }
      navPoints +=
        `<navPoint id="navPoint-${id}" playOrder="${playOrder}">\n` +
        `<navLabel><text>${chapters[i]!.title}</text></navLabel>\n` +
        `<content src="./OEBPS/${id}.xhtml" />\n`;
      if (chapters[i]!.isVolume && !isNested) {
        isNested = !isNested;
      } else {
        navPoints += `</navPoint>\n`;
      }
    }
    if (isNested) {
      navPoints += `</navPoint>`;
    }

    // Add NCX file (table of contents)
    const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
    <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
      <head>
        <meta name="dtb:uid" content="book-id" />
        <meta name="dtb:depth" content="1" />
        <meta name="dtb:totalPageCount" content="0" />
        <meta name="dtb:maxPageNumber" content="0" />
      </head>
      <docTitle>
        <text>${escapeXml(bookTitle)}</text>
      </docTitle>
      <docAuthor>
        <text>${escapeXml(author)}</text>
      </docAuthor>
      <navMap>
        ${navPoints}
      </navMap>
    </ncx>`.trim();

    await zipWriter.add('toc.ncx', new TextReader(tocNcx), zipWriteOptions);

    // Create manifest and spine items
    const manifest = chapters
      .map(
        (_, index) => `
      <item id="chap${index + 1}" href="OEBPS/chapter${index + 1}.xhtml" media-type="application/xhtml+xml"/>
    `,
      )
      .join('\n')
      .trim();

    const spine = chapters
      .map(
        (_, index) => `
      <itemref idref="chap${index + 1}"/>`,
      )
      .join('\n')
      .trim();

    // Add CSS stylesheet
    const css = `
      body { line-height: 1.6; font-size: 1em; font-family: 'Arial', sans-serif; text-align: justify; }
      p { text-indent: 2em; margin: 0; }
    `;

    await zipWriter.add('style.css', new TextReader(css), zipWriteOptions);

    // Add chapter files
    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i]!;
      const lang = language;
      const chapterContent = `<?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
        <html xmlns="http://www.w3.org/1999/xhtml" lang="${lang}" xml:lang="${lang}">
          <head>
            <title>${chapter.title}</title>
            <link rel="stylesheet" type="text/css" href="../style.css"/>
          </head>
          <body>${chapter.content}</body>
        </html>`.trim();

      await zipWriter.add(
        `OEBPS/chapter${i + 1}.xhtml`,
        new TextReader(chapterContent),
        zipWriteOptions,
      );
    }

    const tocManifest = `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`;
    const styleManifest = `<item id="css" href="style.css" media-type="text/css"/>`;

    // Add content.opf file
    const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
      <package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="2.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>${escapeXml(bookTitle)}</dc:title>
          <dc:language>${language}</dc:language>
          <dc:creator>${escapeXml(author)}</dc:creator>
          <dc:identifier id="book-id">${identifier}</dc:identifier>
        </metadata>
        <manifest>
          ${manifest}
          ${tocManifest}
          ${styleManifest}
        </manifest>
        <spine toc="ncx">
          ${spine}
        </spine>
      </package>`.trim();

    await zipWriter.add('content.opf', new TextReader(contentOpf), zipWriteOptions);

    return await zipWriter.close();
  }

  private detectEncoding(buffer: ArrayBuffer): string | undefined {
    const utf8HeadSampleSize = Math.min(buffer.byteLength, 64 * 1024);
    const utf8HeadSample = buffer.slice(0, utf8HeadSampleSize);

    try {
      this.assertStrictUtf8Sample(new Uint8Array(utf8HeadSample));
      if (buffer.byteLength > utf8HeadSampleSize * 2) {
        const midSampleSize = Math.min(8192, buffer.byteLength - utf8HeadSampleSize);
        const midSampleStart = Math.floor((buffer.byteLength - midSampleSize) / 2);
        const midSample = buffer.slice(midSampleStart, midSampleStart + midSampleSize);
        this.assertStrictUtf8Sample(new Uint8Array(midSample));
      }
      return 'utf-8';
    } catch {
      const uint8Array = new Uint8Array(buffer);
      // Try tolerant UTF-8 detection - check if most of it is valid UTF-8
      let validBytes = 0;
      let checkedBytes = 0;
      const sampleSize = Math.min(uint8Array.length, 10000);

      for (let i = 0; i < sampleSize; i++) {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(uint8Array.slice(i, i + 100));
          validBytes += 100;
          checkedBytes += 100;
          i += 99;
        } catch {
          checkedBytes++;
        }
      }

      const validPercentage = checkedBytes > 0 ? (validBytes / checkedBytes) * 100 : 0;
      console.log(`UTF-8 validity: ${validPercentage.toFixed(2)}%`);

      // If more than 80% is valid UTF-8, consider it UTF-8 with some corruption
      if (validPercentage > 80) {
        console.log('Treating as UTF-8 despite some invalid sequences');
        return 'utf-8';
      }
      // If UTF-8 decoding fails, try to detect other encodings
    }

    const headerBytes = new Uint8Array(buffer.slice(0, 4));

    if (headerBytes[0] === 0xff && headerBytes[1] === 0xfe) {
      return 'utf-16le';
    }

    if (headerBytes[0] === 0xfe && headerBytes[1] === 0xff) {
      return 'utf-16be';
    }

    if (headerBytes[0] === 0xef && headerBytes[1] === 0xbb && headerBytes[2] === 0xbf) {
      return 'utf-8';
    }

    // Analyze a sample of the content to guess between common East Asian encodings
    // If the content has a high ratio of bytes in the 0x80-0xFF range, it's likely GBK/GB18030
    const sample = new Uint8Array(buffer.slice(0, Math.min(1024, buffer.byteLength)));
    let highByteCount = 0;

    for (let i = 0; i < sample.length; i++) {
      if (sample[i]! >= 0x80) {
        highByteCount++;
      }
    }

    const highByteRatio = highByteCount / sample.length;
    if (highByteRatio > 0.3) {
      return 'gbk';
    }

    if (highByteRatio > 0.1) {
      let sjisPattern = false;
      for (let i = 0; i < sample.length - 1; i++) {
        const b1 = sample[i]!;
        const b2 = sample[i + 1]!;
        if (
          ((b1 >= 0x81 && b1 <= 0x9f) || (b1 >= 0xe0 && b1 <= 0xfc)) &&
          ((b2 >= 0x40 && b2 <= 0x7e) || (b2 >= 0x80 && b2 <= 0xfc))
        ) {
          sjisPattern = true;
          break;
        }
      }

      if (sjisPattern) {
        return 'shift-jis';
      }

      return 'gb18030';
    }

    return 'utf-8';
  }

  private assertStrictUtf8Sample(sample: Uint8Array): void {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      decoder.decode(sample);
      return;
    } catch {
      // Sampling may start/end inside a multibyte code point.
      // Retry a few boundary offsets while keeping most bytes untouched.
      const maxOffset = Math.min(3, sample.length - 1);
      for (let startOffset = 0; startOffset <= maxOffset; startOffset++) {
        for (let endOffset = 0; endOffset <= maxOffset; endOffset++) {
          if (startOffset === 0 && endOffset === 0) continue;
          const end = sample.length - endOffset;
          if (end - startOffset < 16) continue;
          try {
            decoder.decode(sample.subarray(startOffset, end));
            return;
          } catch {
            // continue trying other offsets
          }
        }
      }
      throw new Error('invalid utf-8 sample');
    }
  }

  private isEncodingSupported(encoding: string): boolean {
    try {
      new TextDecoder(encoding);
      return true;
    } catch {
      return false;
    }
  }

  private resolveSupportedEncoding(detectedEncoding: string): string {
    const normalized = detectedEncoding.toLowerCase();
    const candidates = [
      normalized,
      ...(normalized === 'gbk' ? ['gb18030', 'gb2312'] : []),
      ...(normalized === 'gb18030' ? ['gbk', 'gb2312'] : []),
      ...(normalized === 'shift-jis' ? ['shift_jis', 'sjis'] : []),
      ...(normalized === 'utf-16' ? ['utf-16le', 'utf-16be'] : []),
      'utf-8',
    ];

    for (const encoding of candidates) {
      if (this.isEncodingSupported(encoding)) {
        return encoding;
      }
    }
    return 'utf-8';
  }
}
