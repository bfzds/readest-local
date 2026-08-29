import { describe, expect, it, beforeEach } from 'vitest';

import { useLibraryStore } from '@/store/libraryStore';

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
});
