import { describe, it, expect } from 'vitest';

import { SUPPORTED_BOOK_EXTS } from '@/services/constants';
import {
  DEFAULT_WATCHED_FOLDER_MIN_SIZE_KB,
  findStoredWatchedFolderRule,
  mergeRecordedExtensions,
  normalizeWatchedFolderPath,
  resolveImportBatchFolderRule,
  resolveWatchedFolderRule,
  shouldRecordWatchedFilters,
  withWatchedFolderRule,
  withoutWatchedFolderRule,
} from '@/utils/watchedFolders';
import type { SystemSettings } from '@/types/settings';

type RuleSettings = Pick<SystemSettings, 'autoImportFolderRules' | 'autoImportFlattenFolders'>;

const WATCHED = '/lib/watched';

/**
 * Every folder that was watched before per-folder rules existed has to keep
 * behaving exactly as it did: mirror the structure, scan `SUPPORTED_BOOK_EXTS`
 * with a 20 KB floor. These cases pin that fallback as much as the new map.
 */
describe('resolveWatchedFolderRule', () => {
  it('uses the stored rule when the folder has one', () => {
    const settings: RuleSettings = {
      autoImportFolderRules: {
        [WATCHED]: { mode: 'author', extensions: ['txt'], minSizeKB: 1 },
      },
    };

    expect(resolveWatchedFolderRule(WATCHED, settings)).toEqual({
      mode: 'author',
      extensions: ['txt'],
      minSizeKB: 1,
    });
  });

  it('falls back to the legacy flatten array', () => {
    const settings: RuleSettings = {
      autoImportFlattenFolders: [WATCHED],
    };

    expect(resolveWatchedFolderRule(WATCHED, settings)).toEqual({
      mode: 'flat',
      extensions: [...SUPPORTED_BOOK_EXTS],
      minSizeKB: DEFAULT_WATCHED_FOLDER_MIN_SIZE_KB,
    });
  });

  it('defaults a folder that appears in neither list to mirror plus the dialog defaults', () => {
    expect(resolveWatchedFolderRule(WATCHED, {})).toEqual({
      mode: 'mirror',
      extensions: [...SUPPORTED_BOOK_EXTS],
      minSizeKB: 20,
    });
  });

  it('prefers the rules map over a stale flatten entry', () => {
    const settings: RuleSettings = {
      autoImportFolderRules: { [WATCHED]: { mode: 'mirror' } },
      autoImportFlattenFolders: [WATCHED],
    };

    expect(resolveWatchedFolderRule(WATCHED, settings).mode).toBe('mirror');
  });

  it('matches a stored key regardless of separators and trailing slashes', () => {
    const settings: RuleSettings = {
      autoImportFolderRules: { 'C:\\Library\\Pixiv\\': { mode: 'author' } },
    };

    expect(resolveWatchedFolderRule('C:\\Library\\Pixiv', settings).mode).toBe('author');
    expect(resolveWatchedFolderRule('C:/Library/Pixiv/', settings).mode).toBe('author');
  });

  it('matches a legacy flatten entry the same way', () => {
    const settings: RuleSettings = { autoImportFlattenFolders: ['C:\\Library\\Books\\'] };

    expect(resolveWatchedFolderRule('C:/Library/Books', settings).mode).toBe('flat');
  });

  it('does not match folders that merely share a prefix', () => {
    const settings: RuleSettings = {
      autoImportFolderRules: { '/lib/watched': { mode: 'author' } },
    };

    expect(resolveWatchedFolderRule('/lib/watched-deeper', settings).mode).toBe('mirror');
  });

  it('treats a garbage mode as mirror instead of propagating it', () => {
    const settings = {
      autoImportFolderRules: { [WATCHED]: { mode: 'nonsense' } },
    } as unknown as RuleSettings;

    expect(resolveWatchedFolderRule(WATCHED, settings).mode).toBe('mirror');
  });

  it('fills in defaults for an empty extension list and a nonsensical size', () => {
    const empty = resolveWatchedFolderRule(WATCHED, {
      autoImportFolderRules: { [WATCHED]: { mode: 'author', extensions: [], minSizeKB: -3 } },
    });
    expect(empty.extensions).toEqual([...SUPPORTED_BOOK_EXTS]);
    expect(empty.minSizeKB).toBe(DEFAULT_WATCHED_FOLDER_MIN_SIZE_KB);

    const nan = resolveWatchedFolderRule(WATCHED, {
      autoImportFolderRules: {
        [WATCHED]: { mode: 'author', minSizeKB: Number.NaN },
      },
    });
    expect(nan.minSizeKB).toBe(DEFAULT_WATCHED_FOLDER_MIN_SIZE_KB);
  });

  it('keeps an explicit zero size threshold, which means "no floor"', () => {
    const settings: RuleSettings = {
      autoImportFolderRules: { [WATCHED]: { mode: 'mirror', minSizeKB: 0 } },
    };

    expect(resolveWatchedFolderRule(WATCHED, settings).minSizeKB).toBe(0);
  });
});

