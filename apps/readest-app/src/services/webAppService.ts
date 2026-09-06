import { FileSystem, BaseDir, AppPlatform, ResolvedPath } from '@/types/system';
import { Book } from '@/types/book';
import { DatabaseOpts, DatabaseService } from '@/types/database';
import { SchemaType } from '@/services/database/migrate';
import { isValidURL } from '@/utils/misc';
import { isSafariBrowser } from '@/utils/ua';
import { RemoteFile } from '@/utils/file';
import { detectViewTransitionGroup, detectViewTransitionsAPI } from '@/utils/viewTransition';
import { BaseAppService } from './appService';
import {
  DATA_SUBDIR,
  LOCAL_BOOKS_SUBDIR,
  LOCAL_DICTIONARIES_SUBDIR,
  LOCAL_FONTS_SUBDIR,
  LOCAL_IMAGES_SUBDIR,
} from './constants';

/**
 * 浏览器端应用服务（浏览器 UI 调试模式，方案一）。
 *
 * 移植自上游 readest 的 WebAppService（b8e1114 移除前版本），按当前接口
 * 适配。定位是 UI 调试载体：数据层完整可用（IndexedDB 文件系统 + 设置 +
 * 书库 + 导入），桌面/原生专属能力显式关闭或降级——
 *   - 无 Tauri 窗口体系（hasWindow=false），窗口管理代码全部旁路；
 *   - 无宿主文件系统，selectDirectory/selectFiles 走 useFileSelector 的
 *     浏览器文件选择器，selectFiles 本体拒绝调用；
 *   - 无原生 SQLite（turso-wasm 已随 web 运行时移除），openDatabase 拒绝
 *     调用，统计/搜索索引沿既有 catch 优雅降级；
 *   - 跨窗口 library 锁降级为 null：BaseAppService 的内存保存串行链在
 *     单窗口浏览器里即已足够。
 */

const resolvePath = (path: string, base: BaseDir): ResolvedPath => {
  switch (base) {
    case 'Data':
      return { baseDir: 0, basePrefix: async () => '', fp: `${DATA_SUBDIR}/${path}`, base };
    case 'Books':
      return { baseDir: 0, basePrefix: async () => '', fp: `${LOCAL_BOOKS_SUBDIR}/${path}`, base };
    case 'Fonts':
      return { baseDir: 0, basePrefix: async () => '', fp: `${LOCAL_FONTS_SUBDIR}/${path}`, base };
    case 'Images':
      return { baseDir: 0, basePrefix: async () => '', fp: `${LOCAL_IMAGES_SUBDIR}/${path}`, base };
    case 'Dictionaries':
      return {
        baseDir: 0,
        basePrefix: async () => '',
        fp: `${LOCAL_DICTIONARIES_SUBDIR}/${path}`,
        base,
      };
    case 'None':
      return { baseDir: 0, basePrefix: async () => '', fp: path, base };
    default:
      return { baseDir: 0, basePrefix: async () => '', fp: `${base}/${path}`, base };
  }
};

const dbName = 'AppFileSystem';
const dbVersion = 1;

// 跨 realm 安全的 ArrayBuffer 判定：IndexedDB 读回的值经结构化克隆，在
// jsdom + fake-indexeddb 组合下 instanceof 会因 realm 不同而失效。
const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
  Object.prototype.toString.call(value) === '[object ArrayBuffer]';

const contentByteLength = (content: unknown): number => {
  if (typeof Blob !== 'undefined' && content instanceof Blob) return content.size;
  if (typeof content === 'string') return content.length;
  if (isArrayBuffer(content)) return content.byteLength;
  return 0;
};

