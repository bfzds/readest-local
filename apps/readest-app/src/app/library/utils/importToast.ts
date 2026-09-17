/**
 * Toast decision for a completed import batch, kept pure so the counting
 * rules (new / already-in-library / revived / failed / save-failed) are
 * unit-testable.
 */
export interface ImportToastSpec {
  type: 'success' | 'info' | 'error';
  message: string;
}

export const resolveImportToast = (counts: {
  newTitles: string[];
  /** 同一个文件重导、命中存活记录——什么都没改。 */
  existingTitles: string[];
  /** 同一个文件重导、复活了一条已删除的记录。 */
  revivedTitles: string[];
  failedCount: number;
  saveFailed: boolean;
  formatList: (titles: string[]) => string;
  t: (key: string, values?: Record<string, unknown>) => string;
}): ImportToastSpec | null => {
  const { newTitles, existingTitles, revivedTitles, failedCount, saveFailed, formatList, t } =
    counts;
  // The save failure already surfaced its own error toast; a success line on
  // top would be misleading (the books would vanish on restart).
  if (saveFailed) return null;
  const newCount = newTitles.length;
  const knownCount = existingTitles.length + revivedTitles.length;
  if (newCount > 0 && knownCount > 0) {
    // Partial result: info (not success) so the "{{existing}} already in
    // library" half is not lost on a green success flash.
    return {
      type: 'info',
      message: t('Successfully imported {{count}} book(s), {{existing}} already in library', {
        count: newCount,
        existing: knownCount,
      }),
    };
  }
  if (newCount > 0) {
    return {
      type: 'success',
      message: t('Successfully imported {{count}} book(s)', { count: newCount }),
    };
  }
  // 一本都没新建：把"认出来了"和"复活了"分开讲——用户需要知道刚才那次拖放到底
  // 做了什么。静默重扫走不到这里（它压根不调这个函数），否则每次扫描都会为同一
  // 批已在库的书弹提示。
  if (revivedTitles.length > 0) {
    return {
      type: 'info',
      message: t('Restored from library: {{titles}}', {
        titles: formatList(revivedTitles),
      }),
    };
  }
  if (existingTitles.length > 0 && failedCount === 0) {
    return {
      type: 'info',
      message: t('Already in library: {{titles}}', {
        titles: formatList(existingTitles),
      }),
    };
  }
  return null;
};
