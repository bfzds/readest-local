// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  TxtToEpubConverter,
  buildChapterPatternFromSamples,
  extractTxtFilenameMetadata,
} from '@/utils/txt';
import { detectTxtLanguage } from '@/utils/lang';

type TestChapter = {
  title: string;
  content: string;
  isVolume: boolean;
};

type TestMetadata = {
  bookTitle: string;
  author: string;
  language: string;
  identifier: string;
};

type TxtConverterPrivateAPI = {
  detectEncoding(buffer: ArrayBuffer): string | undefined;
  createEpub(chapters: TestChapter[], metadata: TestMetadata): Promise<Blob>;
};

type TxtConverterFlowPrivateAPI = TxtConverterPrivateAPI & {
  convert(options: {
    file: File;
    author?: string;
    language?: string;
    chapterPatterns?: string[];
  }): Promise<{
    chapterCount: number;
    usedFallback: boolean;
    language: string;
    textLength: number;
    toc: Array<{ label: string; depth: number }>;
  }>;
  extractChapters(
    txtContent: string,
    metadata: TestMetadata,
    option: { linesBetweenSegments: number; fallbackParagraphsPerChapter: number },
  ): TestChapter[];
  probeChapterCount(
    txtContent: string,
    metadata: TestMetadata,
    option: { linesBetweenSegments: number; fallbackParagraphsPerChapter: number },
  ): number;
  iterateSegmentsFromTextChunks(
    chunks: Iterable<string>,
    linesBetweenSegments: number,
  ): Generator<string>;
  detectEncodingFromFile(file: File): Promise<string | undefined>;
  extractChaptersFromFileBySegments(
    file: File,
    encoding: string,
    metadata: TestMetadata,
    option: { linesBetweenSegments: number; fallbackParagraphsPerChapter: number },
  ): Promise<TestChapter[]>;
  probeChapterCountFromFileBySegments(
    file: File,
    encoding: string,
    metadata: TestMetadata,
    option: { linesBetweenSegments: number; fallbackParagraphsPerChapter: number },
  ): Promise<number>;
};

const getBufferSize = (input?: BufferSource): number => {
  if (!input) return 0;
  return input instanceof ArrayBuffer ? input.byteLength : input.byteLength;
};

