import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

let mockHasCli = false;

vi.mock('@/services/environment', () => ({
  hasCli: () => mockHasCli,
}));

const mockGetMatches = vi.fn();
vi.mock('@tauri-apps/plugin-cli', () => ({
  getMatches: () => mockGetMatches(),
}));

import { parseOpenWithFiles } from '@/helpers/openWith';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mockHasCli = false;
  delete window.OPEN_WITH_FILES;
  Object.defineProperty(window, 'location', {
    value: { ...window.location, search: '' },
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseOpenWithFiles', () => {
  describe('window URL params', () => {
    test('parses file params from URL search', async () => {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?file=book1.epub&file=book2.epub' },
        writable: true,
      });

      const result = await parseOpenWithFiles();

      expect(result).toEqual(['book1.epub', 'book2.epub']);
    });

    test('uses window.OPEN_WITH_FILES when no URL params', async () => {
      window.OPEN_WITH_FILES = ['/path/to/book.epub'];

      const result = await parseOpenWithFiles();

      expect(result).toEqual(['/path/to/book.epub']);
    });

    test('prefers URL params over OPEN_WITH_FILES', async () => {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?file=url-book.epub' },
        writable: true,
      });
      window.OPEN_WITH_FILES = ['/path/to/window-book.epub'];

      const result = await parseOpenWithFiles();

      expect(result).toEqual(['url-book.epub']);
    });
  });

  describe('CLI arguments', () => {
    test('parses files from CLI matches', async () => {
      mockHasCli = true;
      mockGetMatches.mockResolvedValue({
        args: {
          file1: { value: '/path/file1.epub', occurrences: 1 },
          file2: { value: '/path/file2.epub', occurrences: 1 },
          file3: { value: '', occurrences: 0 },
          file4: { value: '', occurrences: 0 },
        },
      });

      const result = await parseOpenWithFiles();

      expect(result).toEqual(['/path/file1.epub', '/path/file2.epub']);
    });

    test('returns empty array when CLI has no file args', async () => {
      mockHasCli = true;
      mockGetMatches.mockResolvedValue({
        args: {
          file1: { value: '', occurrences: 0 },
          file2: { value: '', occurrences: 0 },
          file3: { value: '', occurrences: 0 },
          file4: { value: '', occurrences: 0 },
        },
      });

      const result = await parseOpenWithFiles();

      expect(result).toEqual([]);
    });

    test('skips CLI parsing when hasCli is false', async () => {
      mockHasCli = false;

      const result = await parseOpenWithFiles();

      expect(mockGetMatches).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    test('handles null args from CLI', async () => {
      mockHasCli = true;
      mockGetMatches.mockResolvedValue({ args: null });

      const result = await parseOpenWithFiles();

      expect(result).toEqual([]);
    });

    test('degrades to empty files when CLI arg parsing rejects', async () => {
      mockHasCli = true;
      mockGetMatches.mockRejectedValue(
        new Error("failed to parse arguments: error: unexpected argument '--flag' found"),
      );

      const result = await parseOpenWithFiles();

      expect(result).toEqual([]);
    });
  });

  describe('fallthrough logic', () => {
    test('uses window params first and skips CLI', async () => {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, search: '?file=from-url.epub' },
        writable: true,
      });
      mockHasCli = true;

      const result = await parseOpenWithFiles();

      expect(result).toEqual(['from-url.epub']);
      expect(mockGetMatches).not.toHaveBeenCalled();
    });

    test('falls through from empty window params to CLI', async () => {
      mockHasCli = true;
      mockGetMatches.mockResolvedValue({
        args: {
          file1: { value: '/cli-file.epub', occurrences: 1 },
          file2: { value: '', occurrences: 0 },
          file3: { value: '', occurrences: 0 },
          file4: { value: '', occurrences: 0 },
        },
      });

      const result = await parseOpenWithFiles();

      expect(result).toEqual(['/cli-file.epub']);
    });
  });
});
