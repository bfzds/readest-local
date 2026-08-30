// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  TxtToEpubConverter,
  parseChapterPatterns,
  validateChapterPattern,
  buildChapterPatternFromSamples,
  extractTxtChapterCandidates,
} from '@/utils/txt';

type Api = {
  createChapterRegexps(language: string, extraPatterns?: string[]): RegExp[];
  computeMaxLength(segment: string): number;
  extractChaptersFromSegment(
    segment: string,
    metadata: { bookTitle: string; author: string; language: string; identifier: string },
    option: {
      linesBetweenSegments: number;
      fallbackParagraphsPerChapter: number;
      chapterPatterns?: string[];
    },
    chapterOffset: number,
  ): { title: string; content: string; isVolume: boolean; detected?: boolean }[];
};

const getApi = (): Api => new TxtToEpubConverter() as unknown as Api;

const metadata = (lang: string) => ({
  bookTitle: 'T',
  author: '',
  language: lang,
  identifier: 't',
});

const option = (o: { chapterPatterns?: string[] } = {}) => ({
  linesBetweenSegments: 8,
  fallbackParagraphsPerChapter: 0,
  ...o,
});

/** 去掉 g/y 标志分次测试，避免 lastIndex 污染 */
const anyRegexMatches = (regexps: RegExp[], text: string): boolean => {
  for (const r of regexps) {
    const re = new RegExp(r.source, r.flags.replace(/[gy]/g, ''));
    if (re.test(text)) return true;
  }
  return false;
};

// 用户自定义小节规则：匹配 "§数字 标题" 整行
const USER_PATTERN = '§\\d+[^\\n]*';

describe('方向① 章节判定阈值动态化', () => {
  it('超大未分段文本的阈值随段规模放大，小段保持下限', () => {
    const api = getApi();
    expect(api.computeMaxLength('short')).toBe(100000);
    expect(api.computeMaxLength('x'.repeat(2_000_000))).toBeGreaterThan(100000);
  });

  it('整本书一个 segment 时，超长单章不再令整条正则被弃用', () => {
    const api = getApi();
    // 约 120 万字符：第一章 + 12 万字超长正文 + 第二章 + 简短正文
    const longBody = '超长章节正文内容。'.repeat(10_000);
    const text = ['第一章：开篇', longBody, '第二章：终章', '简短收尾正文'].join('\n');
    const chapters = api.extractChaptersFromSegment(text, metadata('zh'), option(), 0);
    const titles = chapters.map((c) => c.title);
    expect(titles).toContain('第一章：开篇');
    expect(titles).toContain('第二章：终章');
    // 不应退回无标题的纯数字兜底章
    expect(chapters.some((c) => c.detected === false && /^\d+$/.test(c.title))).toBe(false);
  });
});

describe('方向② 章节规则可扩展（规则表化）', () => {
  it('中文仍返回两条正则且首条含 i、u 标志', () => {
    const api = getApi();
    const rs = api.createChapterRegexps('zh');
    expect(rs.length).toBe(2);
    expect(rs[0]!.flags).toContain('i');
    expect(rs[0]!.flags).toContain('u');
  });

  it('英文仍返回两条正则', () => {
    expect(getApi().createChapterRegexps('en').length).toBe(2);
  });

  it('非专用语言回退到通用规则（两条）', () => {
    expect(getApi().createChapterRegexps('fr').length).toBe(2);
    expect(getApi().createChapterRegexps('de').length).toBe(2);
  });

  it('新增日文规则：匹配 第X話', () => {
    expect(anyRegexMatches(getApi().createChapterRegexps('ja'), '\n第一話：开幕\n')).toBe(true);
  });

  it('新增韩文规则：匹配 제X장', () => {
    expect(anyRegexMatches(getApi().createChapterRegexps('ko'), '\n제1장 서막\n')).toBe(true);
  });
});

