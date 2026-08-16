import { beforeEach, describe, expect, it } from 'vitest';
import { loadShortcuts, ShortcutConfig } from '../../helpers/shortcuts';
import {
  buildShortcutFromKeyEvent,
  findConflictingActions,
  findKeyConflicts,
  normalizeShortcutKey,
} from '../../utils/shortcutRecorder';

const keyEvent = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', init);

describe('buildShortcutFromKeyEvent', () => {
  it('returns bare key on non-Mac', () => {
    expect(buildShortcutFromKeyEvent(keyEvent({ key: 's' }), false)).toBe('s');
  });

  it('maps ctrl modifier on non-Mac', () => {
    expect(buildShortcutFromKeyEvent(keyEvent({ key: 's', ctrlKey: true }), false)).toBe('ctrl+s');
  });

  it('maps alt modifier on non-Mac', () => {
    expect(buildShortcutFromKeyEvent(keyEvent({ key: 's', altKey: true }), false)).toBe('alt+s');
  });

  it('combines ctrl+shift on non-Mac', () => {
    expect(
      buildShortcutFromKeyEvent(keyEvent({ key: 'p', ctrlKey: true, shiftKey: true }), false),
    ).toBe('ctrl+shift+p');
  });

  it('ignores meta modifier on non-Mac', () => {
    expect(buildShortcutFromKeyEvent(keyEvent({ key: 'p', metaKey: true }), false)).toBe('p');
  });

  it('maps meta to cmd on Mac', () => {
    expect(buildShortcutFromKeyEvent(keyEvent({ key: 's', metaKey: true }), true)).toBe('cmd+s');
  });

  it('maps alt to opt on Mac', () => {
    expect(buildShortcutFromKeyEvent(keyEvent({ key: 's', altKey: true }), true)).toBe('opt+s');
  });

  it('ignores ctrl modifier on Mac', () => {
    expect(buildShortcutFromKeyEvent(keyEvent({ key: 's', ctrlKey: true }), true)).toBe('s');
  });

  it('combines cmd+shift on Mac', () => {
    expect(
      buildShortcutFromKeyEvent(keyEvent({ key: 's', metaKey: true, shiftKey: true }), true),
    ).toBe('cmd+shift+s');
  });

  it('keeps space as a single space key', () => {
    expect(buildShortcutFromKeyEvent(keyEvent({ key: ' ' }), false)).toBe(' ');
  });

  it('keeps arrow keys verbatim', () => {
    expect(buildShortcutFromKeyEvent(keyEvent({ key: 'ArrowLeft' }), false)).toBe('ArrowLeft');
    expect(buildShortcutFromKeyEvent(keyEvent({ key: 'ArrowRight', shiftKey: true }), false)).toBe(
      'shift+ArrowRight',
    );
  });

  it('keeps special keys verbatim', () => {
    expect(buildShortcutFromKeyEvent(keyEvent({ key: 'Enter' }), false)).toBe('Enter');
    expect(buildShortcutFromKeyEvent(keyEvent({ key: 'F11' }), false)).toBe('F11');
    expect(buildShortcutFromKeyEvent(keyEvent({ key: 'PageDown' }), false)).toBe('PageDown');
  });

  it('lowercases letter base keys even when shift yields uppercase', () => {
    // When shift is held, event.key is the uppercase letter.
    expect(buildShortcutFromKeyEvent(keyEvent({ key: 'S', shiftKey: true }), false)).toBe(
      'shift+s',
    );
  });

  it('returns null for bare modifier keys (keep waiting)', () => {
    expect(buildShortcutFromKeyEvent(keyEvent({ key: 'Control' }), false)).toBeNull();
    expect(buildShortcutFromKeyEvent(keyEvent({ key: 'Shift' }), false)).toBeNull();
    expect(buildShortcutFromKeyEvent(keyEvent({ key: 'Alt' }), false)).toBeNull();
    expect(buildShortcutFromKeyEvent(keyEvent({ key: 'Meta' }), false)).toBeNull();
    expect(buildShortcutFromKeyEvent(keyEvent({ key: 'Meta' }), true)).toBeNull();
  });
});

