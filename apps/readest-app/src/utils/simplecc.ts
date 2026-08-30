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
// 归一），搜索词须与原文变体一致才能命中。判定按显示变体方向对称：
// - 繁源（t2s/tw2s/hk2s/tw2sp）：正文为简→繁书，繁体系书选中简体词须转回繁体去搜；
// - 简源（s2t/s2tw/s2hk/s2twp）：正文为繁→简书，简体系书选中繁体词须转回简体去搜。
// 单向判定会漏掉 s2t 族显示（简书 + 简→繁显示）——正文显示繁体、书语言 zh-CN
// 不匹配繁体系，繁体词不 reverse 就搜不中简体索引。
export const toSelectionSearchTerm = async (
  text: string,
  bookLanguage: string | undefined,
  convertChineseVariant: ConvertChineseVariant,
): Promise<string> => {
  const convert = convertChineseVariant && convertChineseVariant !== 'none';
  const isHantBook = !!bookLanguage && /hant|tw|hk/i.test(bookLanguage);
  const isSimplifiedSource = /^s2/.test(convertChineseVariant);
  const shouldReverse = isSimplifiedSource ? !isHantBook : isHantBook;
  if (!convert || !shouldReverse) return text;
  // C-10：转换前先确保 WASM 就绪；初始化失败（或并发未完成）时回退原文，
  // 首次划词不再因 simplecc 未加载而抛错/搜索静默失效。
  try {
    await initSimpleCC();
    return runSimpleCC(text, convertChineseVariant, true);
  } catch (error) {
    console.warn('simplecc 未就绪，按原文搜索:', error);
    return text;
  }
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