describe('方向③ 用户自定义章节规则', () => {
  it('用户规则注入到规则链最前', () => {
    const rs = getApi().createChapterRegexps('zh', [USER_PATTERN]);
    const re = new RegExp(rs[0]!.source, rs[0]!.flags.replace(/[gy]/g, ''));
    expect(re.test('\n§3 标题\n')).toBe(true);
  });

  it('通过 option.chapterPatterns 用自定义格式切分章节', () => {
    const api = getApi();
    const text = '\n§1 第一幕\n一些内容\n§2 第二幕\n更多内容';
    const chapters = api.extractChaptersFromSegment(
      text,
      metadata('zh'),
      option({ chapterPatterns: [USER_PATTERN] }),
      0,
    );
    const titles = chapters.map((c) => c.title.trim());
    expect(titles).toContain('§1 第一幕');
    expect(titles).toContain('§2 第二幕');
  });

  it('非法用户规则被安全忽略，不影响内置规则', () => {
    const rs = getApi().createChapterRegexps('zh', ['(unclosed']);
    expect(rs.length).toBe(2);
  });
});

describe('parseChapterPatterns（逗号不切分）', () => {
  it('每行一条规则，含逗号量词的正则不被拆分', () => {
    expect(parseChapterPatterns('第[0-9]{1,3}章\n第[0-9]{2,4}节')).toEqual([
      '第[0-9]{1,3}章',
      '第[0-9]{2,4}节',
    ]);
  });

  it('空行与首尾空白被清理', () => {
    expect(parseChapterPatterns('  abc  \n\n  def  \n')).toEqual(['abc', 'def']);
  });
});

describe('validateChapterPattern（ReDoS 守门）', () => {
  it('正常章节正则通过校验', () => {
    expect(validateChapterPattern('第[0-9]{1,3}章')).toEqual([]);
    expect(validateChapterPattern('§\\d+[^\\n]*')).toEqual([]);
    expect(validateChapterPattern('第[一二三四五六七八九十]+节')).toEqual([]);
  });

  it('嵌套量词（灾难性回溯）被拦截', () => {
    expect(validateChapterPattern('(a+)+')).not.toEqual([]);
    expect(validateChapterPattern('(\\d+|x)+')).not.toEqual([]);
  });

  it('含捕获组的用户规则被拒绝（B-8：避免双捕获错位），非捕获组放行', () => {
    expect(validateChapterPattern('(第.+章)')).not.toEqual([]);
    expect(validateChapterPattern('(第[0-9]+章|第N章)')).not.toEqual([]);
    // 环视内的捕获组同样是捕获组（会与外层包裹组双捕获）
    expect(validateChapterPattern('(?=(第.+章))[^\\n]*')).not.toEqual([]);
    // 非捕获组 (?:)、无捕获组的普通规则放行
    expect(validateChapterPattern('(?:第.+章)')).toEqual([]);
    expect(validateChapterPattern('第[0-9]{1,3}章')).toEqual([]);
  });

  it('区间量词嵌套量词链（(a+){20}、(?:(?:\\d+\\d*){10}x）被拦截', () => {
    expect(validateChapterPattern('(a+){20}')).not.toEqual([]);
    expect(validateChapterPattern('(?:\\d+\\d*){10}x')).not.toEqual([]);
  });

  it('过深分组嵌套被拦截', () => {
    expect(validateChapterPattern('((((a+)+))+)+')).not.toEqual([]);
  });

  it('超长正则被拦截', () => {
    expect(validateChapterPattern('a'.repeat(600))).not.toEqual([]);
  });
});

describe('zh 章节标题带【】包裹', () => {
  it('【第X章、标题（视角）】可识别', () => {
    expect(
      anyRegexMatches(getApi().createChapterRegexps('zh'), '\n【第十章、下山（吕凡视角）】\n'),
    ).toBe(true);
  });

  it('【序章】等前言类可识别', () => {
    expect(anyRegexMatches(getApi().createChapterRegexps('zh'), '\n【序章】\n')).toBe(true);
  });

  it('裸标题保持可识别（不回归）', () => {
    expect(anyRegexMatches(getApi().createChapterRegexps('zh'), '\n第五章、锦州城（一）\n')).toBe(
      true,
    );
  });
});

