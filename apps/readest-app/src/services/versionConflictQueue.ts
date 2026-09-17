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
 * 只读快照：把待问冲突交给弹窗展示，**不清空队列**。
 *
 * 清空必须等弹窗真正落定（见 `settleVersionConflicts`）。原因是一次真实的竞态：
 * 书库页在"初始化导航在途"结束后会立刻带着 `pendingNavigationBookIds = null`
 * 重跑 drain effect，而紧接着 route.replace 会把这个页面卸载掉——如果取用即清空，
 * 队列就被"正在导航离开的那一页"拿走了，弹窗落在马上要销毁的实例上，用户回到
 * 书库时队列已空，什么都不问。只读快照让这种竞态从根上不可能发生，也覆盖将来
 * 任何"弹窗还开着页面就卸载"的路径（那时队列仍在，下次挂载重新弹）。
 */
export const peekVersionConflicts = (): BookVersionConflictInfo[] => pending;

/**
 * 用户已经回答（确定或取消）`resolved` 这些之后调用：把它们从队列里去掉。
 * 只去掉展示过的那几条——弹窗开着期间新攒进来的冲突留在队列里，等下一次问。
 */
export const settleVersionConflicts = (resolved: BookVersionConflictInfo[]): void => {
  const settled = new Set(resolved.map((conflict) => conflict.incoming.hash));
  pending = pending.filter((conflict) => !settled.has(conflict.incoming.hash));
};

/**
 * 读一次"有冲突因超过上限没进队列"的标记并复位（调用方据此提示一次）。
 * 与快照分开：标记只在真的要弹窗时消费，被守卫拦下时留着下回再说。
 */
export const consumeVersionConflictOverflow = (): boolean => {
  const wasOverflowed = overflowed;
  overflowed = false;
  return wasOverflowed;
};
