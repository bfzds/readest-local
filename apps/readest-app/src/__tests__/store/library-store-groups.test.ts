import { describe, expect, it, beforeEach } from 'vitest';

import { useLibraryStore } from '@/store/libraryStore';
import { relabelPersistentGroups } from '@/app/library/utils/libraryUtils';

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