describe('TxtToEpubConverter', () => {
  it('convert should choose 8 -> 7 when probe detects multiple chapters', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    const calls: number[] = [];

    converter.detectEncoding = () => 'utf-8';
    converter.createEpub = async () => new Blob();
    converter.extractChapters = (_, __, option) => {
      calls.push(option.linesBetweenSegments);
      if (option.linesBetweenSegments === 8) {
        return [{ title: 'Only', content: 'c', isVolume: false }];
      }
      if (option.linesBetweenSegments === 7) {
        return [
          { title: 'A', content: 'a', isVolume: false },
          { title: 'B', content: 'b', isVolume: false },
        ];
      }
      return [{ title: 'Fallback', content: 'f', isVolume: false }];
    };
    converter.probeChapterCount = (_, __, option) => {
      calls.push(option.linesBetweenSegments);
      return 2;
    };

    const file = new File(['dummy content'], 'sample.txt');
    const result = await converter.convert({ file });

    expect(calls).toEqual([8, 7, 7]);
    expect(result.chapterCount).toBe(2);
  });

  it('convert should choose 8 -> 6 when probe does not detect multiple chapters', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    const calls: number[] = [];

    converter.detectEncoding = () => 'utf-8';
    converter.createEpub = async () => new Blob();
    converter.extractChapters = (_, __, option) => {
      calls.push(option.linesBetweenSegments);
      if (option.linesBetweenSegments === 8) {
        return [{ title: 'Only', content: 'c', isVolume: false }];
      }
      if (option.linesBetweenSegments === 6) {
        return [
          { title: 'A', content: 'a', isVolume: false },
          { title: 'B', content: 'b', isVolume: false },
        ];
      }
      return [{ title: 'Single', content: 's', isVolume: false }];
    };
    converter.probeChapterCount = (_, __, option) => {
      calls.push(option.linesBetweenSegments);
      return 1;
    };

    const file = new File(['dummy content'], 'sample.txt');
    const result = await converter.convert({ file });

    expect(calls).toEqual([8, 7, 6]);
    expect(result.chapterCount).toBe(2);
  });

  it('detectEncoding should probe UTF-8 with sampled buffers only', () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterPrivateAPI;
    const fullSize = 220 * 1024;
    const buffer = new TextEncoder().encode('a'.repeat(fullSize)).buffer;

    const OriginalTextDecoder = globalThis.TextDecoder;
    const decodeSizes: number[] = [];

    class RecordingTextDecoder extends OriginalTextDecoder {
      override decode(input?: BufferSource, options?: TextDecodeOptions): string {
        decodeSizes.push(getBufferSize(input));
        return super.decode(input, options);
      }
    }

    (globalThis as { TextDecoder: typeof TextDecoder }).TextDecoder =
      RecordingTextDecoder as typeof TextDecoder;
    try {
      expect(converter.detectEncoding(buffer)).toBe('utf-8');
    } finally {
      (globalThis as { TextDecoder: typeof TextDecoder }).TextDecoder = OriginalTextDecoder;
    }

    expect(Math.max(...decodeSizes)).toBeLessThanOrEqual(64 * 1024);
    expect(decodeSizes).toContain(8192);
    expect(decodeSizes).not.toContain(fullSize);
  });

  it('createEpub should use metadata language for chapter lang attributes', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterPrivateAPI;
    const chapters: TestChapter[] = [
      {
        title: 'Chapter 1',
        content: '<h2>Chapter 1</h2><p>Hello world</p>',
        isVolume: false,
      },
    ];
    const metadata: TestMetadata = {
      bookTitle: 'Sample Book',
      author: 'Sample Author',
      language: 'zh',
      identifier: 'sample-id',
    };

    const blob = await converter.createEpub(chapters, metadata);
    const { ZipReader, BlobReader, TextWriter } = await import('@zip.js/zip.js');
    const reader = new ZipReader(new BlobReader(blob));
    try {
      const entries = await reader.getEntries();
      const chapterEntry = entries.find((entry) => entry.filename === 'OEBPS/chapter1.xhtml') as {
        getData?: (writer: unknown) => Promise<string>;
      };
      expect(chapterEntry).toBeDefined();
      const chapterContent = await chapterEntry?.getData?.(new TextWriter());
      expect(chapterContent).toContain('lang="zh"');
      expect(chapterContent).toContain('xml:lang="zh"');
    } finally {
      await reader.close();
    }
  });

  it('iterateSegmentsFromTextChunks should split by 8 newlines across chunk boundaries', () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    const chunks = ['Segment A\n\n\n\n', '\n\n\n\nSegment B'];

    const segments = Array.from(converter.iterateSegmentsFromTextChunks(chunks, 8));

    expect(segments).toEqual(['Segment A', 'Segment B']);
  });

  it('convert should use chunked path for large files without calling file.arrayBuffer', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    const calls: number[] = [];
    let arrayBufferCalled = false;
    const backingBlob = new Blob(['Header line\n\n\n\n\n\n\n\nChapter content']);

    const largeFile = {
      name: 'large.txt',
      size: 9 * 1024 * 1024,
      slice: (start?: number, end?: number) => backingBlob.slice(start, end),
      stream: () => backingBlob.stream(),
      arrayBuffer: async () => {
        arrayBufferCalled = true;
        throw new Error('large path should not call file.arrayBuffer');
      },
    } as unknown as File;

    converter.detectEncodingFromFile = async () => 'utf-8';
    converter.createEpub = async () => new Blob();
    converter.extractChaptersFromFileBySegments = async (_, __, ___, option) => {
      calls.push(option.linesBetweenSegments);
      if (option.linesBetweenSegments === 8) {
        return [{ title: 'Only', content: 'c', isVolume: false }];
      }
      if (option.linesBetweenSegments === 7) {
        return [
          { title: 'A', content: 'a', isVolume: false },
          { title: 'B', content: 'b', isVolume: false },
        ];
      }
      return [{ title: 'Fallback', content: 'f', isVolume: false }];
    };
    converter.probeChapterCountFromFileBySegments = async (_, __, ___, option) => {
      calls.push(option.linesBetweenSegments);
      return 2;
    };

    const result = await converter.convert({ file: largeFile });

    expect(arrayBufferCalled).toBe(false);
    expect(calls).toEqual([8, 7, 7]);
    expect(result.chapterCount).toBe(2);
  });

  it('convert large file should execute real chunked extraction without file.arrayBuffer', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    let arrayBufferCalled = false;
    const backingBlob = new Blob(['Segment A\n\n\n\n\n\n\n\nSegment B']);

    const largeFile = {
      name: 'large.txt',
      size: 9 * 1024 * 1024,
      slice: (start?: number, end?: number) => backingBlob.slice(start, end),
      stream: () => backingBlob.stream(),
      arrayBuffer: async () => {
        arrayBufferCalled = true;
        throw new Error('large path should not call file.arrayBuffer');
      },
    } as unknown as File;

    converter.createEpub = async () => new Blob();

    const result = await converter.convert({ file: largeFile });

    expect(arrayBufferCalled).toBe(false);
    expect(result.chapterCount).toBe(2);
  });

  it('convert large file should work when stream() is built from slice() like RemoteFile', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    const content = '第一章 开始\n这是第一章的内容。\n\n第二章 继续\n这是第二章的内容。';
    const backingBlob = new Blob([content]);

    // Simulate a fixed RemoteFile: stream() reads data via slice(), not from base File([])
    const fixedFile = new File([], 'large.txt');
    const fileSize = 9 * 1024 * 1024;
    Object.defineProperty(fixedFile, 'size', { value: fileSize });
    Object.defineProperty(fixedFile, 'slice', {
      value: (start?: number, end?: number) => backingBlob.slice(start, end),
    });
    Object.defineProperty(fixedFile, 'stream', {
      value: () => {
        const CHUNK_SIZE = 1024 * 1024;
        let offset = 0;
        return new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            if (offset >= fileSize) {
              controller.close();
              return;
            }
            const end = Math.min(offset + CHUNK_SIZE, fileSize);
            const buf = await backingBlob.slice(offset, end).arrayBuffer();
            controller.enqueue(new Uint8Array(buf));
            offset = end;
          },
        });
      },
    });

    converter.createEpub = async () => new Blob();

    const result = await converter.convert({ file: fixedFile });
    expect(result.chapterCount).toBeGreaterThanOrEqual(1);
  });

  it('convert large file should fail when stream() returns empty data (unfixed RemoteFile)', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;

    // Simulate the bug: RemoteFile with unoverridden stream() returns empty data
    const brokenFile = new File([], 'large.txt');
    Object.defineProperty(brokenFile, 'size', { value: 9 * 1024 * 1024 });
    Object.defineProperty(brokenFile, 'slice', {
      value: (start?: number, end?: number) =>
        new Blob(['第一章 开始\n内容\n\n第二章 继续\n内容']).slice(start, end),
    });
    // stream() is NOT overridden — inherits base File's empty stream

    converter.createEpub = async () => new Blob();

    await expect(converter.convert({ file: brokenFile })).rejects.toThrow('No chapters detected');
  });

  it('iterateSegmentsFromFile should cancel stream on early return', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI & {
      iterateSegmentsFromFile(
        file: File,
        encoding: string,
        linesBetweenSegments: number,
      ): AsyncGenerator<string>;
    };
    const encoder = new TextEncoder();
    let cancelled = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('Segment A\n\n\n\n\n\n\n\nSegment B'));
      },
      cancel() {
        cancelled = true;
      },
    });

    const file = {
      stream: () => stream,
    } as unknown as File;

    const iterator = converter.iterateSegmentsFromFile(file, 'utf-8', 8);
    const first = await iterator.next();
    expect(first.value).toBe('Segment A');
    await iterator.return(undefined);
    expect(cancelled).toBe(true);
  });
});

