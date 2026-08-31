import { describe, it, expect } from 'vitest';
import { BaseAppService } from '@/services/appService';
import type { Book } from '@/types/book';
import type { FileSystem, ResolvedPath, BaseDir } from '@/types/system';

const makeBook = (partial: Partial<Book>): Book => ({
  hash: 'b1',
  format: 'MD',
  title: 'A',
  author: '',
  createdAt: 1,
  updatedAt: 100,
  ...partial,
});

// 最小 BaseAppService 子类 + 内存 library.json，用于验证保存串行化。
class MemSaveService extends BaseAppService {
  mem: string;
  constructor(initial: string) {
    super();
    this.mem = initial;
  }

  protected override fs = {
    readFile: async (): Promise<unknown> => this.mem,
    writeFile: async (path: string, _base: unknown, data: string): Promise<void> => {
      if (path.includes('library.json')) {
        this.mem = typeof data === 'string' ? data : JSON.stringify(data);
      }
    },
  } as unknown as FileSystem;

  protected resolvePath(_fp: string, base: BaseDir): ResolvedPath {
    return {
      baseDir: 0 as never,
      basePrefix: async () => '',
      fp: '',
      base,
    };
  }

  override init = async (): Promise<void> => {};
  override setCustomRootDir = async (): Promise<void> => {};
  override selectDirectory = async (): Promise<string> => '';
  override selectFiles = async (): Promise<string[]> => [];
  override saveFile = async (): Promise<boolean> => true;
  override saveImageToGallery = async (): Promise<boolean> => false;
  override ask = async (): Promise<boolean> => true;
  override openDatabase = async (): Promise<never> => {
    throw new Error('not implemented in memory service');
  };
}

describe('library save serialized across concurrent saveLibraryBooks (B-7)', () => {
  it('两个并发保存不会互相覆盖较新的字段', async () => {
    const svc = new MemSaveService(JSON.stringify([makeBook({ title: 'A', updatedAt: 100 })]));
    // 窗口 A 保存新标题（updatedAt 200），窗口 B 用旧快照保存（updatedAt 100）。
    // 若无跨保存互斥，B 可能在 A 写盘前读到旧库并在 A 之后覆盖，丢失新标题。
    await expect(
      Promise.all([
        svc.saveLibraryBooks([makeBook({ title: 'A-new', updatedAt: 200 })]),
        svc.saveLibraryBooks([makeBook({ title: 'A', updatedAt: 100 })]),
      ]),
    ).resolves.toBeDefined();

    const disk = JSON.parse(svc.mem) as Book[];
    expect(disk).toHaveLength(1);
    // LWW：磁盘较新（updatedAt 200）的记录保留，A-new 不被旧快照覆盖。
    expect(disk[0]!.title).toBe('A-new');
    expect(disk[0]!.updatedAt).toBe(200);
  });

  it('串行化的 read-merge-write 让后保存者看到最新磁盘数据', async () => {
    const svc = new MemSaveService(JSON.stringify([makeBook({ title: 'base', updatedAt: 50 })]));
    const first = svc.saveLibraryBooks([makeBook({ title: 'first-write', updatedAt: 300 })]);
    const second = svc.saveLibraryBooks([makeBook({ title: 'second-sync', updatedAt: 400 })]);
    await Promise.all([first, second]);

    const disk = JSON.parse(svc.mem) as Book[];
    expect(disk[0]!.title).toBe('second-sync');
  });
});
