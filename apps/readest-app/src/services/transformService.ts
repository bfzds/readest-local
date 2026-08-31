import { availableTransformers } from './transformers';
import { TransformContext } from './transformers/types';

// P-6：transform 输出 LRU 缓存。翻回旧章（refcount 驱逐后重建）不必重跑整条
// transformer 链，命中直接复用上次的输出。key 覆盖所有影响输出的输入：
// 章节键/内容指纹/语言/locale/布局/尺寸/transformers/设置。
const MAX_TRANSFORM_CACHE_ENTRIES = 32;
const MAX_TRANSFORM_CACHE_BYTES = 8 * 1024 * 1024;
const transformCache = new Map<string, string>();
let transformCacheBytes = 0;

// O(n) 滚动哈希，远低于十段 transform 的整章解析成本。两路不同乘子的 32 位
// 滚动 hash 异或长度，降低部分结构性/常见碰撞风险（如多项式 hash 对特定
// 模式的退化）；最终经 `>>> 0` 输出仍是 32 位指纹（不宣称更大碰撞空间）。
const contentFingerprint = (content: string): number => {
  let h1 = 0;
  let h2 = 0;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    h1 = (h1 * 31 + code) | 0;
    h2 = (Math.imul(h2, 0x9e3779b1) + code) | 0;
  }
  // 长度参与最终组合，先消除最廉价的前缀/截断碰撞。
  return (h1 ^ Math.imul(h2, content.length + 1)) >>> 0;
};

// viewSettings 是纯数据（型号字段均为字符串/数字/布尔），JSON 序列化稳定；
// 若含不可序列化值则退化为空串并保守地全键同类（宁可多算不错返回）。
const viewSettingsKey = (viewSettings: TransformContext['viewSettings']): string => {
  try {
    return JSON.stringify(viewSettings);
  } catch {
    return '';
  }
};

const makeTransformCacheKey = (ctx: TransformContext): string =>
  [
    ctx.bookKey,
    ctx.sectionHref ?? '',
    ctx.userLocale,
    ctx.isFixedLayout ? 'f' : 'p',
    ctx.primaryLanguage ?? '',
    ctx.width ?? 0,
    ctx.height ?? 0,
    ctx.transformers.join(','),
    viewSettingsKey(ctx.viewSettings),
    contentFingerprint(ctx.content),
  ].join('|');

const trimTransformCache = () => {
  while (
    transformCache.size > MAX_TRANSFORM_CACHE_ENTRIES ||
    (transformCache.size > 0 && transformCacheBytes > MAX_TRANSFORM_CACHE_BYTES)
  ) {
    const oldestKey = transformCache.keys().next().value;
    if (oldestKey == null) break;
    transformCacheBytes -= (transformCache.get(oldestKey)?.length ?? 0) * 2;
    transformCache.delete(oldestKey);
  }
};

export const transformContent = async (ctx: TransformContext): Promise<string> => {
  const cacheKey = makeTransformCacheKey(ctx);
  const cached = transformCache.get(cacheKey);
  if (cached != null) {
    transformCache.delete(cacheKey);
    transformCache.set(cacheKey, cached);
    return cached;
  }

  let transformed = ctx.content;

  const activeTransformers = ctx.transformers
    .map((name) => availableTransformers.find((transformer) => transformer.name === name))
    .filter((transformer) => !!transformer);
  for (const transformer of activeTransformers) {
    try {
      transformed = await transformer.transform({ ...ctx, content: transformed });
    } catch (error) {
      console.warn(`Error in transformer ${transformer.name}:`, error);
    }
  }

  const entryBytes = transformed.length * 2;
  transformCacheBytes += entryBytes;
  transformCache.set(cacheKey, transformed);
  trimTransformCache();

  return transformed;
};
