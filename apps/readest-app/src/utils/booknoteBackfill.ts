import type { BookNote } from '@/types/book';

/**
 * 把回填出的 page 值合并进*当前*书签列表，只对仍缺少 page 的标注补值。
 *
 * 回填流程可能横跨数秒到数十秒（5s 宽限 + 每标注 250ms 节拍）；期间用户
 * 可能新增、编辑、删除标注。因此：
 *   - 以 `current`（每批写入前从 store 重新读取）为准，而不是挂载快照；
 *   - 只按 id 补 `page`，不动其它字段 —— 用户编辑/新增的内容原样保留；
 *   - 已带 page、已删除（deletedAt）的标注一律不覆盖、不复活。
 */
export function applyBackfilledPages(
  current: BookNote[],
  filledById: ReadonlyMap<string, number>,
): BookNote[] {
  if (filledById.size === 0) return current;
  let changed = false;
  const merged = current.map((note) => {
    if (note.page != null || note.deletedAt || filledById.has(note.id) === false) {
      return note;
    }
    const page = filledById.get(note.id);
    if (page == null) return note;
    changed = true;
    return { ...note, page };
  });
  return changed ? merged : current;
}