describe('resolveImportBatchFolderRule', () => {
  // 回归用例：对话框里选了「按作者分组」但没勾监控时，规则不会写进设置，
  // 只按设置解析会静默退回 mirror，书会被按完整镜像结构分组。
  it('lets the batch rule win over anything stored', () => {
    const settings: RuleSettings = {
      autoImportFolderRules: { [WATCHED]: { mode: 'mirror', minSizeKB: 30 } },
      autoImportFlattenFolders: [WATCHED],
    };

    expect(resolveImportBatchFolderRule({ mode: 'author' }, WATCHED, settings)).toEqual({
      mode: 'author',
    });
  });

  it('falls back to the stored rule when the batch has none', () => {
    const settings: RuleSettings = { autoImportFlattenFolders: [WATCHED] };

    expect(resolveImportBatchFolderRule(undefined, WATCHED, settings)).toEqual({
      mode: 'flat',
      extensions: [...SUPPORTED_BOOK_EXTS],
      minSizeKB: DEFAULT_WATCHED_FOLDER_MIN_SIZE_KB,
    });
  });
});

/**
 * 老监控目录（每目录规则出现之前就在监控）没有存量规则，解析出来的是完整的
 * `SUPPORTED_BOOK_EXTS`——一个对话框复选框（按格式组工作）表达不了的列表，
 * 里面带着 `md` 这类没有组归属的扩展名。选择没改动时原样写回会把 `md` 静默
 * 丢掉，所以「完全等于解析值」必须不回写。
 */
describe('shouldRecordWatchedFilters', () => {
  const base = {
    hasStoredRule: false,
    resolvedGroupIds: ['epub', 'pdf'],
    resolvedMinSizeKB: 20,
    selectionGroupIds: ['epub', 'pdf'],
    selectionMinSizeKB: 20,
  };

  it('该目录有存量规则时一律回写（不再做等值比较）', () => {
    // 无论选择与解析值是否相同，只要有规则可更新就记录。
    expect(shouldRecordWatchedFilters({ ...base, hasStoredRule: true })).toBe(true);
    expect(
      shouldRecordWatchedFilters({
        ...base,
        hasStoredRule: true,
        selectionGroupIds: ['epub'],
        selectionMinSizeKB: 50,
      }),
    ).toBe(true);
  });

  it('无存量规则 + 选择与解析值完全相同 → 不回写（保住 md 等组外扩展名）', () => {
    expect(shouldRecordWatchedFilters(base)).toBe(false);
  });

  it('无存量规则 + 格式组集合不同 → 回写', () => {
    expect(shouldRecordWatchedFilters({ ...base, selectionGroupIds: ['epub'] })).toBe(true);
  });

  it('无存量规则 + 只有 minSizeKB 不同 → 回写', () => {
    expect(shouldRecordWatchedFilters({ ...base, selectionMinSizeKB: 50 })).toBe(true);
  });

  it('格式组顺序不同但内容相同 → 不回写（比较前做了排序）', () => {
    expect(shouldRecordWatchedFilters({ ...base, selectionGroupIds: ['pdf', 'epub'] })).toBe(false);
  });

  it('空集合 vs 空集合 + 相同体积 → 不回写（边界）', () => {
    expect(
      shouldRecordWatchedFilters({ ...base, resolvedGroupIds: [], selectionGroupIds: [] }),
    ).toBe(false);
  });
});

