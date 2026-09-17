import { beforeEach, describe, expect, it } from 'vitest';
import type { Book, BookVersionConflictInfo } from '@/types/book';
import {
  MAX_PENDING_VERSION_CONFLICTS,
  clearVersionConflicts,
  enqueueVersionConflicts,
  pendingVersionConflictCount,
  takeVersionConflicts,
} from '@/services/versionConflictQueue';

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
    clearVersionConflicts();
  });

  it('returns what was enqueued and empties itself', () => {
    enqueueVersionConflicts([conflict('n1', ['o1']), conflict('n2', ['o2'])]);
    expect(pendingVersionConflictCount()).toBe(2);

    const { conflicts, overflowed } = takeVersionConflicts();

    expect(conflicts.map((c) => c.incoming.hash)).toEqual(['n1', 'n2']);
    expect(overflowed).toBe(false);
    expect(pendingVersionConflictCount()).toBe(0);
    expect(takeVersionConflicts().conflicts).toEqual([]);
  });

  it('counting does not consume the queue', () => {
    enqueueVersionConflicts([conflict('n1', ['o1'])]);
    expect(pendingVersionConflictCount()).toBe(1);
    expect(pendingVersionConflictCount()).toBe(1);
  });

  // 同一本新书只问一次——导入时刻的探针与批后二次探测会各报一次（先完成的
  // 文件一旦入库，后完成的那个就看得见它）。去重与候选取并集都在这里发生。
  it('collapses repeated reports about the same incoming record', () => {
    enqueueVersionConflicts([conflict('n2', ['o1'])]);
    enqueueVersionConflicts([conflict('n2', ['n1'])]);

    const { conflicts } = takeVersionConflicts();

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.candidates.map((b) => b.hash).sort()).toEqual(['n1', 'o1']);
  });

  // 上限只为了让一次弹窗可读；被丢掉的必须留下"有冲突没被问过"的标记，否则
  // 用户会以为书库里那些重复都是自己选的。
  it('caps the queue and reports the overflow once', () => {
    for (let i = 0; i < MAX_PENDING_VERSION_CONFLICTS + 3; i += 1) {
      enqueueVersionConflicts([conflict(`n${i}`, ['o1'])]);
    }

    const first = takeVersionConflicts();
    expect(first.conflicts).toHaveLength(MAX_PENDING_VERSION_CONFLICTS);
    expect(first.overflowed).toBe(true);
    // 提示过一次就复位，别在下一轮凭空再报。
    expect(takeVersionConflicts().overflowed).toBe(false);
  });

  it('ignores an empty batch', () => {
    enqueueVersionConflicts([]);
    expect(pendingVersionConflictCount()).toBe(0);
  });
});
