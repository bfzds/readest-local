import { describe, test, expect, vi } from 'vitest';
import { createCoverThumbnailCache } from '@/utils/coverThumbnailCache';

describe('createCoverThumbnailCache', () => {
  test('calls loader once per src (dedupes concurrent requests)', async () => {
    const loader = vi.fn().mockResolvedValue('thumb-a');
    const cache = createCoverThumbnailCache(loader);
    const [r1, r2] = await Promise.all([cache.get('a'), cache.get('a')]);
    expect(r1).toBe('thumb-a');
    expect(r2).toBe('thumb-a');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test('serves the cached value on repeat get without reloading', async () => {
    const loader = vi.fn().mockResolvedValue('thumb-a');
    const cache = createCoverThumbnailCache(loader);
    await cache.get('a');
    await cache.get('a');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test('evicts the oldest entry beyond capacity', async () => {
    const loader = vi.fn().mockResolvedValue('thumb');
    const cache = createCoverThumbnailCache(loader, { capacity: 2 });
    await cache.get('a');
    await cache.get('b');
    await cache.get('c'); // evicts a
    expect(loader).toHaveBeenCalledTimes(3);
    await cache.get('a'); // reloaded
    expect(loader).toHaveBeenCalledTimes(4);
  });

  test('a repeat get promotes the entry to most-recently-used', async () => {
    const loader = vi.fn().mockResolvedValue('thumb');
    const cache = createCoverThumbnailCache(loader, { capacity: 2 });
    await cache.get('a');
    await cache.get('b');
    await cache.get('a'); // promotes a
    await cache.get('c'); // evicts b (oldest)
    expect(loader).toHaveBeenCalledTimes(3);
    expect(await cache.get('b')).toBe('thumb'); // reloads b
    expect(loader).toHaveBeenCalledTimes(4);
  });

  test('does not cache null results so transient failures are retried', async () => {
    const loader = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('thumb');
    const cache = createCoverThumbnailCache(loader);
    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('a')).toBe('thumb');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  test('does not cache rejected promises', async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce('thumb');
    const cache = createCoverThumbnailCache(loader);
    await expect(cache.get('a')).rejects.toThrow('fail');
    expect(await cache.get('a')).toBe('thumb');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  test('clear resets the cache', async () => {
    const loader = vi.fn().mockResolvedValue('thumb');
    const cache = createCoverThumbnailCache(loader);
    await cache.get('a');
    cache.clear();
    await cache.get('a');
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
