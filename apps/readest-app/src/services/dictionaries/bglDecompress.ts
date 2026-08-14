import { gunzipSync } from 'fflate';

const DECOMPRESS_TIMEOUT_MS = 60_000;

/**
 * 在专用 worker 中解压 BGL 的 gzip 块流。BGL 词典可达几十 MB 压缩、解压后
 * 数百 MB，gunzip 全量解压若留在主线程会造成大计算 + 大缓冲分配峰值。
 * 这里把压缩数据 transferable 移交 worker，解压结果同样 transferable 零拷贝
 * 交回主线程；worker 不可用或失败时回退主线程 gunzipSync。
 *
 * 注意：gzipBytes 可能是某个更大 buffer 的 subarray（bglReader 中带 junk 前缀），
 * 直接 transfer 其底层 buffer 会 detach 共享区，因此总是先复制出独立的 gzip 区。
 */
export const decompressBglData = async (gzipBytes: Uint8Array): Promise<Uint8Array> => {
  if (typeof Worker === 'undefined') {
    return gunzipSync(gzipBytes);
  }
  try {
    return await decompressInWorker(gzipBytes);
  } catch (error) {
    console.warn('BGL decompress worker failed, falling back to main thread:', error);
    return gunzipSync(gzipBytes);
  }
};

const decompressInWorker = (gzipBytes: Uint8Array): Promise<Uint8Array> => {
  // 注意：gzipBytes 可能是某个更大 buffer 的 subarray（bglReader 中带 junk
  // 前缀），直接 transfer 其底层 buffer 会 detach 共享区，因此总是先复制出
  // 独立的 gzip 区。
  const buffer = gzipBytes.buffer.slice(
    gzipBytes.byteOffset,
    gzipBytes.byteOffset + gzipBytes.byteLength,
  );
  return new Promise<Uint8Array>((resolve, reject) => {
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('../../workers/bgl-decompress.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const cleanup = () => {
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`BGL decompress worker timed out after ${DECOMPRESS_TIMEOUT_MS}ms`));
    }, DECOMPRESS_TIMEOUT_MS);
    worker.onmessage = (
      event: MessageEvent<{ id: number; data?: ArrayBuffer; error?: string }>,
    ) => {
      clearTimeout(timer);
      cleanup();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.data) resolve(new Uint8Array(event.data.data));
      else reject(new Error('BGL decompress worker returned no data'));
    };
    worker.onerror = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('BGL decompress worker failed'));
    };
    worker.onmessageerror = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('BGL decompress worker message deserialization failed'));
    };
    worker.postMessage({ id: 0, buffer }, [buffer]);
  });
};