describe('scene-break dividers do not pollute the TOC (issue #4063)', () => {
  const zhMetadata: TestMetadata = {
    bookTitle: 'Test',
    author: '',
    language: 'zh',
    identifier: 'test',
  };
  const option = { linesBetweenSegments: 8, fallbackParagraphsPerChapter: 100 };
  const divider = '-'.repeat(37);

  it('keeps a single chapter when dash dividers split scene breaks', () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    const text = [
      '第15章',
      '这是第十五章的开头内容。',
      divider,
      '场景切换后的内容继续。',
      divider,
      '又一个场景的内容。',
    ].join('\n');

    const chapters = converter.extractChapters(text, zhMetadata, option);

    expect(chapters.length).toBe(1);
    expect(chapters[0]!.title).toContain('第15章');
    expect(chapters[0]!.content).toContain('场景切换后的内容继续');
    expect(chapters[0]!.content).toContain('又一个场景的内容');
  });

  it('merges mid-chapter content split off before the next heading', () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    const text = [
      '第1章',
      '绿水青山就是金山银山。',
      divider,
      '分隔符之后继续讲述的内容。',
      '第2章',
      '新的章节正式开始了。',
    ].join('\n');

    const chapters = converter.extractChapters(text, zhMetadata, option);

    expect(chapters.map((c) => c.title)).toEqual(['第1章', '第2章']);
    expect(chapters[0]!.content).toContain('分隔符之后继续讲述的内容');
    expect(chapters[0]!.content).not.toContain('<h3>');
  });

  it('still chunks heading-less plain text by paragraph fallback', () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    const paragraphs = Array.from({ length: 250 }, (_, i) => `段落${i + 1}`).join('\n');

    const chapters = converter.extractChapters(paragraphs, zhMetadata, option);

    expect(chapters.length).toBe(3);
  });

  it('merges divider-split scene breaks in the chunked file path', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    const text = [
      '第15章',
      '这是第十五章的开头内容。',
      divider,
      '场景切换后的内容继续。',
      divider,
      '又一个场景的内容。',
    ].join('\n');
    const file = new File([text], 'sample.txt');

    const chapters = await converter.extractChaptersFromFileBySegments(
      file,
      'utf-8',
      zhMetadata,
      option,
    );

    expect(chapters.length).toBe(1);
    expect(chapters[0]!.title).toContain('第15章');
  });
});

