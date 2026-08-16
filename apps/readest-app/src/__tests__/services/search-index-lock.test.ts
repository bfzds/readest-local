import { describe, expect, it, vi } from 'vitest';
import { releaseSearchBuildLock, tryAcquireSearchBuildLock } from '@/services/searchIndexLock';
import type { FileInfo } from '@/types/system';

const now = Date.now();

// LockFs 是 searchIndexLock 需要的窄接口（createDir/stats/deleteDir）。
const makeFs = (overrides: { dirs?: Set<string>; mtime?: Date | null } = {}) => {
  const dirs = overrides.dirs ?? new Set<string>();
  return {
    createDir: vi.fn(async (path: string, _base: string) => {
      if (dirs.has(path)) throw new Error('EEXIST');
      dirs.add(path);
    }),
    stats: vi.fn(
      async (): Promise<FileInfo> => ({
        isFile: false,
        isDirectory: true,
        size: 0,
        mtime: overrides.mtime ?? new Date(now),
        atime: null,
        birthtime: null,
      }),
    ),
    deleteDir: vi.fn(async (path: string, _base: string) => {
      dirs.delete(path);
    }),
  };
};

describe('searchIndexLock 文件锁（SF3 双窗口并发建索引互斥）', () => {
  it('锁目录不存在 → 创建并返回 true（获得锁）', async () => {
    const fs = makeFs();
    expect(await tryAcquireSearchBuildLock(fs, 'hash-a')).toBe(true);
    expect(fs.createDir).toHaveBeenCalledWith('hash-a/.search-index.lock', 'Books', false);
  });

  it('锁目录存在且新鲜 → 返回 false（另一窗口在重建）', async () => {
    const fs = makeFs({
      dirs: new Set(['hash-a/.search-index.lock']),
      mtime: new Date(now - 1000),
    });
    expect(await tryAcquireSearchBuildLock(fs, 'hash-a')).toBe(false);
  });

  it('锁目录存在但陈旧（崩溃残留）→ 接管重建', async () => {
    const fs = makeFs({
      dirs: new Set(['hash-a/.search-index.lock']),
      mtime: new Date(now - 5 * 60_000),
    });
    expect(await tryAcquireSearchBuildLock(fs, 'hash-a')).toBe(true);
  });

  it('release 删除锁目录', async () => {
    const dirs = new Set(['hash-a/.search-index.lock']);
    const fs = makeFs({ dirs });
    await releaseSearchBuildLock(fs, 'hash-a');
    expect(dirs.has('hash-a/.search-index.lock')).toBe(false);
  });

  it('release 对不存在的锁是 no-op（不抛错）', async () => {
    const fs = makeFs();
    await expect(releaseSearchBuildLock(fs, 'hash-a')).resolves.toBeUndefined();
  });
});
