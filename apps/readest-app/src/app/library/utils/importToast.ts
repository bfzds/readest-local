/**
 * Toast decision for a completed import batch, kept pure so the counting
 * rules (new / already-in-library / failed / save-failed) are unit-testable.
 */
export interface ImportToastSpec {
  type: 'success' | 'info' | 'error';
  message: string;
}

export const resolveImportToast = (counts: {
  newCount: number;
  existingCount: number;
  failedCount: number;
  saveFailed: boolean;
  t: (key: string, values?: Record<string, unknown>) => string;
}): ImportToastSpec | null => {
  const { newCount, existingCount, failedCount, saveFailed, t } = counts;
  // The save failure already surfaced its own error toast; a success line on
  // top would be misleading (the books would vanish on restart).
  if (saveFailed) return null;
  if (newCount > 0 && existingCount > 0) {
    // Partial result: info (not success) so the "{{existing}} already in
    // library" half is not lost on a green success flash.
    return {
      type: 'info',
      message: t('Successfully imported {{count}} book(s), {{existing}} already in library', {
        count: newCount,
        existing: existingCount,
      }),
    };
  }
  if (newCount > 0) {
    return {
      type: 'success',
      message: t('Successfully imported {{count}} book(s)', { count: newCount }),
    };
  }
  // Nothing new landed: only tell the user in the interactive path (silent
  // auto-import re-scans must not toast on every book already in the library).
  if (existingCount > 0 && failedCount === 0) {
    return { type: 'info', message: t('Already in library') };
  }
  return null;
};