describe('usedFallback：规则未命中时报告兜底切分（目录识别引导入口）', () => {
  it('reports usedFallback=true when no rule matches and chapters are paragraph chunks', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    converter.detectEncoding = () => 'utf-8';
    converter.createEpub = async () => new Blob();
    const paragraphs = Array.from({ length: 250 }, (_, i) => `段落${i + 1}`).join('\n');
    const file = new File([paragraphs], 'sample.txt');

    const result = await converter.convert({ file });

    expect(result.chapterCount).toBeGreaterThan(1);
    expect(result.usedFallback).toBe(true);
  });

  it('reports usedFallback=false when real chapter headings are detected', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    converter.detectEncoding = () => 'utf-8';
    converter.createEpub = async () => new Blob();
    const text = [
      '第一章 开端',
      '这是第一章的正文内容。',
      '第二章 发展',
      '这是第二章的正文内容。',
    ].join('\n');
    const file = new File([text], 'sample.txt');

    const result = await converter.convert({ file });

    expect(result.usedFallback).toBe(false);
  });

  it('guide re-cut: 勾选【一】式候选行生成的规则可重切出真实章节', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    converter.detectEncoding = () => 'utf-8';
    converter.createEpub = async () => new Blob();
    const body = (tag: string) =>
      Array.from({ length: 30 }, (_, i) => `${tag}的第${i + 1}段正文内容，讲述故事的发展。`).join(
        '\n',
      );
    const text = [
      '【一】开端',
      body('开端'),
      '【二】发展',
      body('发展'),
      '【三】高潮',
      body('高潮'),
      '【四】结局',
      body('结局'),
    ].join('\n');

    // 无规则时内置规则不命中 → 段落兜底（引导入口）
    const before = await converter.convert({ file: new File([text], 'sample.txt') });
    expect(before.usedFallback).toBe(true);

    // 引导勾选候选行 → 生成临时规则 → 重切后为检测出的 4 个章节
    const pattern = buildChapterPatternFromSamples([
      '【一】开端',
      '【二】发展',
      '【三】高潮',
      '【四】结局',
    ]);
    expect(pattern).toBeTruthy();
    const after = await converter.convert({
      file: new File([text], 'sample.txt'),
      chapterPatterns: [pattern!],
    });
    expect(after.usedFallback).toBe(false);
    expect(after.chapterCount).toBe(4);
  });
});

