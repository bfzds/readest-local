import type { BookVersionConflictInfo } from '@/types/book';
import { mergeBatchVersionConflicts } from './bookVersionService';

/**
 * 待问的版本冲突队列。**刻意放在模块级、与页面无关**：
 *
 * 攒它的路径可能紧接着就把书库页卸载掉。双击/「打开方式」是最典型的——入库
 * 成功后立刻 `router.replace('/reader…')` 去阅读器，于是
 *   1. 书库页在初始化导航在途时会 `return` 一个空白占位，页面自己的 `<Toast />`
 *      根本不在树里，通知 dispatch 了也没人渲染；
 *   2. 导航让书库页卸载，组件内的 ref 与 focus 兜底一起消失。
 * 队列若留在页面里，用户既看不到、点不到，也没有"回到书库再问"——净效果就是
 * 静默丢弃。放进模块后，回到书库页（重新挂载）时接着问。
 *
 * 不落 localStorage：条目引用的是记录的完整对象（含 metadata），而替换或删除会
 * 让快照过期，跨会话恢复必须先按 hash 复核记录是否还在/还是不是原来那条——那是
 * 另一件事，不在本次范围。
 */
export const MAX_PENDING_VERSION_CONFLICTS = 20;

let pending: BookVersionConflictInfo[] = [];
let overflowed = false;

/**
 * 入队，并按 `incoming` 去重。
 *
 * 同一本新书可能被报两次：先完成的文件一旦入库，后完成的那个在导入时刻就看得见
 * 它（同批 4 个文件并发跑，共用同一个 books 数组与索引），于是导入探针与批后
 * 二次探测会各报一次。去重后同一本新书只问一次，候选取并集（见
 * `mergeBatchVersionConflicts`）。
 *
 * 超过上限的部分不排队，只置一个"有冲突没被问过"的标记——用户至少会被告知，
 * 而不是以为书库里那些重复都是自己选的。
 */
export const enqueueVersionConflicts = (conflicts: BookVersionConflictInfo[]): void => {
  if (conflicts.length === 0) return;
  const merged = mergeBatchVersionConflicts(pending, conflicts);
  if (merged.length > MAX_PENDING_VERSION_CONFLICTS) {
    overflowed = true;
    pending = merged.slice(0, MAX_PENDING_VERSION_CONFLICTS);
    return;
  }
  pending = merged;
};

/** 待问条数——通知文案要用，不能顺手把它取走。 */
export const pendingVersionConflictCount = (): number => pending.length;

/**
 * 取走全部待问冲突并清空队列。`overflowed` 表示自上次取走以来有冲突因超过上限
 * 没进队列（调用方据此提示一次）。
 */
export const takeVersionConflicts = (): {
  conflicts: BookVersionConflictInfo[];
  overflowed: boolean;
} => {
  const conflicts = pending;
  const wasOverflowed = overflowed;
  pending = [];
  overflowed = false;
  return { conflicts, overflowed: wasOverflowed };
};

/** 测试与"整库清空"这类场景用：直接丢弃队列，不弹任何东西。 */
export const clearVersionConflicts = (): void => {
  pending = [];
  overflowed = false;
};
