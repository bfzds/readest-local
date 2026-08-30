import { describe, expect, it, beforeEach, vi } from 'vitest';

import { useLibraryStore } from '@/store/libraryStore';
import { relabelPersistentGroups } from '@/app/library/utils/libraryUtils';
import type { Book } from '@/types/book';
import type { EnvConfigType } from '@/services/environment';

beforeEach(() => {
  useLibraryStore.setState({ library: [], groups: {}, persistentGroupNames: [] });
});

describe('persistent empty groups', () => {
  it('keeps explicitly-created groups across refreshGroups', () => {
    useLibraryStore.getState().addPersistentGroup('帕乌克');
    useLibraryStore.getState().addPersistentGroup('帕乌克/子');
    useLibraryStore.getState().refreshGroups();
    const names = useLibraryStore
      .getState()
      .getGroups()
      .map((g) => g.name);
    expect(names).toContain('帕乌克');
    expect(names).toContain('帕乌克/子');
  });

  it('removes a group and its persisted children, and they stay gone after refresh', () => {
    useLibraryStore.getState().addPersistentGroup('A');
    useLibraryStore.getState().addPersistentGroup('A/B');
    useLibraryStore.getState().addPersistentGroup('C');
    useLibraryStore.getState().removePersistentGroups(['A']);
    let names = useLibraryStore
      .getState()
      .getGroups()
      .map((g) => g.name);
    expect(names).not.toContain('A');
    expect(names).not.toContain('A/B');
    expect(names).toContain('C');

    useLibraryStore.getState().refreshGroups();
    names = useLibraryStore
      .getState()
      .getGroups()
      .map((g) => g.name);
    expect(names).not.toContain('A');
    expect(names).not.toContain('A/B');
  });

  it('relabels a persisted empty group to its new path; the old path stays gone after refresh', () => {
    const state = useLibraryStore.getState();
    state.addPersistentGroup('X/A');
    state.addPersistentGroup('X/A/B');
    // Mirrors the bookshelf move: rewrite names, then re-add them.
    const { relabeled, changed } = relabelPersistentGroups(
      useLibraryStore.getState().persistentGroupNames,
      'X/A',
      undefined, // hoist to top level
    );
    expect(changed).toBe(true);
    useLibraryStore.getState().removePersistentGroups([...relabeled.keys()]);
    for (const next of relabeled.values()) {
      useLibraryStore.getState().addPersistentGroup(next);
    }
    useLibraryStore.getState().refreshGroups();
    const names = useLibraryStore
      .getState()
      .getGroups()
      .map((g) => g.name);
    expect(names).not.toContain('X/A');
    expect(names).not.toContain('X/A/B');
    expect(names).toContain('A');
    expect(names).toContain('A/B');
  });

  it('reorders persisted empty groups (manual sort), swapping adjacent on unchanged drop', () => {
    const state = useLibraryStore.getState();
    state.addPersistentGroup('A'); // [A]
    state.addPersistentGroup('B'); // [A,B]
    state.addPersistentGroup('C'); // [A,B,C]
    const names = () => useLibraryStore.getState().persistentGroupNames;

    // A sits right before B: dropping A onto B swaps them -> [B,A,C].
    expect(useLibraryStore.getState().reorderPersistentGroup('A', 'B', true)).toBe(true);
    expect(names()).toEqual(['B', 'A', 'C']);
    // Move A just after C: [B,A,C] -> [B,C,A].
    expect(useLibraryStore.getState().reorderPersistentGroup('A', 'C', false)).toBe(true);
    expect(names()).toEqual(['B', 'C', 'A']);
    // Unknown names are a no-op.
    expect(useLibraryStore.getState().reorderPersistentGroup('Z', 'C', true)).toBe(false);
  });
});

describe('updateBook group refresh（B-3）', () => {
  it('删除组内最后一本书后空组立即消失', async () => {
    const saveLibraryBooks = vi.fn().mockResolvedValue(undefined);
    const envConfig = {
      getAppService: vi.fn().mockResolvedValue({ saveLibraryBooks }),
    } as unknown as EnvConfigType;

    const holder = (hash: string, groupName: string): Book =>
      ({
        hash,
        format: 'EPUB',
        title: hash,
        groupName,
        groupId: groupName,
        createdAt: 0,
        updatedAt: 0,
      }) as Book;
    const a = holder('a', '科幻');
    const b = holder('b', '武侠');
    useLibraryStore.setState({
      library: [a, b],
      hashIndex: new Map([
        ['a', 0],
        ['b', 1],
      ]),
      groups: { 科幻: '科幻', 武侠: '武侠' },
    });

    await useLibraryStore.getState().updateBook(envConfig, { ...a, deletedAt: Date.now() });

    const names = useLibraryStore
      .getState()
      .getGroups()
      .map((g) => g.name);
    expect(names).not.toContain('科幻');
    expect(names).toContain('武侠');
  });

  it('普通阅读进度更新不触发组重建', async () => {
    const saveLibraryBooks = vi.fn().mockResolvedValue(undefined);
    const envConfig = {
      getAppService: vi.fn().mockResolvedValue({ saveLibraryBooks }),
    } as unknown as EnvConfigType;

    const holder = (hash: string, groupName?: string): Book =>
      ({
        hash,
        format: 'EPUB',
        title: hash,
        groupName,
        groupId: groupName,
        createdAt: 0,
        updatedAt: 0,
      }) as Book;
    const a = holder('a', '科幻');
    useLibraryStore.setState({
      library: [a],
      hashIndex: new Map([['a', 0]]),
      groups: { 科幻: '科幻' },
    });
    const originalGroups = useLibraryStore.getState().groups;

    await useLibraryStore
      .getState()
      .updateBook(envConfig, { ...a, progress: [3, 100] as [number, number] });

    // 分组关系未变 → 组映射保持同一引用（未重建）
    expect(useLibraryStore.getState().groups).toBe(originalGroups);
  });
});
