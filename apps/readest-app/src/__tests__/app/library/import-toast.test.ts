import { describe, test, expect } from 'vitest';
import { resolveImportToast } from '@/app/library/utils/importToast';

const t = (key: string, values?: Record<string, unknown>) =>
  values ? `${key} [${JSON.stringify(values)}]` : key;

describe('resolveImportToast', () => {
  test('all-new imports keep the plain success message', () => {
    const spec = resolveImportToast({
      newCount: 2,
      existingCount: 0,
      failedCount: 0,
      saveFailed: false,
      t,
    });
    expect(spec).toEqual({
      type: 'success',
      message: 'Successfully imported {{count}} book(s) [{"count":2}]',
    });
  });

  test('mixed batch reports new and already-in-library counts as info', () => {
    const spec = resolveImportToast({
      newCount: 1,
      existingCount: 3,
      failedCount: 0,
      saveFailed: false,
      t,
    });
    // info, not success: the "already in library" half must not read as a
    // plain success when part of the batch never imported.
    expect(spec?.type).toBe('info');
    expect(spec?.message).toContain('already in library');
  });

  test('all-duplicates report Already in library as info', () => {
    const spec = resolveImportToast({
      newCount: 0,
      existingCount: 2,
      failedCount: 0,
      saveFailed: false,
      t,
    });
    expect(spec).toEqual({ type: 'info', message: 'Already in library' });
  });

  test('duplicates alongside failures stay silent (failure toast owns the report)', () => {
    const spec = resolveImportToast({
      newCount: 0,
      existingCount: 2,
      failedCount: 1,
      saveFailed: false,
      t,
    });
    expect(spec).toBeNull();
  });

  test('save failure suppresses any success line', () => {
    const spec = resolveImportToast({
      newCount: 3,
      existingCount: 0,
      failedCount: 0,
      saveFailed: true,
      t,
    });
    expect(spec).toBeNull();
  });

  test('nothing imported and nothing existed: no toast', () => {
    const spec = resolveImportToast({
      newCount: 0,
      existingCount: 0,
      failedCount: 0,
      saveFailed: false,
      t,
    });
    expect(spec).toBeNull();
  });
});
