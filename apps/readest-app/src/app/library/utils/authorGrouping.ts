import { Book } from '@/types/book';
import { BOOK_UNGROUPED_NAME } from '@/services/constants';

/**
 * 导入时按作者自动归组的纯逻辑。匹配发生在 ingestFile 之后：书解析出的
 * `book.author` 与书库中现存分组名做规范化等值比较（大小写/空白不敏感），
 * 匹配不上就不动书——宁可留在根目录，也不猜错塞组。
 */

export interface AuthorGroupedImport {
  hash: string;
  title: string;
  groupId: string;
  groupName: string;
}

/** 规范化比较键：去首尾空白、折叠连续空白、小写化。 */
export const normalizeAuthorKey = (value: string): string =>
  value.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * 从书库快照收集现存分组名（含嵌套路径的各级祖先前缀）。
 * `persistentNames` 补充用户手动创建的空组——它们没有书，书籍派生看不到。
 */
export const collectGroupNames = (books: Book[], persistentNames: string[] = []): string[] => {
  const names = new Set<string>();
  const addPath = (name: string) => {
    if (!name || name === BOOK_UNGROUPED_NAME) return;
    names.add(name);
    let slashIndex = name.indexOf('/');
    while (slashIndex > 0) {
      names.add(name.slice(0, slashIndex));
      slashIndex = name.indexOf('/', slashIndex + 1);
    }
  };
  for (const book of books) {
    if (!book.deletedAt && book.groupName) addPath(book.groupName);
  }
  for (const name of persistentNames) addPath(name);
  return [...names];
};

/**
 * 找到与作者名匹配的分组名；无匹配返回 null。
 * 多个分组同名匹配时取最短的（优先顶层分组而非嵌套路径），同级再按字典序，
 * 保证结果确定。
 */
export const findAuthorGroupMatch = (author: string, groupNames: string[]): string | null => {
  const key = normalizeAuthorKey(author);
  if (!key) return null;
  const candidates = groupNames
    .filter((name) => normalizeAuthorKey(name) === key)
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return candidates[0] ?? null;
};

export interface AuthorGroupedToastSpec {
  /** 基础导入提示（若有的话）加上逐分组的去向行，换行分隔。 */
  message: string;
  /** 本批书归入的分组 id，按首次出现顺序去重。 */
  groupIds: string[];
}

/**
 * 组装带去向的导入 toast 文案。`baseMessage` 是常规导入 toast 的文案
 * （计数行），可能为空（silent 导入且保存失败时不弹 toast 的场景由调用方
 * 过滤，传空串则只输出去向行）。`formatLine` 由调用方注入（i18n + 书名
 * 列表格式化都留在组件层），返回单个分组的去向行文案。
 */
export const buildAuthorGroupedToastSpec = (
  baseMessage: string,
  grouped: AuthorGroupedImport[],
  formatLine: (group: string, titles: string[]) => string,
): AuthorGroupedToastSpec => {
  const titlesByGroup = new Map<string, string[]>();
  const groupIdByName = new Map<string, string>();
  for (const entry of grouped) {
    const titles = titlesByGroup.get(entry.groupName) ?? [];
    if (!titles.includes(entry.title)) titles.push(entry.title);
    titlesByGroup.set(entry.groupName, titles);
    if (!groupIdByName.has(entry.groupName)) groupIdByName.set(entry.groupName, entry.groupId);
  }
  const groupedMessage = [...titlesByGroup.entries()]
    .map(([group, titles]) => formatLine(group, titles))
    .join('\n');
  return {
    message: baseMessage ? `${baseMessage}\n${groupedMessage}` : groupedMessage,
    groupIds: [...new Set(groupIdByName.values())],
  };
};
