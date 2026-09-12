// 鼠标侧键"前进"恢复的分组可能已失效（后退之后分组被删除）。文件夹分组以
// getGroupName 能否解析为准；虚拟分组（作者/系列/标签/主题）由书目元数据
// 实时推导，无法静态校验——此类条目在入栈时始终携带 groupBy 维度，据此放行。
export interface LibraryForwardStackEntry {
  group: string;
  groupBy?: string;
  from?: string;
}

export const isStaleForwardTarget = (
  entry: LibraryForwardStackEntry,
  getGroupName: (id: string) => string | undefined,
): boolean => !entry.groupBy && !getGroupName(entry.group);
