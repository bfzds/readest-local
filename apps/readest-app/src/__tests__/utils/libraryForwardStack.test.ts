import { describe, expect, it } from 'vitest';

import { isStaleForwardTarget } from '@/app/library/utils/forwardStack';

// 鼠标侧键"前进"恢复的分组可能已失效（后退后分组被删除）。文件夹分组以
// getGroupName 能否解析为准；虚拟分组（作者/系列/标签/主题）由书目元数据
// 实时推导，条目上始终携带 groupBy 维度，无法也不必静态校验。
describe('isStaleForwardTarget', () => {
  const getGroupName = (id: string) => (id === 'deleted-folder' ? undefined : `path/${id}`);

  it('flags a folder group that no longer resolves', () => {
    expect(isStaleForwardTarget({ group: 'deleted-folder' }, getGroupName)).toBe(true);
  });

  it('accepts a folder group that still resolves', () => {
    expect(isStaleForwardTarget({ group: 'live-folder' }, getGroupName)).toBe(false);
  });

  it('passes a virtual-group entry through (carries groupBy, not statically checkable)', () => {
    expect(
      isStaleForwardTarget({ group: 'author-fingerprint', groupBy: 'author' }, getGroupName),
    ).toBe(false);
  });
});
