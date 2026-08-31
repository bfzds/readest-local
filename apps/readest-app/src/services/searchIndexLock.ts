import type { BaseDir, FileInfo } from '@/types/system';

// SF3：双窗口（书库页 + 阅读页）各自独立 WebView，JS 层 in-flight 表跨窗口
// 不可达；同一本书的 search.db 若被两窗口同时判定为脏，会各做一遍完整重建
// （双倍提取 + 双倍写入）。这里用书目录下一个锁目录做跨窗口互斥：
// createDir 是原子的（已存在抛错），拿锁 = 独占重建权；崩溃残留的锁目录用
// mtime 判定陈旧后接管，避免永久卡死。

// D-11：陈旧阈值从 30s 放宽到 120s——大书索引重建（提取+写入）完全可能
// 超过 30s，30s 阈值会让并发窗口把"活锁"误判为陈旧而接管、触发双重建。
export const SEARCH_BUILD_LOCK_STALE_MS = 120_000;
const LOCK_DIR_SUFFIX = '.search-index.lock';
export const searchBuildLockPath = (bookHash: string) => `${bookHash}/${LOCK_DIR_SUFFIX}`;

export interface LockFs {
  createDir(path: string, base: BaseDir, recursive?: boolean): Promise<void>;
  stats(path: string, base: BaseDir): Promise<FileInfo>;
  deleteDir(path: string, base: BaseDir, recursive?: boolean): Promise<void>;
}

/** 尝试获取某本书索引重建的独占锁。true=本调用负责重建；false=另一窗口在重建。 */
export const tryAcquireSearchBuildLock = async (
  fs: LockFs,
  bookHash: string,
  now = Date.now(),
): Promise<boolean> => {
  const path = searchBuildLockPath(bookHash);
  try {
    await fs.createDir(path, 'Books', false);
    return true;
  } catch {
    // 目录已存在：新鲜锁让出（另一窗口在重建），陈旧锁（崩溃残留）接管。
    const info = await fs.stats(path, 'Books').catch(() => null);
    const mtime = info?.mtime?.getTime() ?? 0;
    if (now - mtime > SEARCH_BUILD_LOCK_STALE_MS) {
      await fs.deleteDir(path, 'Books', true).catch(() => {});
      await fs.createDir(path, 'Books', false).catch(() => {});
      return true;
    }
    return false;
  }
};

/** 释放锁。幂等：锁不存在时 no-op。 */
export const releaseSearchBuildLock = async (fs: LockFs, bookHash: string): Promise<void> => {
  await fs.deleteDir(searchBuildLockPath(bookHash), 'Books', true).catch(() => {});
};
