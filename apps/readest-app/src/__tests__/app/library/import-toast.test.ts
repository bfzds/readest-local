import { describe, test, expect } from 'vitest';
import { resolveImportToast } from '@/app/library/utils/importToast';

const t = (key: string, values?: Record<string, unknown>) =>
  values ? `${key} [${JSON.stringify(values)}]` : key;

const formatList = (titles: string[]) => titles.join('、');

const base = {
  newTitles: [] as string[],
  existingTitles: [] as string[],
  revivedTitles: [] as string[],
  failedCount: 0,
  saveFailed: false,
  formatList,
  t,
};

describe('resolveImportToast', () => {
  test('all-new imports keep the plain success message', () => {
    const spec = resolveImportToast({ ...base, newTitles: ['甲', '乙'] });
    expect(spec).toEqual({
      type: 'success',
      message: 'Successfully imported {{count}} book(s) [{"count":2}]',
    });
  });

  test('mixed batch reports new and already-in-library counts as info', () => {
    // info, not success: the "already in library" half must not read as a
    // plain success when part of the batch never imported.
    const spec = resolveImportToast({
      ...base,
      newTitles: ['甲'],
      existingTitles: ['乙', '丙', '丁'],
    });
    expect(spec?.type).toBe('info');
    expect(spec?.message).toContain('already in library');
    expect(spec?.message).toContain('"existing":3');
  });

  test('revived dead records count toward the "already in library" half', () => {
    const spec = resolveImportToast({
      ...base,
      newTitles: ['甲'],
      revivedTitles: ['乙'],
    });
    expect(spec?.type).toBe('info');
    expect(spec?.message).toContain('"existing":1');
  });

  test('all-duplicates name the books instead of a faceless count', () => {
    const spec = resolveImportToast({ ...base, existingTitles: ['甲', '乙'] });
    expect(spec).toEqual({
      type: 'info',
      message: 'Already in library: {{titles}} [{"titles":"甲、乙"}]',
    });
  });

  // 复活是"做过事"：提示必须和"已存在"分开，否则用户不知道自己刚把删掉的书
  // 拿回来了。
  test('revivals report as Restored from library, not Already in library', () => {
    const spec = resolveImportToast({ ...base, revivedTitles: ['甲'] });
    expect(spec).toEqual({
      type: 'info',
      message: 'Restored from library: {{titles}} [{"titles":"甲"}]',
    });
  });

  test('duplicates alongside failures stay silent (failure toast owns the report)', () => {
    const spec = resolveImportToast({ ...base, existingTitles: ['甲', '乙'], failedCount: 1 });
    expect(spec).toBeNull();
  });

  // 复活不同：它是本批真实发生的改动，失败的提示不该把它吞掉。
  test('revivals are still reported when other files in the batch failed', () => {
    const spec = resolveImportToast({ ...base, revivedTitles: ['甲'], failedCount: 2 });
    expect(spec?.message).toContain('Restored from library');
  });

  test('save failure suppresses any success line', () => {
    const spec = resolveImportToast({ ...base, newTitles: ['甲', '乙', '丙'], saveFailed: true });
    expect(spec).toBeNull();
  });

  test('nothing imported and nothing existed: no toast', () => {
    expect(resolveImportToast(base)).toBeNull();
  });
});
