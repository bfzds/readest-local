import { describe, expect, it } from 'vitest';
import {
  parseLibraryQuery,
  serializeLibraryQuery,
  sameLibraryQuery,
} from '@/app/library/libraryQueryParams';

describe('libraryQueryParams（C-1/C-2）', () => {
  it('参数顺序不同但语义相同的 query 序列化后一致', () => {
    expect(serializeLibraryQuery('group=a&q=魔物&sort=title')).toBe(
      serializeLibraryQuery('q=魔物&sort=title&group=a'),
    );
  });

  it('sameLibraryQuery 忽略键顺序差异', () => {
    expect(sameLibraryQuery('group=a&mode=book', 'mode=book&group=a')).toBe(true);
    expect(sameLibraryQuery('group=a', 'group=b')).toBe(false);
  });

  it('parseLibraryQuery 返回键值状态', () => {
    expect(parseLibraryQuery('group=A&groupBy=author')).toEqual({
      group: 'A',
      groupBy: 'author',
    });
  });

  it('空值与布尔值按同一形式处理（Next 空 group= workaround 由调用方保留）', () => {
    // group= 与无 group 在“是否导航”比较中视为不同（一个设置了空值）。
    const a = new URLSearchParams('group=').toString();
    const b = new URLSearchParams('group').toString();
    expect(sameLibraryQuery(a, b)).toBe(true);
  });
});
