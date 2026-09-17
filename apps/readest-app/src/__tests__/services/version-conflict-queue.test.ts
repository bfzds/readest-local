import { beforeEach, describe, expect, it } from 'vitest';
import type { Book, BookVersionConflictInfo } from '@/types/book';
import {
  MAX_PENDING_VERSION_CONFLICTS,
  consumeVersionConflictOverflow,
  enqueueVersionConflicts,
  peekVersionConflicts,
  pendingVersionConflictCount,
  settleVersionConflicts,
} from '@/services/versionConflictQueue';

/** 清空队列：把当前待问的全部当作"用户已回答"，走公开 API 而不是后门。 */
const settleAll = () => settleVersionConflicts(peekVersionConflicts());

const makeBook = (hash: string): Book => ({
  hash,
  format: 'EPUB',
  title: 'Test Book',
  author: 'Test Author',
  createdAt: 1,
  updatedAt: 1,
});

const conflict = (incomingHash: string, candidateHashes: string[]): BookVersionConflictInfo => ({
  incoming: makeBook(incomingHash),
  candidates: candidateHashes.map(makeBook),
  reason: 'same-identifier',
});

/**
 * 队列是模块级状态（刻意如此：攒它的路径可能紧跟着卸载书库页），所以每个用例
 * 之间必须清空，不能依赖测试文件的执行顺序。
 */
describe('versionConflictQueue', () => {
  beforeEach(() => {
    settleAll();
  });

  it('peeks what was enqueued without consuming it', () => {
    enqueueVersionConflicts([conflict('n1', ['o1']), conflict('n2', ['o2'])]);
    expect(pendingVersionConflictCount()).toBe(2);

    expect(peekVersionConflicts().map((c) => c.incoming.hash)).toEqual(['n1', 'n2']);
    // 只读：再看一次仍在。清空要等弹窗落定（settle）。
    expect(pendingVersionConflictCount()).toBe(2);
  });

  // 竞态回归：书库页在导航离开前会带着"初始化导航已结束"重跑 drain effect，
  // 若那一次就把队列取空，弹窗会落在马上被卸载的实例上，用户回到书库时队列已空。
  // 只读快照让"取走队列的页面死掉"不可能发生。
  it('survives a page that peeks and then unmounts', () => {
    enqueueVersionConflicts([conflict('n1', ['o1'])]);

    // 第一次展示（页面随即卸载，从没调 settle）
    expect(peekVersionConflicts()).toHaveLength(1);

    // 回到书库页时仍然问得到
    expect(pendingVersionConflictCount()).toBe(1);
    expect(peekVersionConflicts()).toHaveLength(1);
  });

  it('settle removes only the conflicts the user answered', () => {
    enqueueVersionConflicts([conflict('n1', ['o1']), conflict('n2', ['o2'])]);
    const shown = peekVersionConflicts().slice(0, 1);

    // 弹窗开着期间又攒了一条
    enqueueVersionConflicts([conflict('n3', ['o3'])]);
    settleVersionConflicts(shown);

    expect(peekVersionConflicts().map((c) => c.incoming.hash)).toEqual(['n2', 'n3']);
  });

  // 同一本新书只问一次——导入时刻的探针与批后二次探测会各报一次（先完成的
  // 文件一旦入库，后完成的那个就看得见它）。去重与候选取并集都在这里发生。
  it('collapses repeated reports about the same incoming record', () => {
    enqueueVersionConflicts([conflict('n2', ['o1'])]);
    enqueueVersionConflicts([conflict('n2', ['n1'])]);

    const conflicts = peekVersionConflicts();

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.candidates.map((candidate) => candidate.hash).sort()).toEqual([
      'n1',
      'o1',
    ]);
  });

  // 上限只为了让一次弹窗可读；被丢掉的必须留下"有冲突没被问过"的标记，否则
  // 用户会以为书库里那些重复都是自己选的。
  it('caps the queue and reports the overflow once', () => {
    for (let i = 0; i < MAX_PENDING_VERSION_CONFLICTS + 3; i += 1) {
      enqueueVersionConflicts([conflict(`n${i}`, ['o1'])]);
    }

    expect(peekVersionConflicts()).toHaveLength(MAX_PENDING_VERSION_CONFLICTS);
    expect(consumeVersionConflictOverflow()).toBe(true);
    // 提示过一次就复位，别在下一轮凭空再报。
    expect(consumeVersionConflictOverflow()).toBe(false);
  });

  it('ignores an empty batch', () => {
    enqueueVersionConflicts([]);
    expect(pendingVersionConflictCount()).toBe(0);
  });
});
