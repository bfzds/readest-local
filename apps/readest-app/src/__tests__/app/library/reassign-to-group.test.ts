import { describe, expect, it } from 'vitest';

import { reassignToGroup, relabelPersistentGroups } from '@/app/library/utils/libraryUtils';
import { md5Fingerprint } from '@/utils/md5';
import type { Book } from '@/types/book';

const makeBook = (hash: string, groupName?: string): Book =>
  ({
    hash,
    format: 'EPUB',
    groupName,
    groupId: groupName ? md5Fingerprint(groupName) : undefined,
    updatedAt: 0,
  }) as Book;

describe('reassignToGroup — book into group', () => {
  it('moves the book into the target group', () => {
    const lib = [makeBook('a'), makeBook('b')];
    const { updated, changed } = reassignToGroup(lib, { kind: 'book', hash: 'a' }, '科幻');
    expect(changed).toBe(true);
    expect(updated[0]!.groupName).toBe('科幻');
    expect(updated[0]!.groupId).toBe(md5Fingerprint('科幻'));
    expect(updated[0]!.updatedAt).toBeGreaterThan(0);
    // Unaffected book keeps its reference (React memo friendly).
    expect(updated[1]).toBe(lib[1]);
  });

  it('is a no-op when the book is already in the target group', () => {
    const lib = [makeBook('a', '科幻')];
    const { updated, changed } = reassignToGroup(lib, { kind: 'book', hash: 'a' }, '科幻');
    expect(changed).toBe(false);
    expect(updated).toBe(lib);
  });

  it('is a no-op when the book hash is unknown', () => {
    const lib = [makeBook('a')];
    const { updated, changed } = reassignToGroup(lib, { kind: 'book', hash: 'zzz' }, '科幻');
    expect(changed).toBe(false);
    expect(updated).toBe(lib);
  });
});

describe('reassignToGroup — whole group into group (nesting)', () => {
  it('rewrites direct and nested members with the target prefix', () => {
    const lib = [
      makeBook('a', 'A'),
      makeBook('b', 'A/B'),
      makeBook('c', 'A/B/C'),
      makeBook('d', 'Other'),
    ];
    const { updated, changed } = reassignToGroup(lib, { kind: 'group', groupName: 'A' }, 'D');
    expect(changed).toBe(true);
    const byHash = new Map(updated.map((b) => [b.hash, b]));
    expect(byHash.get('a')?.groupName).toBe('D/A');
    expect(byHash.get('a')?.groupId).toBe(md5Fingerprint('D/A'));
    expect(byHash.get('b')?.groupName).toBe('D/A/B');
    expect(byHash.get('c')?.groupName).toBe('D/A/B/C');
    // Books outside the subtree are untouched (same reference).
    expect(byHash.get('d')).toBe(lib[3]);
  });

  it('rejects nesting a group into its own descendant (cycle)', () => {
    const lib = [makeBook('a', 'A'), makeBook('b', 'A/B')];
    const { updated, changed } = reassignToGroup(lib, { kind: 'group', groupName: 'A' }, 'A/B');
    expect(changed).toBe(false);
    expect(updated).toBe(lib);
  });

  it('rejects moving a group into itself', () => {
    const lib = [makeBook('a', 'A')];
    const { updated, changed } = reassignToGroup(lib, { kind: 'group', groupName: 'A' }, 'A');
    expect(changed).toBe(false);
    expect(updated).toBe(lib);
  });

  it('rejects moving a group into its own ancestor (no-op rename)', () => {
    const lib = [makeBook('a', 'A'), makeBook('b', 'A/B')];
    const { updated, changed } = reassignToGroup(lib, { kind: 'group', groupName: 'A/B' }, 'A');
    expect(changed).toBe(false);
    expect(updated).toBe(lib);
  });
});

describe('reassignToGroup — top level (breadcrumb "All")', () => {
  it('hoists a nested group to a top-level folder without unpacking it', () => {
    const lib = [
      makeBook('a', '帕乌克/被罚站的树的收藏'),
      makeBook('b', '帕乌克/被罚站的树的收藏/篇章'),
    ];
    const { updated, changed } = reassignToGroup(
      lib,
      { kind: 'group', groupName: '帕乌克/被罚站的树的收藏' },
      undefined,
    );
    expect(changed).toBe(true);
    const byHash = new Map(updated.map((b) => [b.hash, b]));
    expect(byHash.get('a')?.groupName).toBe('被罚站的树的收藏');
    expect(byHash.get('a')?.groupId).toBe(md5Fingerprint('被罚站的树的收藏'));
    expect(byHash.get('b')?.groupName).toBe('被罚站的树的收藏/篇章');
  });

  it('ungroups a book when moved to the top level', () => {
    const lib = [makeBook('a', '帕乌克/收藏')];
    const { updated, changed } = reassignToGroup(lib, { kind: 'book', hash: 'a' }, undefined);
    expect(changed).toBe(true);
    expect(updated[0]!.groupName).toBeUndefined();
    expect(updated[0]!.groupId).toBeUndefined();
  });

  it('is a no-op for a group already at the top level', () => {
    const lib = [makeBook('a', '顶层组')];
    const { updated, changed } = reassignToGroup(
      lib,
      { kind: 'group', groupName: '顶层组' },
      undefined,
    );
    expect(changed).toBe(false);
    expect(updated).toBe(lib);
  });
});

describe('relabelPersistentGroups — moving an empty group', () => {
  it('rewrites the source subtree when nested into a target group', () => {
    const names = ['A', 'A/B', 'C'];
    const { relabeled, changed } = relabelPersistentGroups(names, 'A', 'D');
    expect(changed).toBe(true);
    expect(relabeled.get('A')).toBe('D/A');
    expect(relabeled.get('A/B')).toBe('D/A/B');
    expect(relabeled.get('C')).toBeUndefined();
  });

  it('hoists a nested empty group to the top level when dropped on "All"', () => {
    const names = ['X/A', 'X/A/B', 'X'];
    const { relabeled, changed } = relabelPersistentGroups(names, 'X/A', undefined);
    expect(changed).toBe(true);
    expect(relabeled.get('X/A')).toBe('A');
    expect(relabeled.get('X/A/B')).toBe('A/B');
    expect(relabeled.get('X')).toBeUndefined();
  });

  it('is a no-op hoisting a top-level empty group', () => {
    const { relabeled, changed } = relabelPersistentGroups(['A', 'A/B'], 'A', undefined);
    expect(changed).toBe(false);
    expect(relabeled.size).toBe(0);
  });

  it('rejects moving into itself / its own descendant / its own ancestor', () => {
    expect(relabelPersistentGroups(['A', 'A/B'], 'A', 'A').changed).toBe(false);
    expect(relabelPersistentGroups(['A', 'A/B'], 'A', 'A/B').changed).toBe(false);
    expect(relabelPersistentGroups(['A', 'A/B'], 'A/B', 'A').changed).toBe(false);
  });

  it('leaves names outside the source subtree untouched in the result', () => {
    const { relabeled } = relabelPersistentGroups(['A', 'About', 'A/B'], 'A', 'D');
    expect(relabeled.has('About')).toBe(false);
    // Note: "A/B" names the source cascade; "About" shares the prefix but is not a member.
    expect(relabeled.get('A/B')).toBe('D/A/B');
  });

  it('reports changed=false when the source does not exist in the list', () => {
    const { changed } = relabelPersistentGroups(['C', 'C/D'], 'A', 'D');
    expect(changed).toBe(false);
  });
});
