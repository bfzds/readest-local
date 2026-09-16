import { LocaleWithTextInfo } from '@/types/misc';
import { franc } from 'franc-min';
import { iso6392 } from 'iso-639-2';
import { iso6393To1 } from 'iso-639-3';

export const isCJKStr = (str: string) => {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(str ?? '');
};

export const isCJKLang = (lang: string | null | undefined): boolean => {
  if (!lang) return false;
  const normalizedLang = normalizedLangCode(lang);
  return ['zh', 'ja', 'ko', 'zho', 'jpn', 'kor'].includes(normalizedLang);
};

/**
 * Languages whose primary script has no uppercase/lowercase distinction.
 * Matters for UI rules that lean on the `uppercase` CSS property for visual
 * emphasis — those rules are no-ops here, so callers usually pair this with
 * an alternate weight/size treatment (e.g. bigger font-size in section
 * headers). Covers CJK, Arabic-script (Arabic, Persian), Hebrew, the major
 * Indic scripts (Devanagari, Bengali, Tamil, Sinhala), Thai, and Tibetan.
 */
export const isCaselessLang = (lang: string | null | undefined): boolean => {
  if (!lang) return false;
  const normalizedLang = normalizedLangCode(lang);
  return [
    'zh',
    'ja',
    'ko', // CJK
    'ar',
    'fa', // Arabic script
    'he', // Hebrew
    'hi',
    'bn',
    'ta',
    'si', // Indic scripts
    'th', // Thai
    'bo', // Tibetan
    'zho',
    'jpn',
    'kor',
    'ara',
    'fas', // ISO-639-3 aliases
    'heb',
    'hin',
    'ben',
    'tam',
    'sin',
    'tha',
    'bod',
  ].includes(normalizedLang);
};

const ZH_SCRIPTS_MAPPING: Record<string, string> = {
  zh: 'zh-Hans',
  'zh-cn': 'zh-Hans',
  'zh-hk': 'zh-Hant',
  'zh-tw': 'zh-Hant',
  'zh-mo': 'zh-Hant',
  'zh-hans': 'zh-Hans',
  'zh-hant': 'zh-Hant',
};

export const normalizeToFullLang = (langCode: string): string => {
  try {
    const locale = new Intl.Locale(langCode.toLowerCase());
    const maximized = locale.maximize();

    if (maximized.language === 'zh') {
      return maximized.script === 'Hant' ? 'zh-Hant' : 'zh-Hans';
    }

    return maximized.region ? `${maximized.language}-${maximized.region}` : langCode;
  } catch {
    return ZH_SCRIPTS_MAPPING[langCode.toLowerCase()] || langCode;
  }
};

export const normalizeToShortLang = (langCode: string): string => {
  const lang = langCode.toLowerCase();
  if (lang.startsWith('zh')) {
    return ZH_SCRIPTS_MAPPING[lang] || 'zh-Hans';
  }
  return lang.split('-')[0]!;
};

export const normalizedLangCode = (lang: string | null | undefined): string => {
  if (!lang) return '';
  return lang.split('-')[0]!.toLowerCase();
};

export const isSameLang = (lang1?: string | null, lang2?: string | null): boolean => {
  if (!lang1 || !lang2) return false;
  const normalizedLang1 = normalizedLangCode(lang1);
  const normalizedLang2 = normalizedLangCode(lang2);
  return normalizedLang1 === normalizedLang2;
};

export const isValidLang = (lang?: string) => {
  if (!lang) return false;
  if (typeof lang !== 'string') return false;
  if (['und', 'mul', 'mis', 'zxx'].includes(lang)) return false;
  const code = normalizedLangCode(lang);
  return iso6392.some((l) => l.iso6391 === code || l.iso6392B === code);
};

export const code6392to6391 = (code: string): string => {
  const lang = iso6392.find((l) => l.iso6392B === code);
  return lang?.iso6391 || '';
};

const commonIndivToMacro: Record<string, string> = {
  cmn: 'zho',
  arb: 'ara',
  arz: 'ara',
  ind: 'msa',
  zsm: 'msa',
  nob: 'nor',
  nno: 'nor',
  pes: 'fas',
  quy: 'que',
};

export const code6393to6391 = (code: string): string => {
  const macro = commonIndivToMacro[code] || code;
  return iso6393To1[macro] || '';
};

export const getLanguageName = (code: string): string => {
  const lang = normalizedLangCode(code);
  const language = iso6392.find((l) => l.iso6391 === lang || l.iso6392B === lang);
  return language ? language.name : lang;
};

export const inferLangFromScript = (text: string, lang: string): string => {
  if (!lang || lang === 'en') {
    if (/[\p{Script=Hangul}]/u.test(text)) {
      return 'ko';
    } else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) {
      return 'ja';
    } else if (/[\p{Script=Han}]/u.test(text)) {
      return 'zh';
    }
  }
  return lang;
};

/**
 * TXT 导入的章节规则语言判定（本项目不导入英文书：非日非韩一律按中文）。
 *
 * 这里不能用 franc：小说下载器导出的 TXT 开头是「题名/作者/Tag列表/原始网址/
 * 封面图片地址/简介/下载时间」加若干长 URL，前 1000 字符里 ASCII 往往多于汉字
 * （实测样本 ASCII 724 / 汉字 191 → eng，同一段文本去掉 URL 后是 cmn）。语言一旦
 * 判成 en，buildChapterRegexps 就整条换成英文规则，「第N章」零命中，整本书的目录
 * 退化成「每 100 段一章」的序号，且这个 en 会随转换产物写进 dc:language，把侧栏
 * 的虚拟目录扫描也一并带偏。按书写系统判定则头部的 ASCII 噪声完全不参与，与
 * inferLangFromScript 同口径：假名/谚文优先于汉字——日文、韩文正文都夹汉字，
 * 必须先排除才能落到 zh。
 */
export const detectTxtLanguage = (sample: string): string => {
  const text = sample ?? '';
  if (/[\p{Script=Hangul}]/u.test(text)) return 'ko';
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja';
  return 'zh';
};

export const detectLanguage = (content: string): string => {
  try {
    const iso6393Lang = franc(content.substring(0, 1000));
    const iso6391Lang = code6393to6391(iso6393Lang) || 'en';
    return iso6391Lang;
  } catch {
    console.warn('Language detection failed, defaulting to en.');
    return 'en';
  }
};

export const getLanguageInfo = (lang: string) => {
  if (!lang) return {};
  try {
    const canonical = Intl.getCanonicalLocales(lang)[0]!;
    const locale = new Intl.Locale(canonical) as LocaleWithTextInfo;
    const isCJK = ['zh', 'ja', 'kr'].includes(locale.language);
    const direction = (locale.getTextInfo?.() ?? locale.textInfo)?.direction;
    return { canonical, locale, isCJK, direction };
  } catch (e) {
    console.warn(e);
    return {};
  }
};
