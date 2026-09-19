import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import zhCN from '@/../public/locales/zh-CN/translation.json';
import zhTW from '@/../public/locales/zh-TW/translation.json';
import en from '@/../public/locales/en/translation.json';

/** 应用根目录：本文件位于 `src/__tests__/i18n/`。 */
const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * 源码里 `_('…')` 字面量的集合。本分支支持的界面语言只有 zh-CN / zh-TW / en
 * （见 `apps/readest-app/docs/i18n.md`），所以中文键集必须覆盖源码用到的每一条
 * ——缺键时 i18next 回落到键原文，中文界面直接显示英文；而 `check:translations`
 * 只查 `__STRING_NOT_TRANSLATED__` 占位符，查不出这种缺口。
 */
const collectSourceKeys = (): Map<string, string> => {
  const keys = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const text = readFileSync(full, 'utf8');
      for (const match of text.matchAll(/_\('((?:[^'\\]|\\.)*)'|_\("((?:[^"\\]|\\.)*)"/g)) {
        const key = (match[1] ?? match[2] ?? '').replace(/\\(['"\\])/g, '$1');
        if (key.trim() && !keys.has(key)) keys.set(key, relative(APP_ROOT, full));
      }
    }
  };
  walk(join(APP_ROOT, 'src'));
  return keys;
};

/** 中文只有 other 一个复数范畴，键存成 `key_other`，所以带 `_N` 变体也算覆盖。 */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const withPluralBases = (keys: string[]): Set<string> => {
  const covered = new Set(keys);
  for (const key of keys) covered.add(key.replace(PLURAL_SUFFIX, ''));
  return covered;
};

/**
 * C-13：locale 缺失防护。zh-TW 与 zh-CN 键集对齐（简体作为基准全集）；
 * en 允许按 key 回退，但关键设置面板键必须有值，否则回退显示出 key 原文。
 */
describe('locale key parity（C-13）', () => {
  it('zh-TW 覆盖全部 zh-CN 键（无缺键回退）', () => {
    const missing = Object.keys(zhCN).filter((key) => !(key in zhTW));
    expect(missing).toEqual([]);
  });

  it('en 覆盖关键设置 UI 键', () => {
    const critical = [
      'Allow JavaScript',
      'Enable only if you trust the file.',
      'TXT Chapter Pattern',
      'Delete Book',
      'Confirm Delete',
      'Edit Book Content',
    ];
    const missing = critical.filter((key) => !(key in en));
    expect(missing).toEqual([]);
  });

  it('zh-CN 覆盖源码里所有 _() 字面量（无缺键回退）', () => {
    const covered = withPluralBases(Object.keys(zhCN));
    const missing = [...collectSourceKeys().entries()]
      .filter(([key]) => !covered.has(key))
      .map(([key, file]) => `${key}  (${file})`);
    expect(missing).toEqual([]);
  });
});
