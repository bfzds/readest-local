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
  // barrier：第一次保存的写盘可被测试扣住，用于证明 read-merge-write 顺序。
  releaseFirstWrite!: () => void;
  private firstWriteGate = new Promise<void>((resolve) => {
    this.releaseFirstWrite = resolve;
  });
  private gateEnabled = false;
  private writes = 0;
  constructor(initial: string) {
    super();
    this.mem = initial;
  }

  /** 仅 barrier 测试启用：第一次写盘前挂起，直到 releaseFirstWrite。 */
  enableWriteBarrier(): void {
    this.gateEnabled = true;
  }

  readWrites(): number {
    return this.writes;
  }

  protected override fs = {
    readFile: async (): Promise<unknown> => this.mem,
    writeFile: async (path: string, _base: unknown, data: string): Promise<void> => {
      if (path.includes('library.json')) {
        this.writes += 1;
        if (this.gateEnabled && this.writes === 1) await this.firstWriteGate;
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

describe('barrier proves read-merge-write order (Task3)', () => {
  it('先写者未完成时后写者不进入 read；释放后读到先写数据', async () => {
    const svc = new MemSaveService(JSON.stringify([makeBook({ title: 'base', updatedAt: 50 })]));
    svc.enableWriteBarrier();
    const first = svc.saveLibraryBooks([makeBook({ title: 'A', updatedAt: 300 })]);
    const second = svc.saveLibraryBooks([makeBook({ title: 'B', updatedAt: 100 })]);
    // 让第一个保存推进到 write gate（此时第二个保存被内存串行链挡住，未进入 read）。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(svc.readWrites()).toBe(1); // A 已到首次写盘（挂起在 gate），B 尚未参与
    svc.releaseFirstWrite();
    await Promise.all([first, second]);
    const disk = JSON.parse(svc.mem) as Book[];
    // 后保存者读到 A 的磁盘数据（updatedAt 300），旧快照（100）不覆盖它。
    expect(disk[0]!.title).toBe('A');
    expect(disk[0]!.updatedAt).toBe(300);
  });
});
