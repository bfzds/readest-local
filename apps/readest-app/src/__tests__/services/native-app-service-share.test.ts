import { describe, test, expect, vi, beforeEach } from 'vitest';

// 本文件每个用例都要 vi.resetModules + 动态 import 重建整个 NativeAppService
// （loadServiceWithOS），模块依赖链被整条重新加载，真实工作量大，用例耗时天然
// 贴近 vitest 默认 5s 超时；并行全量跑时的调度抖动会让个别用例偶发越过 5s
// （同 HEAD 有绿有红、单跑必绿、与本分支无关）——这是抖动，不是回归信号。
// 放宽到 15s 而非更大：足以吸收并行抖动，同时仍能在实现真的挂起或显著变慢
// （数量级劣化）时及时失败，不至于把真回归拖到 CI 全局超时才暴露。
vi.setConfig({ testTimeout: 15_000 });

const osTypeMock = vi.fn().mockReturnValue('macos');
const writeTextFileMock = vi.fn().mockResolvedValue(undefined);
const writeFileMock = vi.fn().mockResolvedValue(undefined);
const mkdirMock = vi.fn().mockResolvedValue(undefined);
const saveDialogMock = vi.fn().mockResolvedValue('/tmp/exported.md');

vi.mock('@tauri-apps/plugin-os', () => ({
  type: () => osTypeMock(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn().mockResolvedValue(false),
  mkdir: (...args: unknown[]) => mkdirMock(...args),
  readTextFile: vi.fn().mockResolvedValue(''),
  readFile: vi.fn().mockResolvedValue(new Uint8Array()),
  writeTextFile: (...args: unknown[]) => writeTextFileMock(...args),
  writeFile: (...args: unknown[]) => writeFileMock(...args),
  readDir: vi.fn().mockResolvedValue([]),
  remove: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: 0 }),
  BaseDirectory: {},
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn().mockResolvedValue(null),
  save: (...args: unknown[]) => saveDialogMock(...args),
  ask: vi.fn().mockResolvedValue(true),
}));

vi.mock('@tauri-apps/api/path', () => ({
  join: (...parts: string[]) => Promise.resolve(parts.join('/')),
  basename: (p: string) => Promise.resolve(p.split('/').pop() ?? p),
  appDataDir: () => Promise.resolve('/tmp/app-data'),
  appConfigDir: () => Promise.resolve('/tmp/app-config'),
  appCacheDir: () => Promise.resolve('/tmp/app-cache'),
  appLogDir: () => Promise.resolve('/tmp/app-log'),
  tempDir: () => Promise.resolve('/tmp'),
}));

vi.mock('@/utils/bridge', () => ({
  copyURIToPath: vi.fn().mockResolvedValue({ path: '' }),
  getStorefrontRegionCode: vi.fn().mockResolvedValue({ regionCode: null }),
  hasAmbientLightSensor: vi.fn().mockResolvedValue({ available: false }),
}));

vi.mock('@/utils/file', () => ({
  NativeFile: class {},
  RemoteFile: class {},
}));

vi.mock('@/utils/files', () => ({
  copyFiles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/settingsService', () => ({
  getDefaultViewSettings: vi.fn().mockReturnValue({}),
  loadSettings: vi.fn().mockResolvedValue({ migrationVersion: 99999999 }),
  saveSettings: vi.fn().mockResolvedValue(undefined),
}));

async function loadServiceWithOS(os: 'macos' | 'windows' | 'linux' | 'ios' | 'android') {
  osTypeMock.mockReturnValue(os);
  vi.resetModules();
  const mod = await import('@/services/nativeAppService');
  return new mod.NativeAppService();
}

describe('NativeAppService.saveFile local export', () => {
  beforeEach(() => {
    writeTextFileMock.mockClear();
    writeFileMock.mockClear();
    mkdirMock.mockClear();
    saveDialogMock.mockClear();
  });

  test('always uses the save dialog even when share=true', async () => {
    const service = await loadServiceWithOS('macos');
    await service.saveFile('notes.md', 'hello', { share: true, mimeType: 'text/markdown' });
    expect(saveDialogMock).toHaveBeenCalledTimes(1);
    expect(writeTextFileMock).toHaveBeenCalledWith('/tmp/exported.md', 'hello');
  });

  test('uses the save dialog on every desktop and mobile platform', async () => {
    for (const os of ['windows', 'linux', 'ios', 'android'] as const) {
      saveDialogMock.mockClear();
      const service = await loadServiceWithOS(os);
      await service.saveFile('notes.md', 'hello', { share: true });
      expect(saveDialogMock).toHaveBeenCalledTimes(1);
    }
  });

  test('writes binary content to the chosen path', async () => {
    const service = await loadServiceWithOS('windows');
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    await service.saveFile('image.png', bytes, { share: true, mimeType: 'image/png' });
    expect(saveDialogMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock).toHaveBeenCalledWith('/tmp/exported.md', expect.any(Uint8Array));
  });

  test('ignores filePath when share=true and saves through the dialog', async () => {
    const service = await loadServiceWithOS('macos');
    await service.saveFile('book.epub', null, {
      share: true,
      mimeType: 'application/epub+zip',
      filePath: '/abs/path/book.epub',
    });
    expect(saveDialogMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(writeTextFileMock).not.toHaveBeenCalled();
  });
});
