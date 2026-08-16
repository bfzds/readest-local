import { ShortcutConfig } from '@/helpers/shortcuts';

// event.key values for modifier-only presses, where no base key is present yet.
const MODIFIER_EVENT_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

const toLowerBase = (key: string): string => {
  if (key === ' ') return ' ';
  if (key.length === 1 && /^[a-z0-9]$/i.test(key)) return key.toLowerCase();
  return key;
};

/**
 * Turn a keydown event into a shortcut string in the same format as
 * DEFAULT_SHORTCUTS (e.g. "ctrl+shift+p"). Modifiers follow the platform:
 * Mac binds cmd/opt and ignores ctrl, other platforms bind ctrl/alt and
 * ignore meta. Returns null while only a modifier is held, meaning the
 * recorder should keep waiting for the base key.
 */
export const buildShortcutFromKeyEvent = (event: KeyboardEvent, isMac: boolean): string | null => {
  if (MODIFIER_EVENT_KEYS.has(event.key)) return null;

  const modifiers: string[] = [];
  if (isMac) {
    if (event.metaKey) modifiers.push('cmd');
    if (event.altKey) modifiers.push('opt');
  } else {
    if (event.ctrlKey) modifiers.push('ctrl');
    if (event.altKey) modifiers.push('alt');
  }
  if (event.shiftKey) modifiers.push('shift');

  return [...modifiers, toLowerBase(event.key)].join('+');
};

/**
 * Canonical form for cross-platform conflict comparison. `opt`/`alt` and
 * `cmd`/`meta` are treated as equivalent (matching matchesShortcut), and
 * everything is lowercased.
 */
export const normalizeShortcutKey = (key: string): string =>
  key
    .toLowerCase()
    .split('+')
    .map((part) => (part === 'opt' ? 'alt' : part === 'cmd' ? 'meta' : part))
    .join('+');

/**
 * Actions other than `actionKey` that bind any of `newKeys`. Conflict is
 * judged on normalized keys so a platform variant (opt+p vs alt+p) is
 * caught even though the other action lives on the opposite platform.
 */
export const findConflictingActions = (
  shortcuts: ShortcutConfig,
  actionKey: string,
  newKeys: string[],
): { actionKey: string; description: string }[] => {
  const wanted = new Set(newKeys.map(normalizeShortcutKey));
  const conflicts: { actionKey: string; description: string }[] = [];
  for (const [name, entry] of Object.entries(shortcuts)) {
    if (name === actionKey) continue;
    const overlaps = entry.keys.map(normalizeShortcutKey).some((k) => wanted.has(k));
    if (overlaps) conflicts.push({ actionKey: name, description: entry.description });
  }
  return conflicts;
};

export interface ShortcutConflict {
  key: string;
  actionKey: string;
  description: string;
}

/**
 * Actions other than `actionKey` that bind the same normalized key. Used to
 * surface pre-existing shared bindings in the shortcuts panel (e.g. ctrl+f on
 * both search and search-selection), distinct from the record-time guard in
 * findConflictingActions.
 */
export const findKeyConflicts = (
  shortcuts: ShortcutConfig,
  actionKey: string,
  key: string,
): ShortcutConflict[] => {
  const normKey = normalizeShortcutKey(key);
  const conflicts: ShortcutConflict[] = [];
  for (const [name, entry] of Object.entries(shortcuts)) {
    if (name === actionKey) continue;
    if (entry.keys.some((k) => normalizeShortcutKey(k) === normKey)) {
      conflicts.push({ key: normKey, actionKey: name, description: entry.description });
    }
  }
  return conflicts;
};
