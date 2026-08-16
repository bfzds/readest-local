/**
 * 封面缩略 URL 的缓存管理层：并发去重 + 容量 LRU + 失败不缓存。
 * loader 是平台相关实现（浏览器内 img→canvas 缩放），此处只负责缓存语义，
 * 便于单元测试；null 结果（如跨域 canvas 污染回退）不缓存，下次重试。
 *
 * revoke 回调（可选）负责回收条目的底层资源：缩略图用 URL.createObjectURL
 * 生成，驱逐/delete/clear 时若不 revoke，object URL 只建不销，长会话内存
 * 只增不减。revoke 在 promise settle 后对已 resolve 的 value 调用，未 resolve
 * 的条目（仍在加载中）不回收——其 value 尚不存在，且组件可能正等它显示。
 */
export interface CoverThumbnailCacheOptions {
  capacity?: number;
}

export const createCoverThumbnailCache = <T>(
  loader: (src: string) => Promise<T | null>,
  options: CoverThumbnailCacheOptions = {},
  revoke?: (value: T) => void,
) => {
  const capacity = options.capacity ?? 128;
  const inflight = new Map<string, Promise<T | null>>();

  const release = (src: string) => {
    const p = inflight.get(src);
    inflight.delete(src);
    if (p && revoke) {
      void p.then((value) => {
        if (value !== null) revoke(value);
      });
    }
  };

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
      release(oldest);
    }
    return p;
  };

  const deleteEntry = (src: string): boolean => {
    if (!inflight.has(src)) return false;
    release(src);
    return true;
  };

  const clear = () => {
    for (const key of [...inflight.keys()]) release(key);
  };

  return { get, delete: deleteEntry, clear };
};