describe('mergeRecordedExtensions', () => {
  // The dialog's checkboxes work in format groups, and no group carries `md`
  // (the supported list does: see `SUPPORTED_BOOK_EXTS`). Writing a confirmed
  // selection back into a rule is therefore only lossless if the extensions the
  // dialog cannot express are carried over.
  const GROUPS = ['epub', 'pdf', 'mobi', 'azw', 'azw3', 'fb2', 'cbz', 'zip', 'txt'];

  it('carries over an extension no format group can express', () => {
    expect(
      mergeRecordedExtensions({
        selectionExtensions: ['epub', 'pdf'],
        resolvedExtensions: [...GROUPS, 'md'],
        groupExtensions: GROUPS,
      }),
    ).toEqual(['epub', 'pdf', 'md']);
  });

  it('drops a group extension the user unticked', () => {
    // `mobi` is expressible through its group, so unticking that group must not
    // let the carry-over bring it back.
    expect(
      mergeRecordedExtensions({
        selectionExtensions: ['epub'],
        resolvedExtensions: ['epub', 'mobi', 'azw', 'azw3', 'md'],
        groupExtensions: GROUPS,
      }),
    ).toEqual(['epub', 'md']);
  });

  it('does not duplicate an extension the selection already lists', () => {
    expect(
      mergeRecordedExtensions({
        selectionExtensions: ['epub', 'md'],
        resolvedExtensions: ['epub', 'md'],
        groupExtensions: GROUPS,
      }),
    ).toEqual(['epub', 'md']);
  });

  it('is a no-op when the folder scans only group extensions', () => {
    expect(
      mergeRecordedExtensions({
        selectionExtensions: ['epub', 'pdf'],
        resolvedExtensions: ['epub', 'pdf'],
        groupExtensions: GROUPS,
      }),
    ).toEqual(['epub', 'pdf']);
  });

  it('matches the carry-over case-insensitively', () => {
    expect(
      mergeRecordedExtensions({
        selectionExtensions: ['EPUB'],
        resolvedExtensions: ['epub', 'MD'],
        groupExtensions: ['epub'],
      }),
    ).toEqual(['EPUB', 'MD']);
  });
});

describe('watched folder rule helpers', () => {
  it('normalizes separators and trailing slashes only', () => {
    expect(normalizeWatchedFolderPath('C:\\Library\\Books\\')).toBe('C:/Library/Books');
    expect(normalizeWatchedFolderPath('/lib/watched//')).toBe('/lib/watched');
    // No case folding: entries are matched verbatim everywhere else in the app.
    expect(normalizeWatchedFolderPath('/Lib/Watched')).toBe('/Lib/Watched');
  });

  it('replaces an existing rule instead of appending a duplicate key', () => {
    const next = withWatchedFolderRule(
      { 'C:\\Library\\Pixiv': { mode: 'mirror' } },
      'C:/Library/Pixiv',
      { mode: 'author' },
    );

    expect(Object.keys(next)).toEqual(['C:\\Library\\Pixiv']);
    expect(next['C:\\Library\\Pixiv']).toEqual({ mode: 'author' });
  });

  it('drops a rule by normalized path', () => {
    const next = withoutWatchedFolderRule(
      { 'C:\\Library\\Pixiv': { mode: 'author' }, '/lib/other': { mode: 'flat' } },
      'C:/Library/Pixiv/',
    );

    expect(Object.keys(next)).toEqual(['/lib/other']);
  });

  it('reads back a stored rule by normalized path', () => {
    const rules = { '/lib/watched': { mode: 'author' as const, minSizeKB: 5 } };

    expect(findStoredWatchedFolderRule('/lib/watched/', { autoImportFolderRules: rules })).toEqual({
      mode: 'author',
      minSizeKB: 5,
    });
    expect(findStoredWatchedFolderRule('/lib/other', { autoImportFolderRules: rules })).toBe(
      undefined,
    );
  });
});
