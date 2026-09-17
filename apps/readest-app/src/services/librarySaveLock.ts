import { LibraryLock } from '@/types/system';

/**
 * 跨窗口书库锁的续期间隔。Rust 侧的陈旧阈值（`LOCK_STALE_AFTER_MS`）是 30s，
 * 这里 3s 续一次：临界区内 JS 只做 JSON 序列化与两次写盘（毫秒级），回调不会
 * 饿死，因此 10 倍余量足以区分"持有者还在"与"持有者已亡"。
 */
export const LOCK_RENEW_INTERVAL_MS = 3_000;

export interface LibraryLockOps {
  acquire: () => Promise<LibraryLock | null>;
  renew: (lock: LibraryLock) => Promise<void>;
  release: (lock: LibraryLock) => Promise<void>;
}

/**
 * 在跨窗口书库锁的临界区内执行一次保存。
 *
 * 存活判定靠"租约"：持锁期间由这里定时续期，一旦本次保存结束（含抛错）就停止
 * 续期——锁随即在 Rust 侧老化，30s 后任何窗口都能回收。这修掉的是真机上实测到的
 * 毒锁：那次保存写完两个文件后没能释放锁，而旧实现由 Rust 后台线程自主心跳，
 * 与持有者的生命周期解耦，于是锁永远"新鲜"、全应用所有保存只能等 5s 超时失败。
 *
 * 三条不变量：
 *  1. 释放永远发生在停止续期之后——即便 release 失败，也不再有东西让它保鲜；
 *  2. 续期失败（锁已被回收/被他人接管）立即停止续期并记录，不再对着空气续；
 *  3. 释放失败不改判保存结果（数据已落盘），只记录——由 Rust 侧的退避重试与
 *     租约老化兜底。
 */
export async function runWithLibraryLock<T>(
  ops: LibraryLockOps,
  task: () => Promise<T>,
): Promise<T> {
  const lock = await ops.acquire();
  // 非 Tauri 平台（浏览器/测试）没有跨窗口锁，直接执行。
  if (!lock) return task();

  let renewTimer: ReturnType<typeof setInterval> | null = null;
  const stopRenewing = () => {
    if (renewTimer != null) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
  };
  renewTimer = setInterval(() => {
    void ops.renew(lock).catch((error) => {
      console.warn('Failed to renew the library save lock; stopping renewal:', error);
      stopRenewing();
    });
  }, LOCK_RENEW_INTERVAL_MS);

  try {
    return await task();
  } finally {
    stopRenewing();
    try {
      await ops.release(lock);
    } catch (error) {
      console.error('Failed to release library save lock:', error);
    }
  }
}