describe('buildChapterPatternFromSamples（勾选行→规则）', () => {
  const samples = ['第五章、锦州城（一）', '第六章、锦州城（二）'];

  it('同前缀+数字分歧 → 生成数字通配规则，其它章也命中', () => {
    const pattern = buildChapterPatternFromSamples(samples);
    expect(pattern).toBeTruthy();
    expect(
      anyRegexMatches(getApi().createChapterRegexps('zh', [pattern!]), '\n第五章、锦州城（一）\n'),
    ).toBe(true);
    expect(
      anyRegexMatches(
        getApi().createChapterRegexps('zh', [pattern!]),
        '\n第八十章、锦州城（九）\n',
      ),
    ).toBe(true);
  });

  it('无关正文行不命中', () => {
    const pattern = buildChapterPatternFromSamples(samples)!;
    expect(
      anyRegexMatches(
        getApi().createChapterRegexps('zh', [pattern]),
        '\n这是正文段落文字，长度足够长。\n',
      ),
    ).toBe(false);
  });

  it('样本首字符即分歧 → 退化字面量 alternation，样本本身可命中', () => {
    const pattern = buildChapterPatternFromSamples(['序章', '楔子']);
    expect(pattern).toBeTruthy();
    expect(anyRegexMatches(getApi().createChapterRegexps('zh', [pattern!]), '\n序章\n')).toBe(true);
    expect(anyRegexMatches(getApi().createChapterRegexps('zh', [pattern!]), '\n楔子\n')).toBe(true);
  });

  it('空样本返回 null', () => {
    expect(buildChapterPatternFromSamples([])).toBeNull();
  });

  it('单样本数字通配：尾部通配限长，不整句吞入超长尾随正文', () => {
    const pattern = buildChapterPatternFromSamples(['1.']);
    expect(pattern).toBeTruthy();
    const re = getApi().createChapterRegexps('zh', [pattern!])[0]!;
    const longLine = '1.' + 'x'.repeat(200);
    const m = re.exec('\n' + longLine + '\n');
    expect(m).not.toBeNull();
    // 前缀 \n + 数字通配(1) + 点(1) + 尾段最多 60 = 63 上下；限长前会吞整行 200+
    expect(m![0]!.length).toBeLessThanOrEqual(70);
  });
});

describe('extractTxtChapterCandidates（候选标题行提取）', () => {
  const makeTxt = (content: string) =>
    new File([new TextEncoder().encode(content)], 'book.txt', { type: 'text/plain' });

  it('只取短标题特征行，跳过正文长行', async () => {
    const content = [
      '　　' + '这是一段很长的正文内容，用于测试不会被当作标题候选提取出来。'.repeat(3),
      '第五章、锦州城（一）',
      '正文继续叙述……',
      '【第十章、下山（吕凡视角）】',
      '她生气了。"哼！"',
      '序章',
    ].join('\n');
    const cands = await extractTxtChapterCandidates(makeTxt(content));
    expect(cands).toContain('第五章、锦州城（一）');
    expect(cands).toContain('【第十章、下山（吕凡视角）】');
    expect(cands).toContain('序章');
    expect(cands.some((c) => c.length > 40)).toBe(false);
  });

  it('正文行含单字（本章说/更新说明）不误入候选：候选正则行首锚定', async () => {
    const content = [
      '第一章 试炼',
      '本章说：感谢打赏。',
      '更新说明：作者有话说',
      '第二章 重逢',
    ].join('\n');
    const cands = await extractTxtChapterCandidates(makeTxt(content));
    expect(cands).toContain('第一章 试炼');
    expect(cands).toContain('第二章 重逢');
    expect(cands.some((c) => c.includes('本章说') || c.includes('更新说明'))).toBe(false);
  });

  it('UTF-16 LE TXT（含 BOM）：按 BOM 探测正确编码，候选不空且非 mojibake', async () => {
    const text = '第一章 试炼\n正文内容\n第二章 重逢';
    const utf16le = new Uint8Array(Buffer.from('﻿' + text, 'utf16le'));
    const file = new File([utf16le], 'book_utf16.txt', { type: 'text/plain' });
    const cands = await extractTxtChapterCandidates(file);
    expect(cands).toContain('第一章 试炼');
    expect(cands).toContain('第二章 重逢');
  });
});