describe('章节规则语言判定：下载器头部不得把中文 TXT 判成英文', () => {
  // 小说下载器导出的 TXT 头部：字段名 + 长 URL（含 pixiv jump.php 跳转链）。前
  // 1000 字符里 ASCII 远多于汉字（真实样本 724 / 191，本夹具 504 / 263），franc
  // 于是给出非中文结论（真实样本与本夹具都是 eng），zh 规则整条被换掉。
  const downloaderHeader = [
    '题名：测试书名',
    '作者：某作者',
    'Tag列表：标签一、标签二',
    '原始网址：https://www.pixiv.net/novel/series/16177891',
    '封面图片地址：https://i.pximg.net/novel-cover-original/img/2026/07/09/16/31/25/sci16177891_8cdab63a97837cb0e23273e5b3c50dd5.png',
    '下载时间：2026-09-10T13:20:25.166Z',
    '本文件由小说下载器生成，软件地址：https://github.com/404-novel-project/novel-downloader',
    '完整版链接：',
    '1-4章：https://www.pixiv.net/jump.php?https%3A%2F%2Fwww.fansky.co%2Flaonadididi%2F6',
    '1-18章：https://www.pixiv.net/jump.php?https%3A%2F%2Fwww.fansky.co%2Flaonadididi%2F29',
    '1-20章：https://www.pixiv.net/jump.php?https%3A%2F%2Fwww.fansky.co%2Flaonadididi%2F31',
  ].join('\n');

  const zhBody = (chapter: string) =>
    Array.from({ length: 8 }, (_, i) => `${chapter}第${i + 1}段正文内容。`).join('\n');

  it('keeps Chinese chapter detection when the header is URL-heavy', async () => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    converter.detectEncoding = () => 'utf-8';
    converter.createEpub = async () => new Blob();
    const text = [
      downloaderHeader,
      '第一章 开端',
      zhBody('开端'),
      '第二章 发展',
      zhBody('发展'),
      '第三章 结局',
      zhBody('结局'),
    ].join('\n');

    const result = await converter.convert({ file: new File([text], 'sample.txt') });

    expect(result.language).toBe('zh');
    expect(result.usedFallback).toBe(false);
  });

  it('detects the chapter-rule language from script, defaulting to zh', () => {
    // 头部噪声（URL / 字段名）不参与判定
    expect(detectTxtLanguage(downloaderHeader)).toBe('zh');
    expect(detectTxtLanguage('第一章\n正文内容。')).toBe('zh');
    // 假名/谚文优先于汉字：日文、韩文正文都夹汉字
    expect(detectTxtLanguage('第一章\nこれはテストです。')).toBe('ja');
    expect(detectTxtLanguage('第一章\n이것은 테스트입니다.')).toBe('ko');
    // 本项目不导入英文书：纯拉丁文本也按 zh 处理（zh 规则集本身含 chapter N）
    expect(detectTxtLanguage('Title\nPlain latin text only.')).toBe('zh');
  });

  it('大文件路径用「头部 + 正文样本」判语言，不被中文元数据头带偏', () => {
    const converter = new TxtToEpubConverter() as unknown as {
      extractAuthorAndLanguage(
        header: string,
        author?: string,
        language?: string,
        bodySample?: string,
      ): { author: string; language: string };
    };
    const header = '题名：测试书名\n作者：某作者\n软件地址：https://example.com/downloader';

    expect(
      converter.extractAuthorAndLanguage(header, undefined, undefined, 'これはテストです。'),
    ).toMatchObject({ language: 'ja' });
    expect(converter.extractAuthorAndLanguage(header)).toMatchObject({ language: 'zh' });
    // 调用方指定的语言优先，不参与判定
    expect(converter.extractAuthorAndLanguage(header, undefined, 'ko')).toMatchObject({
      language: 'ko',
    });
  });
});

