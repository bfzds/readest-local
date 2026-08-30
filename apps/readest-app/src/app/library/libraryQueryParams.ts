/**
 * 书库 URL 查询参数的规范化通道（C-1/C-2）。
 *
 * 写导航（Bookshelf.updateUrlParams / page.handleLibraryNavigation）都要先经过
 * `serializeLibraryQuery`：把参数按键排序、统一编码，这样"语义相同但参数顺序
 * 不同"的两条 query 视为一致，避免反复规范化导航；同时为 URL ↔ 书架状态
 * 的比对提供唯一基准（状态始终走 sessionStorage/URL 的单一同步路径）。
 */

export interface LibraryQueryState {
  [key: string]: string | string[] | undefined;
}

/** 把 `search`（不带 `?`）解析为稳定的键→多值对象。 */
export function parseLibraryQuery(search: string): LibraryQueryState {
  const state: LibraryQueryState = {};
  for (const [key, value] of new URLSearchParams(search)) {
    const existing = state[key];
    if (existing === undefined) {
      state[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      state[key] = [existing, value];
    }
  }
  return state;
}

/**
 * 规范化序列化：键按字典序、值保持编码一致（空值保留，供 Next 16.2 的
 * 空 `group=` workaround），从而"顺序不同但语义相同"的 query 得到同一字符串。
 */
export function serializeLibraryQuery(search: string): string {
  const params = new URLSearchParams(search);
  const pairs: Array<[string, string]> = [];
  for (const key of Array.from(params.keys()).sort()) {
    for (const value of params.getAll(key)) {
      pairs.push([key, value]);
    }
  }
  return pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/** 语义等价比较：顺序无关、编码无关。 */
export function sameLibraryQuery(a: string, b: string): boolean {
  return serializeLibraryQuery(a) === serializeLibraryQuery(b);
}
