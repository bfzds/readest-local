import { partialMD5 } from './md5';
import { getBaseFilename } from './path';
import { detectTxtLanguage } from './lang';
import { configureZip } from './zip';
import { parsePixivNovelFilename, parsePixivNovelMetaHeader } from './pixivNovel';
import { CHAPTER_CANDIDATE_TITLE_RX, buildChapterRegexps } from './chapterRules';

// 被抽取到共享模块 chapterRules 的对外导出，这里继续透传，保持 txt.ts
// 的对外导出面不变（既有调用方仍从 '@/utils/txt' 导入）。
export { buildChapterPatternFromSamples, validateChapterPattern } from './chapterRules';

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

/** 章节正文的非空白字符数合计（标题行不计，它不在 `content` 里）。 */
const countChapterTextLength = (chapters: Chapter[]): number =>
  chapters.reduce((total, chapter) => total + chapter.content.replace(/\s+/g, '').length, 0);

/**
 * 章节列表 → 目录条目。卷（`isVolume`）是顶层，其下的章低一层；没有卷的书
 * 全部是顶层——和侧栏目录的层级观感一致。
 */
const toTocEntries = (chapters: Chapter[]): Array<{ label: string; depth: number }> => {
  const hasVolumes = chapters.some((chapter) => chapter.isVolume);
  return chapters
    .filter((chapter) => chapter.title.trim())
    .map((chapter) => ({
      label: chapter.title.trim(),
      depth: hasVolumes && !chapter.isVolume ? 1 : 0,
    }));
};

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
  /**
   * 正文非空白字符数。导入时随转换顺带算出（章节内容已在手上，不额外读盘），
   * 写入 `Book.textLength` 供「导入的是不是旧版本」确认框对比——两侧都不能为了
   * 并排一个数字去现场解析整本书。与 EPUB 的原生统计同口径到此为止：
   * TXT 的旧侧记录也是这份代码算出来的，所以同一个文件的两个版本可比。
   */
  textLength: number;
  /**
   * 切出来的章节目录（标签 + 层级）。转换器已经有一份章节列表，顺手导出即可；
   * 版本对比弹窗据此并排新旧两版的章节，不必为了几个标题再解析一遍书。
   */
  toc: Array<{ label: string; depth: number }>;
  /**
   * true = 内置/自定义规则一条标题都没匹配上，章节是按段落兜底切出来的
   * （标题为序号）。调用方可据此弹出「目录识别失败」引导，让用户勾选
   * 标题行生成规则重切；false = 至少匹配到一个真实标题行。
   */
  usedFallback: boolean;
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
    // 语言样本取全文而非头部：下载器的元数据头固定是中文（题名/作者/Tag列表…），
    // 只看头部会把日文/韩文正文也判成 zh。书写系统判定在首个命中处即返回。
    const language = providedLanguage || detectTxtLanguage(txtContent);
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
      textLength: countChapterTextLength(chapters),
      toc: toTocEntries(chapters),
      usedFallback: chapters.length > 0 && chapters.every((chapter) => !chapter.detected),
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
      // 语言样本额外带一段正文：下载器的元数据头固定是中文，只看头部会把日文/
      // 韩文正文判成 zh。写入侧与 convertSmallFile 同口径（非日非韩即 zh）。
      await this.readMidBodySampleFromFile(txtFile, runtimeEncoding),
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
      textLength: countChapterTextLength(chapters),
      toc: toTocEntries(chapters),
      usedFallback: chapters.length > 0 && chapters.every((chapter) => !chapter.detected),
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

  /** 正文中部的一小段样本，仅用于语言判定（书写系统识别，不需要干净边界）。 */
  private async readMidBodySampleFromFile(file: File, encoding: string): Promise<string> {
    const sampleSize = Math.min(ENCODING_MID_SAMPLE_BYTES, Math.max(0, file.size - 1));
    if (sampleSize <= 0) return '';
    const start = Math.floor((file.size - sampleSize) / 2);
    const bytes = await file.slice(start, start + sampleSize).arrayBuffer();
    return new TextDecoder(encoding).decode(bytes);
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
    bodySample?: string,
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
    const language = providedLanguage || detectTxtLanguage(`${fileHeader}\n${bodySample ?? ''}`);
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

    const chapterRegexps = buildChapterRegexps(language, option.chapterPatterns);
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

    const chapterRegexps = buildChapterRegexps(language, option.chapterPatterns);
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
