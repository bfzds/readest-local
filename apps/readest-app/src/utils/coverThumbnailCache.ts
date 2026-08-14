/**
 * 封面缩略 URL 的缓存管理层：并发去重 + 容量 LRU + 失败不缓存。
 * loader 是平台相关实现（浏览器内 img→canvas 缩放），此处只负责缓存语义，
 * 便于单元测试；null 结果（如跨域 canvas 污染回退）不缓存，下次重试。
 */
export interface CoverThumbnailCacheOptions {
  capacity?: number;
}

export const createCoverThumbnailCache = <T>(
  loader: (src: string) => Promise<T | null>,
  options: CoverThumbnailCacheOptions = {},
) => {
  const capacity = options.capacity ?? 128;
  const inflight = new Map<string, Promise<T | null>>();

  const get = (src: string): Promise<T | null> => {
    const existing = inflight.get(src);
    if (existing) {
      inflight.delete(src);
      inflight.set(src, existing);
      return existing;
    }
    const p = loader(src).then(
      (value) => {
        if (value === null) inflight.delete(src);
        return value;
      },
      (error) => {
        inflight.delete(src);
        throw error;
      },
    );
    inflight.set(src, p);
    while (inflight.size > capacity) {
      const oldest = inflight.keys().next().value;
      if (oldest === undefined || oldest === src) break;
      inflight.delete(oldest);
    }
    return p;
  };

  const clear = () => inflight.clear();

  return { get, clear };
};
