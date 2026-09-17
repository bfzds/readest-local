import { Book } from '@/types/book';
import { matchesOwnGroupAuthor } from './authorGrouping';

/**
 * 顶层导入的去重落点决策（issue #3）。去重命中（byHash / in-place 快路径）
 * 返回的书会原样携带旧记录的 groupId/groupName——"顶层拖入却落进分组"。
 * 用户主动拖到顶层的意图应优先于旧分组，但有两个例外方向：
 * - 书所在的组恰好是其作者匹配组：书"本就在家"，保留分组并走既有去向反馈；
 * - 静默重扫（watched-folder auto import）：绝不动分组，否则每次重扫都会
 *   把手动分组的书拽回顶层。
 */

export interface DemoteDedupHitContext {
  /** runImportBooks 以顶层推导模式调用（groupId 参数 === undefined）。 */
  topLevelImport: boolean;
  /** 本次文件没有从目录结构推导出分组（否则目录结构意图优先）。 */
  noFolderDerivedGroup: boolean;
  /** 用户主动发起的导入（非 silent 自动重扫）。 */
  userInitiated: boolean;
  /** 去重命中：byHash 命中（knownHashes）或 in-place 快路径返回既有条目。 */
  dedupHit: boolean;
}

export const shouldDemoteDedupHitToRoot = (book: Book, ctx: DemoteDedupHitContext): boolean =>
  ctx.topLevelImport &&
  ctx.noFolderDerivedGroup &&
  ctx.userInitiated &&
  ctx.dedupHit &&
  !!book.groupId &&
  !matchesOwnGroupAuthor(book);

/**
 * 降组回顶层并盖双时钟：updatedAt 防 LWW 回退，metadataUpdatedAt 防多端
 * 同步时旧元数据编辑把分组改动冲掉（同 #5438 的处理方式）。
 */
export const demoteBookToRoot = (book: Book, now = Date.now()): void => {
  book.groupId = '';
  book.groupName = undefined;
  book.updatedAt = now;
  book.metadataUpdatedAt = now;
};
