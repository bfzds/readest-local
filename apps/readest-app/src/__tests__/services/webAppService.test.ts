import { describe, test, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { Book } from '@/types/book';

/**
 * 浏览器端 WebAppService（浏览器 UI 调试模式，方案一）：
 *
 * 该 fork 在 b8e1114 移除了 web 运行时后，普通浏览器打开 dev 页面只剩
 * "Readest 需要桌面环境" 兜底页。为支持在内置浏览器里调试 UI，把上游的
 * WebAppService 按当前接口重新移植：数据层走 IndexedDB 文件系统，桌面专属
 * 能力（窗口、目录选择、原生数据库）显式关闭或降级。
 *
 * fake-indexeddb 提供 jsdom 缺失的 indexedDB 实现，fs 语义按真实浏览器
 * 行为验证（异步事务、持久化 keyPath）。
 */

import { WebAppService } from '@/services/webAppService';

describe('WebAppService', () => {
  let service: WebAppService;

  beforeEach(async () => {
    service = new WebAppService();
    await service.init();
  });

  test('reports the web platform with desktop-only capabilities off', () => {
    expect(service.appPlatform).toBe('web');
    expect(service.hasWindow).toBe(false);
    expect(service.isWindowsApp).toBe(false);
    expect(service.isMacOSApp).toBe(false);
  });

  test('init prepares the Books dir prefix under the Data subdirectory', () => {
    expect(service.localBooksDir).toBe('Readest/Books');
  });

  test('write / read / exists / delete roundtrips through the IndexedDB fs', async () => {
    await service.writeFile('greet.txt', 'Data', 'hello browser');
    expect(await service.exists('greet.txt', 'Data')).toBe(true);
    expect(await service.readFile('greet.txt', 'Data', 'text')).toBe('hello browser');

    await service.deleteFile('greet.txt', 'Data');
    expect(await service.exists('greet.txt', 'Data')).toBe(false);
  });

  test('binary write preserves bytes on read-back', async () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]).buffer;
    await service.writeFile('blob.bin', 'Data', bytes);
    const read = (await service.readFile('blob.bin', 'Data', 'binary')) as ArrayBuffer;
    expect(new Uint8Array(read)).toEqual(new Uint8Array(bytes));
  });

  test('loadSettings persists across service instances (IndexedDB durability)', async () => {
    const settings = await service.loadSettings();
    await service.saveSettings({
      ...settings,
      autoImportFolders: ['/browser-debug-books'],
    });

    const second = new WebAppService();
    await second.init();
    expect((await second.loadSettings()).autoImportFolders).toEqual(['/browser-debug-books']);
  });

  test('acquireLibraryLock returns null (single-window in-memory save chain)', async () => {
    expect(await service.acquireLibraryLock()).toBeNull();
  });

  test('native file path resolution is always null (no host filesystem)', async () => {
    const book = { hash: 'h1', format: 'EPUB' } as unknown as Book;
    expect(await service.resolveNativeBookFilePath(book)).toBeNull();
  });

  test('selectFiles / selectDirectory / openDatabase are explicit no-gos', async () => {
    await expect(service.selectFiles('Import', ['.epub'])).rejects.toThrow(/browser/i);
    await expect(service.selectDirectory('read')).rejects.toThrow(/browser/i);
    await expect(service.openDatabase('statistics', 'statistics.db', 'Data')).rejects.toThrow(
      /browser/i,
    );
  });
});