describe('extractTxtFilenameMetadata', () => {
  it('extracts the title from CJK 《》 brackets', () => {
    expect(extractTxtFilenameMetadata('《三体》.txt')).toEqual({ title: '三体' });
  });

  it('extracts title and labeled author with full-width colon', () => {
    expect(extractTxtFilenameMetadata('《书名》作者:张三.txt')).toEqual({
      title: '书名',
      author: '张三',
    });
    expect(extractTxtFilenameMetadata('《书名》作者：张三.txt')).toEqual({
      title: '书名',
      author: '张三',
    });
  });

  it('extracts title and labeled author with leading whitespace', () => {
    expect(extractTxtFilenameMetadata('《书名》 作者：张三.txt')).toEqual({
      title: '书名',
      author: '张三',
    });
  });

  it('extracts title and bracketed author after the title', () => {
    expect(extractTxtFilenameMetadata('《书名》[张三].txt')).toEqual({
      title: '书名',
      author: '张三',
    });
    expect(extractTxtFilenameMetadata('《书名》(张三).txt')).toEqual({
      title: '书名',
      author: '张三',
    });
    expect(extractTxtFilenameMetadata('《书名》【张三】.txt')).toEqual({
      title: '书名',
      author: '张三',
    });
  });

  it('extracts title and bare author after the title', () => {
    expect(extractTxtFilenameMetadata('《书名》张三.txt')).toEqual({
      title: '书名',
      author: '张三',
    });
  });

  it('strips leading/trailing punctuation from the author', () => {
    expect(extractTxtFilenameMetadata('《书名》 - 张三.txt')).toEqual({
      title: '书名',
      author: '张三',
    });
  });

  it('handles paths with directories', () => {
    expect(extractTxtFilenameMetadata('/inbox/《书名》作者：张三.txt')).toEqual({
      title: '书名',
      author: '张三',
    });
  });

  it('falls back to the base filename when no 《》 are present', () => {
    expect(extractTxtFilenameMetadata('plain-name.txt')).toEqual({ title: 'plain-name' });
  });

  it('returns empty object for empty input', () => {
    expect(extractTxtFilenameMetadata('')).toEqual({ title: '' });
  });

  // Chinese web-novel TXT files are commonly named with a 【】 title and a
  // labeled author tacked on, e.g. 【书名】1-129 作者：起落.txt. There are no 《》,
  // so the whole name stays the title, but the labeled author must still be
  // extracted. See issue #4390.
  it('extracts a labeled author from a 【】-titled filename without 《》 (issue #4390)', () => {
    expect(extractTxtFilenameMetadata('【细雨飘香】1-129 作者：起落.txt')).toEqual({
      title: '【细雨飘香】1-129 作者：起落',
      author: '起落',
    });
    expect(extractTxtFilenameMetadata('【月如无恨月长圆】（1-154）作者：陈西.txt')).toEqual({
      title: '【月如无恨月长圆】（1-154）作者：陈西',
      author: '陈西',
    });
  });

  it('does not mistake a leading 【tag】 for the author when no 作者 label is present', () => {
    expect(extractTxtFilenameMetadata('【完结】斗破苍穹.txt')).toEqual({
      title: '【完结】斗破苍穹',
    });
  });
});

describe('author resolution during conversion (issue #4390)', () => {
  describe('PixivBatchDownloader names', () => {
    it('extracts title and author from the default layout', () => {
      expect(extractTxtFilenameMetadata('pixiv/作者A-12345678/23456789-小说标题.txt')).toEqual({
        title: '小说标题',
        author: '作者A',
      });
    });

    it('extracts title and author from the default layout with sourcePath', () => {
      expect(
        extractTxtFilenameMetadata(
          '23456789-小说标题.txt',
          'pixiv/作者A-12345678/23456789-小说标题.txt',
        ),
      ).toEqual({ title: '小说标题', author: '作者A' });
    });

    it('prefers the downloader TXT header over the filename', async () => {
      const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
      let captured: TestMetadata | undefined;
      converter.detectEncoding = () => 'utf-8';
      converter.createEpub = async (_chapters, metadata) => {
        captured = metadata;
        return new Blob();
      };
      converter.extractChapters = () => [{ title: '第一章', content: '正文', isVolume: false }];
      const file = new File(
        [
          [
            '小说标题',
            '',
            '作者A',
            '',
            'https://www.pixiv.net/novel/show.php?id=23456789',
            '',
            '----- 下面是正文 -----',
            '',
            '正文',
          ].join('\n'),
        ],
        'pixiv/作者A-12345678/23456789-装饰文件名.txt',
      );
      await converter.convert({ file });
      expect(captured).toMatchObject({ bookTitle: '小说标题', author: '作者A' });
    });
  });

  const convertAndCaptureMetadata = async (name: string, content: string) => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    let captured: TestMetadata | undefined;
    converter.detectEncoding = () => 'utf-8';
    converter.createEpub = async (_chapters, metadata) => {
      captured = metadata;
      return new Blob();
    };
    converter.extractChapters = () => [{ title: '第一章', content: '正文', isVolume: false }];
    const file = new File([content], name);
    await converter.convert({ file });
    return captured;
  };

  it('falls back to the filename author when the header has none (missing author)', async () => {
    const metadata = await convertAndCaptureMetadata(
      '【细雨飘香】1-129 作者：起落.txt',
      '第一章 初见\n正文内容……\n',
    );
    expect(metadata?.author).toBe('起落');
  });

  it('rejects a metadata-blob header author and uses the filename author (irrelevant content)', async () => {
    const metadata = await convertAndCaptureMetadata(
      '【月如无恨月长圆】（1-154）作者：陈西.txt',
      '作者：2024/08/01发表于：是否首发：是字数1023150字116:01\n第一章 初见\n正文内容……\n',
    );
    expect(metadata?.author).toBe('陈西');
  });

  it('keeps a clean labeled author parsed from the file header', async () => {
    const metadata = await convertAndCaptureMetadata(
      '【幻灵幽火】1-23未完结 作者：月夜银狐.txt',
      '作者：月夜银狐\n第一章 初见\n正文内容……\n',
    );
    expect(metadata?.author).toBe('月夜银狐');
  });
});

