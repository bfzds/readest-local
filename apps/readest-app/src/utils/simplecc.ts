import init, { simplecc } from '@simplecc/simplecc_wasm';
import { ConvertChineseVariant } from '@/types/book';

let initialized = false;

const initSimpleCC = async () => {
  if (initialized) return;

  await init('/vendor/simplecc/simplecc_wasm_bg.wasm');
  initialized = true;
};

const convertReverseMap: Record<ConvertChineseVariant, ConvertChineseVariant> = {
  none: 'none',
  s2t: 't2s',
  t2s: 's2t',
  s2tw: 'tw2s',
  s2hk: 'hk2s',
  s2twp: 'tw2sp',
  tw2s: 's2tw',
  hk2s: 's2hk',
  tw2sp: 's2twp',
};

const runSimpleCC = (text: string, variant: ConvertChineseVariant, reverse = false): string => {
  return reverse ? simplecc(text, convertReverseMap[variant]) : simplecc(text, variant);
};

// 选中文本搜书的变体判定。书内搜索索引按书原文变体存储（folded 不含简繁
// 归一），搜索词须与原文变体一致才能命中。正文显示可能是 t2s 转换结果
// （繁体原文 → 简体显示），此时选中的简体词需转回繁体原文去搜；但简体书
// （原文即简体）反向转换会把简体误转成繁体——既在搜索栏显示错、又搜不中。
// 因此仅当书语言为繁体系（zh-TW/HK/Hant）时才反向。
export const toSelectionSearchTerm = (
  text: string,
  bookLanguage: string | undefined,
  convertChineseVariant: ConvertChineseVariant,
): string => {
  const convert = convertChineseVariant && convertChineseVariant !== 'none';
  const isHantBook = !!bookLanguage && /hant|tw|hk/i.test(bookLanguage);
  if (!convert || !isHantBook) return text;
  return runSimpleCC(text, convertChineseVariant, true);
};

export const simplifyChineseText = async (text: string): Promise<string> => {
  if (!text) return text;
  try {
    await initSimpleCC();
    const simplified = runSimpleCC(text, 't2s');
    return simplified === text ? text : simplified;
  } catch (error) {
    console.warn('Failed to simplify Chinese text, keeping original:', error);
    return text;
  }
};

export { initSimpleCC, runSimpleCC };
