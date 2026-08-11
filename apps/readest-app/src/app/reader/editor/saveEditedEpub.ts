import { Book, BookConfig } from '@/types/book';
import { AppService } from '@/types/system';
import { EnvConfigType } from '@/services/environment';
import { useLibraryStore } from '@/store/libraryStore';
import {
  getBookNavFilename,
  getConfigFilename,
  getCoverFilename,
  getDir,
  getLocalBookFilename,
  INIT_BOOK_CONFIG,
} from '@/utils/book';
import { partialMD5 } from '@/utils/md5';
import { serializeRawConfig } from '@/utils/serializer';

export interface SaveEditedEpubResult {
  book: Book;
}

/**
 * 保存编辑后的 EPUB：写入新 hash 目录、迁移旧 config 的阅读进度、
 * 尽力复制封面/导航、更新内存与磁盘上的 library，并清理旧目录。
 * 失败时清理半成品新目录后 rethrow；旧目录从头到尾未被覆盖，无需恢复。
 */
export async function saveEditedEpub(opts: {
  appService: AppService;
  envConfig: EnvConfigType; // 保留在参数类型里，但实现不使用
  book: Book;
  newEpub: Blob;
}): Promise<SaveEditedEpubResult> {
  const { appService, book, newEpub } = opts;
  const oldHash = book.hash;
  const file = new File([newEpub], `${book.sourceTitle || book.title}.epub`, {
    type: 'application/epub+zip',
  });
  const newHash = await partialMD5(file);
  const newBook: Book = { ...book, hash: newHash, updatedAt: Date.now() };
  const newDir = getDir(newBook);

  try {
    await appService.createDir(newDir, 'Books', true);
    await appService.writeFile(getLocalBookFilename(newBook), 'Books', file);

    let config: BookConfig = { ...INIT_BOOK_CONFIG };
    try {
      const raw = await appService.readFile(getConfigFilename(book), 'Books', 'text');
      const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      const parsed = JSON.parse(text);
      config = { ...INIT_BOOK_CONFIG, ...(parsed as Partial<BookConfig>) };
    } catch {
      // 旧配置读不到或解析失败，保持初始配置
    }
    config.bookHash = newHash;
    config.metaHash = book.metaHash;
    await appService.writeFile(getConfigFilename(newBook), 'Books', serializeRawConfig(config));

    // 封面/导航为可选文件，复制失败忽略
    try {
      await appService.copyFile(
        getCoverFilename(book),
        'Books',
        getCoverFilename(newBook),
        'Books',
      );
    } catch {
      // 无封面可复制
    }
    try {
      await appService.copyFile(
        getBookNavFilename(book),
        'Books',
        getBookNavFilename(newBook),
        'Books',
      );
    } catch {
      // 无导航可复制
    }

    const { library, setLibrary } = useLibraryStore.getState();
    const nextLibrary = library.map((item) => (item.hash === oldHash ? newBook : item));
    setLibrary(nextLibrary);
    await appService.saveLibraryBooks(nextLibrary);

    if (oldHash !== newHash && (await appService.isDirectory(oldHash, 'Books'))) {
      try {
        await appService.deleteDir(oldHash, 'Books', true);
      } catch {
        // 旧目录清理失败可忽略——新副本已就位
      }
    }

    return { book: newBook };
  } catch (error) {
    // 清理半成品新目录后 rethrow；旧目录未被覆盖，无需恢复
    if (newHash !== oldHash) {
      try {
        await appService.deleteDir(newDir, 'Books', true);
      } catch {
        // 尽力清理，忽略失败
      }
    }
    throw error;
  }
}
