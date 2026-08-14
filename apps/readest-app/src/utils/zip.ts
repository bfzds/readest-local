import { Configuration } from '@zip.js/zip.js';

// zip.js 的 web worker 脚本是自包含产物（无 import/export），静态分发到
// public/ 下（与 library-search worker 同一模式），构建后由 Tauri/Next 原样提供。
// 解压移到 worker 线程后，大文件 inflate 的分配峰值不再落在主线程。
const ZIP_WORKER_URI = '/workers/zip/zip-web-worker.js';

export const configureZip = async (configuration?: Partial<Configuration>) => {
  const { configure } = await import('@zip.js/zip.js');
  configure({
    useWebWorkers: true,
    useCompressionStream: false,
    workerURI: ZIP_WORKER_URI,
    ...(configuration ? configuration : {}),
  });
};