describe('正文字数：版本对比弹窗用的派生数据', () => {
  // content 是转换器自己拼的 HTML，统计前必须剥标签——否则多出来的量正比于
  // 段落数，同一段文字换个行分隔方式字数就自己变了。
  const convertText = async (content: string, name = 'sample.txt') => {
    const converter = new TxtToEpubConverter() as unknown as TxtConverterFlowPrivateAPI;
    converter.detectEncoding = () => 'utf-8';
    converter.createEpub = async () => new Blob();
    return await converter.convert({ file: new File([content], name) });
  };

  const SOURCE = [
    '第一章 开始',
    '正文甲乙丙丁',
    '正文戊己庚辛',
    '第二章 继续',
    '更多内容壬癸',
    '第三章 结束',
    '尾巴文字子丑寅卯',
  ].join('\n\n');

  it('剥掉标签后等于源文本的非空白字符数', async () => {
    const result = await convertText(SOURCE);
    // 章节标题与正文合起来就是源文本的全部可见字符：标签不算，标题只算一次。
    // 修复前这里是 96——多出 3×9 的 <h2> 与 4×7 的 <p>。
    expect(SOURCE.replace(/\s+/g, '').length).toBe(41);
    expect(result.textLength).toBe(41);
  });

  it('同一段文字换行分隔方式不影响字数', async () => {
    const [lf, crlf] = await Promise.all([
      convertText(SOURCE),
      convertText(SOURCE.replace(/\n/g, '\r\n')),
    ]);
    expect(crlf.textLength).toBe(lf.textLength);
  });

  it('章节数与章节标题随正文一起产出（供对比弹窗并排）', async () => {
    const result = await convertText(SOURCE);
    expect(result.chapterCount).toBe(3);
    expect(result.toc.map((entry) => entry.label)).toEqual([
      '第一章 开始',
      '第二章 继续',
      '第三章 结束',
    ]);
    expect(result.toc.every((entry) => entry.depth === 0)).toBe(true);
  });
});

describe('转换产物的字节稳定性（TXT 删了还能拖回来所依赖的性质）', () => {
  // bookService 里"墓碑不进 sourceHash 短路面、走完整路径按 hash 复活"这套逻辑
  // 成立的前提是：同一个 TXT 转两次得到**同一个 hash**。那靠的是
  //   - dc:identifier 取自原始 TXT 的 partialMD5（不是随机 UUID）；
  //   - zip 条目的时间戳被钉成 new Date(0)（zipWriteOptions）。
  // 没有测试锁它的话，将来往 EPUB 模板里加一个 <dc:date> 或者动 zip 选项，
  // "删了再拖回来" 就会从"复活"悄悄变成"多一本"。
  it('同一文本转换两次得到完全相同的字节', async () => {
    const content = ['第一章 开始', '正文甲乙丙丁', '第二章 继续', '更多内容壬癸'].join('\n\n');

    const convertOnce = async () => {
      const converter = new TxtToEpubConverter();
      const result = await converter.convert({ file: new File([content], 'stable.txt') });
      return new Uint8Array(await result.file.arrayBuffer());
    };

    const first = await convertOnce();
    const second = await convertOnce();

    expect(first.byteLength).toBe(second.byteLength);
    expect(Array.from(first)).toEqual(Array.from(second));
  });
});