async function openIndexedDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, dbVersion);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'path' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const indexedDBFileSystem: FileSystem = {
  resolvePath,
  async getPrefix(base: BaseDir) {
    const { fp } = resolvePath('', base);
    return fp.replace(/\/+$/, '');
  },
  getURL(path: string) {
    if (isValidURL(path)) {
      return path;
    } else {
      return URL.createObjectURL(new Blob([path]));
    }
  },
  async getBlobURL(path: string, base: BaseDir) {
    try {
      const content = await this.readFile(path, base, 'binary');
      return URL.createObjectURL(new Blob([content]));
    } catch {
      return path;
    }
  },
  async getImageURL(path: string) {
    return await this.getBlobURL(path, 'None');
  },
  async openFile(path: string, base: BaseDir, filename?: string) {
    if (isValidURL(path)) {
      return await new RemoteFile(path, filename).open();
    } else {
      const content = await this.readFile(path, base, 'binary');
      return new File([content], filename || path);
    }
  },
  async copyFile(srcPath: string, srcBase: BaseDir, dstPath: string, dstBase: BaseDir) {
    const { fp: srcFp } = resolvePath(srcPath, srcBase);
    const { fp: dstFp } = resolvePath(dstPath, dstBase);
    const db = await openIndexedDB();

    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('files', 'readwrite');
      const store = transaction.objectStore('files');
      const getRequest = store.get(srcFp);

      getRequest.onsuccess = () => {
        const data = getRequest.result;
        if (data) {
          store.put({ path: dstFp, content: data.content });
          resolve();
        } else {
          reject(new Error(`File not found: ${srcFp}`));
        }
      };

      getRequest.onerror = () => reject(getRequest.error);
    });
  },
  async readFile(path: string, base: BaseDir, mode: 'text' | 'binary') {
    const { fp } = resolvePath(path, base);
    const db = await openIndexedDB();

    return new Promise<string | ArrayBuffer>((resolve, reject) => {
      const transaction = db.transaction('files', 'readonly');
      const store = transaction.objectStore('files');
      const request = store.get(fp);

      request.onsuccess = async () => {
        if (request.result) {
          const content = request.result.content;
          if (mode === 'text') resolve(content);
          else {
            if (typeof Blob !== 'undefined' && content instanceof Blob) {
              const arrayBuffer = await content.arrayBuffer();
              resolve(arrayBuffer);
            } else if (isArrayBuffer(content)) {
              resolve(content);
            } else if (typeof content === 'string') {
              resolve(new TextEncoder().encode(content).buffer as ArrayBuffer);
            } else {
              reject(new Error('Unsupported content type in IndexedDB'));
            }
          }
        } else {
          reject(new Error(`File not found: ${fp}`));
        }
      };

      request.onerror = () => reject(request.error);
    });
  },
  async writeFile(path: string, base: BaseDir, content: string | ArrayBuffer | File) {
    const { fp } = resolvePath(path, base);
    const db = await openIndexedDB();

    if (content instanceof File) {
      content = await content.arrayBuffer();
    }
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('files', 'readwrite');
      const store = transaction.objectStore('files');

      store.put({ path: fp, content });

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  },
  async removeFile(path: string, base: BaseDir) {
    const { fp } = resolvePath(path, base);
    const db = await openIndexedDB();

    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('files', 'readwrite');
      const store = transaction.objectStore('files');

      store.delete(fp);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  },
  async createDir(path: string, base: BaseDir, _recursive?: boolean) {
    return await this.writeFile(path, base, '');
  },
  async removeDir(path: string, base: BaseDir, _recursive?: boolean) {
    const { fp } = resolvePath(path, base);
    const db = await openIndexedDB();

    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('files', 'readwrite');
      const store = transaction.objectStore('files');
      const request = store.getAll();

      request.onsuccess = () => {
        const files = request.result as { path: string }[];
        files.forEach((file) => {
          if (file.path.startsWith(fp)) {
            store.delete(file.path);
          }
        });
      };

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  },
  async readDir(path: string, base: BaseDir, _extensions?: string[]) {
    const { fp } = resolvePath(path, base);
    const prefix = fp.endsWith('/') ? fp : `${fp}/`;
    const db = await openIndexedDB();

    return new Promise<import('@/types/system').FileItem[]>((resolve, reject) => {
      const transaction = db.transaction('files', 'readonly');
      const store = transaction.objectStore('files');
      // Keys are file paths: constrain to the directory prefix instead of
      // materializing the whole store (every book blob) per listing — an
      // unbounded getAll() here cost seconds per call on large libraries.
      const request = store.getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`, false, true));

      request.onsuccess = () => {
        const files = request.result as { path: string; content: string | ArrayBuffer | Blob }[];
        resolve(
          files
            .filter((file) => file.path.startsWith(prefix))
            .map((file) => ({
              path: file.path.slice(prefix.length),
              size: contentByteLength(file.content),
            })),
        );
      };

      request.onerror = () => reject(request.error);
    });
  },
  async exists(path: string, base: BaseDir) {
    const { fp } = resolvePath(path, base);
    const db = await openIndexedDB();

    return new Promise<boolean>((resolve, reject) => {
      const transaction = db.transaction('files', 'readonly');
      const store = transaction.objectStore('files');
      const request = store.get(fp);

      request.onsuccess = () => resolve(!!request.result);
      request.onerror = () => reject(request.error);
    });
  },
  async stats(path: string, base: BaseDir) {
    const { fp } = resolvePath(path, base);
    const db = await openIndexedDB();

    return new Promise<import('@/types/system').FileInfo>((resolve, reject) => {
      const transaction = db.transaction('files', 'readonly');
      const store = transaction.objectStore('files');
      const request = store.get(fp);

      request.onsuccess = () => {
        const result = request.result;
        if (result) {
          resolve({
            isFile: true,
            isDirectory: false,
            size: contentByteLength(result.content),
            mtime: null,
            atime: null,
            birthtime: null,
          });
        } else {
          reject(new Error(`File not found: ${fp}`));
        }
      };

      request.onerror = () => reject(request.error);
    });
  },
};

export class WebAppService extends BaseAppService {
  fs = indexedDBFileSystem;
  override appPlatform = 'web' as AppPlatform;
  override supportsCanvasContext2DFilter = !isSafariBrowser();
  override supportsViewTransitionsAPI = detectViewTransitionsAPI();
  override supportsViewTransitionGroup = detectViewTransitionGroup();

  override async init() {
    await this.loadSettings();
    await this.prepareBooksDir();
    await this.runMigrations(this.CURRENT_MIGRATION_VERSION);
  }

  override resolvePath(fp: string, base: BaseDir): ResolvedPath {
    return this.fs.resolvePath(fp, base);
  }

  async setCustomRootDir() {
    // No-op in web environment
  }

  async selectDirectory(_mode: 'read' | 'write'): Promise<string> {
    throw new Error('selectDirectory is not supported in browser');
  }

  async selectFiles(_name: string, _extensions: string[]): Promise<string[]> {
    throw new Error('selectFiles is not supported in browser; use the file picker flow');
  }

  async saveFile(
    filename: string,
    content: string | ArrayBuffer | null,
    options?: {
      filePath?: string;
      mimeType?: string;
      share?: boolean;
      sharePosition?: { x: number; y: number; preferredEdge?: 'top' | 'bottom' | 'left' | 'right' };
    },
  ): Promise<boolean> {
    const mimeType = options?.mimeType || 'application/octet-stream';
    // Web has no filesystem path to read from, so `null` content (only the
    // native-only "Send" flow passes it) degrades to an empty body.
    const body = content ?? '';
    try {
      const blob = new Blob([body], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    } catch (error) {
      console.error('Failed to save file:', error);
      return false;
    }
  }

  // No system photo gallery on the web; callers fall back to the saveFile flow.
  async saveImageToGallery(): Promise<boolean> {
    return false;
  }

  async ask(message: string): Promise<boolean> {
    return window.confirm(message);
  }

  async openDatabase(
    _schema: SchemaType,
    _path: string,
    _base: BaseDir,
    _opts?: DatabaseOpts,
  ): Promise<DatabaseService> {
    // turso-wasm / OPFS 数据库随 web 运行时移除（b8e1114）。统计与搜索索引
    // 的打开方均有 catch，按"无数据库"降级，不阻塞 UI 调试。
    throw new Error('openDatabase is not supported in browser');
  }

  // 浏览器没有宿主文件系统：绝不能让基类把 IndexedDB 伪路径当原生路径
  // 返回给 DocumentLoader（nativeFilePath 只该在 Tauri 下非空）。
  override async resolveNativeBookFilePath(_book: Book): Promise<string | null> {
    return null;
  }
}
