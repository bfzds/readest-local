import { describe, expect, it } from 'vitest';
import zhCN from '@/../public/locales/zh-CN/translation.json';
import zhTW from '@/../public/locales/zh-TW/translation.json';
import en from '@/../public/locales/en/translation.json';

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
});