describe('normalizeShortcutKey', () => {
  it('treats opt and alt as equivalent', () => {
    expect(normalizeShortcutKey('opt+p')).toBe('alt+p');
    expect(normalizeShortcutKey('alt+p')).toBe('alt+p');
  });

  it('treats cmd and meta as equivalent', () => {
    expect(normalizeShortcutKey('cmd+f')).toBe('meta+f');
    expect(normalizeShortcutKey('meta+f')).toBe('meta+f');
  });

  it('lowercases everything for comparison', () => {
    expect(normalizeShortcutKey('shift+ArrowLeft')).toBe('shift+arrowleft');
  });

  it('leaves plain shortcuts unchanged', () => {
    expect(normalizeShortcutKey('ctrl+shift+p')).toBe('ctrl+shift+p');
  });
});

describe('findConflictingActions', () => {
  let shortcuts: ShortcutConfig;

  beforeEach(() => {
    localStorage.clear();
    shortcuts = loadShortcuts();
  });

  it('reports actions sharing a key', () => {
    const conflicts = findConflictingActions(shortcuts, 'onToggleSideBar', ['ctrl+f']);
    const descriptions = conflicts.map((c) => c.actionKey);
    expect(descriptions).toContain('onShowSearchBar');
    expect(descriptions).toContain('onSearchSelection');
  });

  it('excludes the action itself', () => {
    const conflicts = findConflictingActions(shortcuts, 'onShowSearchBar', ['s']);
    expect(conflicts.map((c) => c.actionKey)).toContain('onToggleSideBar');
    expect(conflicts.map((c) => c.actionKey)).not.toContain('onShowSearchBar');
  });

  it('detects cross-platform conflicts (opt vs alt)', () => {
    // onProofreadSelection binds alt+p.
    const conflicts = findConflictingActions(shortcuts, 'onToggleSideBar', ['opt+p']);
    expect(conflicts.map((c) => c.actionKey)).toContain('onProofreadSelection');
  });

  it('returns empty when no conflict', () => {
    expect(findConflictingActions(shortcuts, 'onToggleSideBar', ['x'])).toEqual([]);
  });

  it('checks every key in the new list', () => {
    const conflicts = findConflictingActions(shortcuts, 'onToggleSideBar', ['s', 'f']);
    expect(conflicts.map((c) => c.actionKey)).toContain('onShowSearchBar');
  });

  it('does not flag keys an action already owns as its own conflict', () => {
    // onToggleBookmark owns ctrl+b and no other action uses it.
    expect(findConflictingActions(shortcuts, 'onToggleBookmark', ['ctrl+b'])).toEqual([]);
  });
});

describe('findKeyConflicts', () => {
  let shortcuts: ShortcutConfig;

  beforeEach(() => {
    localStorage.clear();
    shortcuts = loadShortcuts();
  });

  it('reports another action sharing the key', () => {
    const conflicts = findKeyConflicts(shortcuts, 'onShowSearchBar', 'ctrl+f');
    expect(conflicts.map((c) => c.actionKey)).toContain('onSearchSelection');
  });

  it('excludes the action itself', () => {
    const conflicts = findKeyConflicts(shortcuts, 'onShowSearchBar', 'ctrl+f');
    expect(conflicts.map((c) => c.actionKey)).not.toContain('onShowSearchBar');
  });

  it('detects cross-platform aliases (opt vs alt)', () => {
    // onProofreadSelection binds alt+p.
    const conflicts = findKeyConflicts(shortcuts, 'onToggleSideBar', 'opt+p');
    expect(conflicts.map((c) => c.actionKey)).toContain('onProofreadSelection');
  });

  it('returns empty when the key is unique', () => {
    expect(findKeyConflicts(shortcuts, 'onToggleSideBar', 's')).toEqual([]);
  });

  it('returns empty when the key is unbound', () => {
    expect(findKeyConflicts(shortcuts, 'onToggleSideBar', 'x')).toEqual([]);
  });

  it('reports a conflict for a key the action itself does not own', () => {
    // shift+j is bound to both onToggleScrollMode and onGoNext.
    expect(findKeyConflicts(shortcuts, 'onGoNext', 'shift+j').map((c) => c.actionKey)).toContain(
      'onToggleScrollMode',
    );
  });
});
