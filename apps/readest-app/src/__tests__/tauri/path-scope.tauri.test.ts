// S-1/S-2 regression: every parser command must enforce fs scope.
// The webdriver capability only allows `**/__tests__/**` in scope, so
// fixtures are readable while e.g. package.json (repo root) is rejected.
import { describe, it, expect } from 'vitest';
import { invoke } from './tauri-invoke';

const CWD = process.env['CWD'] as string;

const COMMANDS = [
  'parse_epub_metadata',
  'parse_epub_full',
  'extract_epub_cover_full',
  'parse_mobi_metadata',
  'extract_mobi_cover_full',
] as const;

describe('path scope S-1 S-2', () => {
  it('rejects empty path', async () => {
    for (const command of COMMANDS) {
      await expect(invoke(command, { filePath: '' })).rejects.toThrow();
    }
  });

  it('rejects a directory', async () => {
    for (const command of COMMANDS) {
      await expect(invoke(command, { filePath: `${CWD}/src` })).rejects.toThrow();
    }
  });

  it('rejects an existing file outside the scope', async () => {
    for (const command of COMMANDS) {
      await expect(invoke(command, { filePath: `${CWD}/package.json` })).rejects.toThrow();
    }
  });

  it('rejects a nonexistent path', async () => {
    await expect(
      invoke('parse_epub_metadata', { filePath: `${CWD}/no-such-file.epub` }),
    ).rejects.toThrow();
  });

  it('accepts an epub fixture inside the test scope', async () => {
    const rust = (await invoke('parse_epub_metadata', {
      filePath: `${CWD}/src/__tests__/fixtures/data/repro-3683.epub`,
    })) as { partialMd5: string; opfPath: string };
    expect(rust.partialMd5).toMatch(/^[0-9a-f]{32}$/);
    expect(rust.opfPath).toBeTruthy();
  });

  it('parse_epub_full works on an allowed fixture', async () => {
    const rust = (await invoke('parse_epub_full', {
      filePath: `${CWD}/src/__tests__/fixtures/data/repro-3683.epub`,
    })) as { partialMd5: string; sizes: Record<string, number> };
    expect(rust.partialMd5).toMatch(/^[0-9a-f]{32}$/);
    expect(Object.keys(rust.sizes).length).toBeGreaterThan(0);
  });
});
